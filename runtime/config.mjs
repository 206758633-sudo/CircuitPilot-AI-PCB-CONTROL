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
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ],
  claude: [
    path.join(os.homedir(), '.npm-global/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ],
};

export const EDA_APP_CANDIDATES = [
  '/Applications/嘉立创EDA(专业版).app',
  '/Applications/嘉立创EDA专业版.app',
  '/Applications/EasyEDA Pro.app',
];

export const KEYCHAIN_SERVICES = {
  openai_api: 'com.circuitpilot.provider.openai',
  anthropic_api: 'com.circuitpilot.provider.anthropic',
};

export const KEYCHAIN_ACCOUNT = 'api-key';
