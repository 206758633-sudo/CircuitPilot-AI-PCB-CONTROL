import os from 'node:os';
import path from 'node:path';

export const RUNTIME_HOST = '127.0.0.1';
export const RUNTIME_PORT = Number.parseInt(process.env.CIRCUITPILOT_RUNTIME_PORT || '4178', 10);
export const BODY_LIMIT = 10 * 1024 * 1024;
export const PROCESS_TIMEOUT_MS = 8_000;
export const BRIDGE_PORTS = Array.from({ length: 10 }, (_, index) => 49620 + index);
export const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:4177',
  'http://localhost:4177',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://tauri.localhost',
  'tauri://localhost',
]);

export const CLI_CANDIDATES = {
  codex: [
    path.join(os.homedir(), '.npm-global/bin/codex'),
    // codex 官方安装器的默认落点（实测 0.161.0 装在这里）。缺这条时，用户明明装了 CLI
    // 也会被判成未在受支持路径中找到，白卡在 PROVIDER_UNAUTHENTICATED。
    path.join(os.homedir(), '.local/bin/codex'),
    path.join(os.homedir(), '.codex/packages/standalone/current/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ],
  claude: [
    path.join(os.homedir(), '.npm-global/bin/claude'),
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ],
};

export const EDA_APP_CANDIDATES = [
  '/Applications/嘉立创EDA(专业版).app',
  '/Applications/嘉立创EDA专业版.app',
  '/Applications/EasyEDA Pro.app',
];

// 每个 API Provider 一个独立钥匙串条目：撤销/轮换某个平台的 Key 不会影响其它平台。
// 新增平台时在这里补一行即可（与 providers.mjs 的 PROVIDERS 表一一对应）。
export const KEYCHAIN_SERVICES = {
  openai_api: 'com.circuitpilot.provider.openai',
  anthropic_api: 'com.circuitpilot.provider.anthropic',
  deepseek_api: 'com.circuitpilot.provider.deepseek',
  moonshot_api: 'com.circuitpilot.provider.moonshot',
  zhipu_api: 'com.circuitpilot.provider.zhipu',
  dashscope_api: 'com.circuitpilot.provider.dashscope',
  siliconflow_api: 'com.circuitpilot.provider.siliconflow',
  openrouter_api: 'com.circuitpilot.provider.openrouter',
  gemini_api: 'com.circuitpilot.provider.gemini',
  xai_api: 'com.circuitpilot.provider.xai',
  groq_api: 'com.circuitpilot.provider.groq',
  mistral_api: 'com.circuitpilot.provider.mistral',
  ark_api: 'com.circuitpilot.provider.ark',
  qianfan_api: 'com.circuitpilot.provider.qianfan',
  custom_api: 'com.circuitpilot.provider.custom',
};

export const KEYCHAIN_ACCOUNT = 'api-key';

/**
 * 自定义模型 Provider 的钥匙串服务名前缀。
 *
 * 用户可以在设置里创建任意多个自定义 Provider（acme-gateway、内部网关…），数量不固定，
 * 不能像内置平台那样在 KEYCHAIN_SERVICES 里逐条声明。这里按 id 派生独立服务名：
 * 每个自定义 Provider 一个钥匙串条目，撤销/轮换某个条目不会影响其它条目，
 * 也不会和内置平台（含内置 custom_api 的 com.circuitpilot.provider.custom）串味。
 */
export const CUSTOM_KEYCHAIN_PREFIX = 'com.circuitpilot.provider.custom';

export const customKeychainService = (id) => `${CUSTOM_KEYCHAIN_PREFIX}.${id}`;
