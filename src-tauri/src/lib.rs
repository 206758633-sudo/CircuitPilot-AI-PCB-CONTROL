use std::{
    fs::OpenOptions,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::Manager;

struct RuntimeProcess(Mutex<Option<Child>>);

fn runtime_is_ready() -> bool {
    let address: SocketAddr = "127.0.0.1:4178".parse().expect("valid runtime address");
    TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()
}

/// 先查常见安装位置，再退回 PATH 查找。nvm、Apple Silicon Homebrew、自定义前缀
/// 都不会把 node 放在 /usr/local/bin，只查固定路径会把正常环境误判为“未安装 Node”。
fn find_node() -> Option<PathBuf> {
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
            if !runtime_is_ready() {
                let resource_dir = app.path().resource_dir()?;
                let server = resource_dir.join("runtime/server.mjs");
                let node = find_node().ok_or("Node.js runtime not found in PATH or /usr/local/bin, /opt/homebrew/bin")?;
                if !server.is_file() {
                    return Err(format!("Bundled Runtime is missing: {}", server.display()).into());
                }
                // Runtime 的 stdout/stderr 之前被 Stdio::null 全部丢弃，Sidecar 启动失败时
                // 界面上只表现为“连不上 Runtime”，没有任何可诊断信息。改为追加写入日志文件。
                let log_dir = app.path().app_log_dir()?;
                std::fs::create_dir_all(&log_dir)?;
                let log_handle = OpenOptions::new().create(true).append(true).open(log_dir.join("runtime.log"))?;
                child = Some(Command::new(node)
                    .arg(&server)
                    .current_dir(&resource_dir)
                    .stdin(Stdio::null())
                    .stdout(Stdio::from(log_handle.try_clone()?))
                    .stderr(Stdio::from(log_handle))
                    .spawn()?);
            }
            app.manage(RuntimeProcess(Mutex::new(child)));
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
