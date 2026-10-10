import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

const DEFAULT_FRONTEND_PORT = 4177;

/**
 * `.auto-coding/` is gitignored local tooling state, so the allocated port file may be
 * missing or unparsable on a fresh checkout. Fall back to the default dev port instead
 * of crashing the whole run, while still honouring the file when it is valid.
 */
function readAllocatedFrontendPort(): number {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./.auto-coding/allocated-ports.json', import.meta.url), 'utf8')) as { frontend?: unknown };
    const port = Number(parsed?.frontend);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_FRONTEND_PORT;
  } catch {
    return DEFAULT_FRONTEND_PORT;
  }
}

function portFromBaseUrl(value: string | undefined): number | null {
  if (!value) return null;
  try {
    const port = Number(new URL(value).port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

const allocatedPort = readAllocatedFrontendPort();
const baseURL = process.env.BASE_URL || `http://127.0.0.1:${allocatedPort}`;
const devPort = portFromBaseUrl(process.env.BASE_URL) ?? allocatedPort;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --port ${devPort}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
