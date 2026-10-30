use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct RuntimeProcess(Mutex<Option<Child>>);

/// 单个 runtime.log 的上限。Runtime 会持续追加日志，必须有上限：
/// 修复前本机那份日志已经长到 61 MB 且没有任何轮转。
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

fn runtime_is_ready() -> bool {
    let address: SocketAddr = "127.0.0.1:4178".parse().expect("valid runtime address");
    TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()
}

/// 打开 sidecar 的 stdout/stderr 汇聚文件（超过上限就先轮转一次）。
///
/// 关键：日志是可诊断性增强，不是启动前提。任何一步失败都必须返回 None，
/// 由调用方退化为 Stdio::null()，绝不能因为“写不了日志”就让应用起不来。
/// （此前写成 `app.path().app_log_dir()?` + `open(...)?`，在无法写入日志目录的环境下
/// 会让 setup 直接失败并 panic，等于把日志变成了硬依赖。）
fn open_log_sinks(dir: &Path) -> Option<(Stdio, Stdio)> {
    std::fs::create_dir_all(dir).ok()?;
    let path = dir.join("runtime.log");
    if let Ok(metadata) = std::fs::metadata(&path) {
        if metadata.len() > MAX_LOG_BYTES {
            let _ = std::fs::rename(&path, dir.join("runtime.log.1"));
        }
    }
    let handle = OpenOptions::new().create(true).append(true).open(&path).ok()?;
    let clone = handle.try_clone().ok()?;
    Some((Stdio::from(clone), Stdio::from(handle)))
}

/// 日志目录：允许用 CIRCUITPILOT_LOG_DIR 覆盖（便于运维重定向与自动化验证），
/// 否则用系统应用日志目录。两者都不可用时返回 None 并退化为丢弃输出。
fn resolve_log_dir(app: &tauri::App) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CIRCUITPILOT_LOG_DIR") {
        return Some(PathBuf::from(dir));
    }
    app.path().app_log_dir().ok()
}

/// 业务状态目录：必须落在用户数据目录，不能落在 .app 包内。
///
/// 历史缺陷：打包版 sidecar 的 cwd 是 `Contents/Resources`，Runtime 默认把 state 写成
/// `Contents/Resources/artifacts/state`，导致 (a) 升级/重装即丢用户数据（自定义 Provider、
/// 项目状态、审批台账都在里面），(b) 应用被放到只读位置时写入直接失败（保存报 503）。
/// 允许 CIRCUITPILOT_STATE_DIR 覆盖（自动化/测试用），否则用系统应用数据目录。
fn resolve_state_dir(app: &tauri::App) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CIRCUITPILOT_STATE_DIR") {
        return Some(PathBuf::from(dir));
    }
    app.path().app_data_dir().ok().map(|dir| dir.join("state"))
}

/// 每次启动生成一次性会话令牌。
///
/// 令牌只通过两个不经由 HTTP 的通道交付：sidecar 的进程环境变量，
/// 以及 WebView 的 initialization_script。这样本机其它进程即使伪造 Origin
/// 也无法再从 /api/health 领到令牌（Runtime 在注入模式下不再通过 HTTP 发放）。
///
/// 返回值只含 [0-9a-f]，因此可以直接嵌进 JavaScript 字符串字面量而无需转义。
fn generate_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// 优先使用打包进应用的受控 Runtime（externalBin 会把它放到可执行文件同目录的 node），
/// 其次才回退到系统安装的 node —— 后者只用于开发或未打包含 sidecar 的构建。
fn find_runtime_binary() -> Option<PathBuf> {
    if let Ok(executable) = std::env::current_exe() {
        if let Some(dir) = executable.parent() {
            let bundled = dir.join("node");
            if bundled.is_file() {
                return Some(bundled);
            }
        }
    }
    let mut candidates: Vec<PathBuf> = ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"]
        .iter()
        .map(PathBuf::from)
        .collect();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("node")));
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let mut child = None;
            // 只有由本进程启动的 Runtime 才共享本进程生成的令牌。
            // 如果已经有一个外部 Runtime 在跑（例如开发者先执行了 npm run dev:runtime），
            // 它的令牌无法被我们得知，此时不注入令牌，交给前端走受信 Origin 的 HTTP 引导，
            // 从而不破坏开发流程。
            let mut injected_token: Option<String> = None;

            if !runtime_is_ready() {
                let resource_dir = app.path().resource_dir()?;
                let server = resource_dir.join("runtime/server.mjs");
                let node = find_runtime_binary().ok_or(
                    "未找到可用的 Node.js Runtime：打包版本应包含 sidecar，开发环境请安装 Node 或运行 npm run desktop:check",
                )?;
                if !server.is_file() {
                    return Err(format!("Bundled Runtime is missing: {}", server.display()).into());
                }
                // Runtime 的 stdout/stderr 之前被 Stdio::null 全部丢弃，Sidecar 启动失败时
                // 界面上只表现为“连不上 Runtime”，没有任何可诊断信息。改为追加写入日志文件；
                // 打不开就退化为丢弃输出，绝不因此阻止应用启动。
                let (log_out, log_err) = resolve_log_dir(app)
                    .as_deref()
                    .and_then(open_log_sinks)
                    .unwrap_or((Stdio::null(), Stdio::null()));
                let token = generate_token()?;
                // 令牌只经 stdin 管道交给 sidecar，不放进环境变量：macOS 上同一用户的其它进程
                // 可以用 `ps -E` 读到别人进程的环境变量，管道内容则读不到。
                // 同时设置 CIRCUITPILOT_TOKEN_STDIN=1，让 Runtime 在没收到令牌时 fail closed，
                // 而不是退化成“随机令牌 + HTTP 发放”。
                // 状态目录必须在用户数据目录：先建好（失败不阻塞启动，Runtime 会自行报明确错误）。
                let state_dir = resolve_state_dir(app);
                if let Some(dir) = state_dir.as_deref() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let mut command = Command::new(node);
                command.arg(&server).current_dir(&resource_dir);
                if let Some(dir) = state_dir.as_deref() {
                    command.env("CIRCUITPILOT_STATE_DIR", dir);
                    // 证据目录也放用户数据目录：避免装进 .app 后证据写进包内（升级/重装即丢，且可能只读）。
                    let evidence_dir = dir.join("evidence");
                    let _ = std::fs::create_dir_all(&evidence_dir);
                    command.env("CIRCUITPILOT_EVIDENCE_DIR", &evidence_dir);
                }
                let mut spawned = command
                    .env("CIRCUITPILOT_TOKEN_STDIN", "1")
                    .stdin(Stdio::piped())
                    .stdout(log_out)
                    .stderr(log_err)
                    .spawn()?;
                if let Some(mut sink) = spawned.stdin.take() {
                    if let Err(error) = sink.write_all(format!("{token}\n").as_bytes()).and_then(|_| sink.flush()) {
                        // 子进程读不到令牌会自行退出；这里只记录，不让整个应用起不来。
                        eprintln!("CircuitPilot: failed to pipe the Runtime token to the sidecar: {error}");
                    }
                    drop(sink);
                }
                child = Some(spawned);
                injected_token = Some(token);
            }
            app.manage(RuntimeProcess(Mutex::new(child)));

            // 窗口在 Rust 侧创建（配置文件中 windows 为空），唯一原因是需要在页面脚本执行前
            // 注入会话令牌：tauri.conf.json 没有对应的初始化脚本字段，
            // 而 WebviewWindowBuilder::initialization_script 可以在文档创建前执行。
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("CircuitPilot · AI PCB Control")
                .inner_size(1440.0, 920.0)
                .min_inner_size(1180.0, 720.0)
                .resizable(true);
            if let Some(token) = &injected_token {
                window = window.initialization_script(format!("window.__CIRCUITPILOT_RUNTIME_TOKEN__ = \"{token}\";"));
            }
            window.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building CircuitPilot");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<RuntimeProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(child) = guard.as_mut() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        }
    });
}
