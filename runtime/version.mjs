// 版本号的唯一数据源。
//
// 修复前同一个项目里存在四个互相不一致的版本声明：
//   package.json 0.1.0 · src-tauri/tauri.conf.json 0.2.0 · src-tauri/Cargo.toml 0.2.0
//   · runtime/server.mjs 里硬编码的 '0.6.1'（会通过 /api/health 暴露给前端和用户）
// runtime/__tests__/version.test.mjs 会强制校验这几个位置与这里保持一致。
export const RUNTIME_VERSION = '0.2.0';
