/**
 * 跨平台适配层：只集中处理 OS 差异，不把平台判断散落到业务代码里。
 *
 * 边界：
 * - 本模块不判断"AI 设计能力是否等价"；它只负责路径、进程启动、EDA 可执行文件定位。
 * - 任何无法确认的路径都返回候选并交给调用方 existsSync 校验，绝不假装已安装。
 * - 真实 EDA/Bridge 仍需在对应系统上做真机验收；单测只验证纯函数行为。
 */
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const SUPPORTED_PLATFORMS = Object.freeze(['darwin', 'win32', 'linux']);

export function platformId(platform = process.platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

export function isSupportedPlatform(platform = process.platform) {
  return SUPPORTED_PLATFORMS.includes(platform);
}

/**
 * 用户级应用数据目录。这里只用于需要跨平台持久化的少量运行时文件
 * （agent token、job journal 等）；业务 stateDir 仍由 CIRCUITPILOT_STATE_DIR 控制。
 */
export function appDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const configured = typeof env?.CIRCUITPILOT_APP_DATA_DIR === 'string' ? env.CIRCUITPILOT_APP_DATA_DIR.trim() : '';
  if (configured) return configured;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'CircuitPilot');
  if (platform === 'win32') {
    const base = typeof env?.APPDATA === 'string' && env.APPDATA.trim()
      ? env.APPDATA.trim()
      : path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'CircuitPilot');
  }
  const base = typeof env?.XDG_STATE_HOME === 'string' && env.XDG_STATE_HOME.trim()
    ? env.XDG_STATE_HOME.trim()
    : path.join(home, '.local', 'state');
  return path.join(base, 'circuitpilot');
}

/** EDA 专业版安装候选：优先显式环境变量；其余只是候选，必须再由 existsSync 校验。 */
export function edaAppCandidates({ platform = process.platform, env = process.env } = {}) {
  const explicit = typeof env?.CIRCUITPILOT_EDA_APP_PATH === 'string' ? env.CIRCUITPILOT_EDA_APP_PATH.trim() : '';
  if (explicit) return [explicit];
  if (platform === 'darwin') {
    return [
      '/Applications/嘉立创EDA(专业版).app',
      '/Applications/嘉立创EDA专业版.app',
      '/Applications/EasyEDA Pro.app',
    ];
  }
  if (platform === 'win32') {
    const local = env?.LOCALAPPDATA || '';
    const programFiles = env?.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env?.['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(programFiles, '嘉立创EDA专业版', '嘉立创EDA专业版.exe'),
      path.join(programFiles, '嘉立创EDA(专业版)', '嘉立创EDA专业版.exe'),
      path.join(programFiles, 'EasyEDA Pro', 'EasyEDA Pro.exe'),
      path.join(programFilesX86, '嘉立创EDA专业版', '嘉立创EDA专业版.exe'),
      ...(local ? [path.join(local, 'Programs', '嘉立创EDA专业版', '嘉立创EDA专业版.exe')] : []),
    ];
  }
  if (platform === 'linux') {
    return [
      '/opt/嘉立创EDA专业版/嘉立创EDA专业版',
      '/opt/lceda-pro/lceda-pro',
      '/opt/easyeda-pro/easyeda-pro',
      '/usr/bin/lceda-pro',
      '/usr/bin/easyeda-pro',
      path.join(os.homedir(), 'Applications', '嘉立创EDA专业版.AppImage'),
    ];
  }
  return [];
}

/** 从安装目录/可执行文件解析出真正要 spawn 的二进制路径（不校验存在性）。 */
export function resolveEdaExecutable(appPath, { platform = process.platform } = {}) {
  if (typeof appPath !== 'string' || !appPath.trim()) return null;
  if (platform === 'darwin') return path.join(appPath, 'Contents', 'MacOS', 'LCEDA-Pro');
  if (platform === 'win32') {
    if (/\.exe$/i.test(appPath)) return appPath;
    return path.join(appPath, '嘉立创EDA专业版.exe');
  }
  if (platform === 'linux') {
    if (/\.(AppImage|appimage)$/i.test(appPath)) return appPath;
    // /usr/bin/lceda-pro、/opt/easyeda-pro/easyeda-pro 是文件；
    // /opt/嘉立创EDA专业版 这类目录需继续拼二进制。
    const base = path.basename(appPath);
    if (['lceda-pro', 'easyeda-pro'].includes(base)) return appPath;
    return path.join(appPath, 'lceda-pro');
  }
  return null;
}

function spawnDetached(command, args, spawnImpl) {
  const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', shell: false });
  child.unref?.();
  return { pid: child.pid };
}

/** 打开 URL（Provider 登录/文档）。只启动系统默认浏览器，不经过任何 EDA 写链。 */
export function openExternalUrl(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const target = String(url || '');
  if (!target) throw Object.assign(new Error('URL 不能为空'), { code: 'OPEN_URL_INVALID' });
  if (platform === 'darwin') return spawnDetached('/usr/bin/open', [target], spawnImpl);
  if (platform === 'win32') return spawnDetached('cmd.exe', ['/c', 'start', '', target], spawnImpl);
  return spawnDetached('xdg-open', [target], spawnImpl);
}

/** 聚焦/启动已安装应用。macOS 用 open -a；Windows 用 cmd start；Linux 用 xdg-open。 */
export function openApplication(appPath, { platform = process.platform, spawnImpl = spawn } = {}) {
  const target = String(appPath || '');
  if (!target) throw Object.assign(new Error('应用路径不能为空'), { code: 'OPEN_APP_INVALID' });
  if (platform === 'darwin') return spawnDetached('/usr/bin/open', ['-a', target], spawnImpl);
  if (platform === 'win32') return spawnDetached('cmd.exe', ['/c', 'start', '', target], spawnImpl);
  return spawnDetached('xdg-open', [target], spawnImpl);
}

/** 平台编译产物名：Tauri externalBin 在 Windows 需要 .exe 后缀。 */
export function runtimeBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'node.exe' : 'node';
}
