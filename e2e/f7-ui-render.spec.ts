import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * F7 剩余：**界面渲染基线**（真实 Runtime + 真实浏览器 + 180 器件工程）。
 *
 * 边界（如实）：种子数据由真实 API 写入真实 Runtime，页面是真实渲染；但它不是
 * "真实 180 器件 EDA 工程的读取/布局/DRC 耗时"——那些需要真机 EDA 与本机稳定环境，
 * 本 spec 只覆盖前端渲染/导航这一半，并把结果落基线文件供后续回归对比。
 *
 * 产物：`artifacts/f7-perf/ui-render-<时间>.json` + 覆盖 `ui-render-baseline.json`。
 */
const RUNTIME_PORT = 4178;
const RUNTIME_URL = `http://127.0.0.1:${RUNTIME_PORT}`;
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const ARTIFACT_DIR = join(process.cwd(), 'artifacts', 'f7-perf');
const BASELINE_FILE = join(ARTIFACT_DIR, 'ui-render-baseline.json');
const COMPONENT_COUNT = 180;
const PAGE_BUDGET_MS = 10_000;
let runtime: ChildProcess | null = null;
let token = '';
let preexistingRuntime = false;
const stateDir = mkdtempSync(join(tmpdir(), 'cp-f7-state-'));
const evidenceDir = mkdtempSync(join(tmpdir(), 'cp-f7-evidence-'));
const automationDir = mkdtempSync(join(tmpdir(), 'cp-f7-automation-'));
const releasesDir = mkdtempSync(join(tmpdir(), 'cp-f7-releases-'));
const PROJECT = { id: 'f7-proj', name: 'F7 180器件工程', code: 'F7-180', description: '界面渲染基线', stage: '概念', rootPath: '', edaProjectPath: '', archived: false, progress: 0, updatedAt: '2026-10-20T05:00:00.000Z' };
const REQUIREMENT = { id: 'f7-req', projectId: PROJECT.id, category: '电源', name: 'F7 需求', value: '5', unit: 'V', kind: 'hard', status: 'confirmed', note: 'F7', source: 'user' };
const components = Array.from({ length: COMPONENT_COUNT }, (_, index) => ({
  id: `f7-cmp-${index}`,
  projectId: PROJECT.id,
  refdes: `U${index + 1}`,
  mpn: `MPN-F7-${index + 1}`,
  manufacturer: 'F7',
  package: '0402',
  lcscId: `C${100000 + index}`,
  qty: 1,
  status: 'approved',
  value: '10k',
}));

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${RUNTIME_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': token, ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} → ${response.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function waitHealth(timeoutMs = 30_000) {
  const begin = Date.now();
  while (Date.now() - begin < timeoutMs) {
    try {
      const response = await fetch(`${RUNTIME_URL}/api/health`, { headers: { origin: TRUSTED_ORIGIN } });
      if (response.ok) return response.json();
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('F7：真实 Runtime 未在 30s 内起来');
}

/** 端口上是否已有别的 Runtime（桌面版会注入令牌，本用例无法使用它，spawn 也会撞 EADDRINUSE）。 */
async function runtimeAlreadyListening(): Promise<boolean> {
  try {
    const response = await fetch(`${RUNTIME_URL}/api/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  // 端口已被占用（例如桌面版 Runtime 正在运行）时，spawn 会因 EADDRINUSE 失败，
  // waitHealth 读到的却是别人的注入令牌实例。标记后由用例跳过，不误报产品缺陷。
  if (await runtimeAlreadyListening()) { preexistingRuntime = true; return; }
  runtime = spawn(process.execPath, ['runtime/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CIRCUITPILOT_RUNTIME_PORT: String(RUNTIME_PORT),
      CIRCUITPILOT_STATE_DIR: stateDir,
      CIRCUITPILOT_EVIDENCE_DIR: evidenceDir,
      CIRCUITPILOT_AUTOMATION_DIR: automationDir,
      CIRCUITPILOT_RELEASES_DIR: releasesDir,
    },
    stdio: 'ignore',
  });
  token = (await waitHealth()).sessionProof;
  if (!token) throw new Error('F7：真实 Runtime 未发放会话令牌');
  const state = { projects: [PROJECT], activeProjectId: PROJECT.id, requirements: [REQUIREMENT], components, assets: [] };
  await api('/api/project-state', { method: 'PUT', body: JSON.stringify({ state }) });
  await api(`/api/projects/${PROJECT.id}/state`, { method: 'PUT', body: JSON.stringify({ state }) });
});

test.afterAll(async () => {
  runtime?.kill('SIGTERM');
  runtime = null;
});

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

test('F7 界面渲染基线：180 器件工程在真实运行时下渲染/导航可复现', async ({ page }) => {
  test.skip(preexistingRuntime, '4178 端口已有其它 Runtime（桌面版注入令牌实例），本用例需要独占端口自行拉起开发 Runtime');
  const pages = [
    { name: 'assets-180', route: '/#design/assets', readySelector: 'text=资料库与元件清单' },
    { name: 'requirements', route: '/#design/req', readySelector: 'text=F7 需求' },
    { name: 'validation', route: '/#validation', readySelector: 'h1:has-text("验证与交付")' },
  ];
  const results: Array<{ name: string; route: string; samplesMs: number[]; medianMs: number; ok: boolean }> = [];
  for (const item of pages) {
    const samples: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const started = Date.now();
      await page.goto(item.route, { waitUntil: 'load' });
      await expect(page.locator(item.readySelector).first()).toBeVisible({ timeout: PAGE_BUDGET_MS });
      samples.push(Date.now() - started);
    }
    const medianMs = median(samples);
    results.push({ name: item.name, route: item.route, samplesMs: samples, medianMs, ok: medianMs <= PAGE_BUDGET_MS });
  }

  // 180 行必须真的渲染出来（不是只加载了页面壳）：切到 BOM 清单页签再数行。
  await page.goto('/#design/assets');
  await page.getByRole('tab', { name: /BOM 清单/ }).click();
  await expect(page.getByText(`U${COMPONENT_COUNT}`).first()).toBeVisible({ timeout: PAGE_BUDGET_MS });
  const rendered = await page.locator('tbody tr').count();
  expect(rendered).toBeGreaterThanOrEqual(COMPONENT_COUNT);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const previous = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) : null;
  const regressions = previous
    ? results
        .map((item) => {
          const old = (previous.pages || []).find((pageItem: { name: string }) => pageItem.name === item.name);
          if (!old || !Number.isFinite(old.medianMs)) return null;
          if (item.medianMs > old.medianMs * 2 && item.medianMs > 300) return `${item.name}: ${old.medianMs}ms → ${item.medianMs}ms（超过 2×）`;
          return null;
        })
        .filter(Boolean)
    : [];
  const record = {
    ok: results.every((item) => item.ok) && rendered >= COMPONENT_COUNT,
    generatedAt: new Date().toISOString(),
    componentCount: COMPONENT_COUNT,
    renderedRows: rendered,
    pageBudgetMs: PAGE_BUDGET_MS,
    pages: results,
    previous: previous ? { generatedAt: previous.generatedAt, pages: previous.pages } : null,
    regressions,
    boundary: '真实 Runtime + 真实浏览器渲染 180 器件工程；不含真机 EDA 读取/布局/DRC 耗时（需真机环境），本基线只覆盖前端渲染与导航。',
    environment: { node: process.version, viewport: page.viewportSize(), headless: true },
  };
  writeFileSync(BASELINE_FILE, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  const artifact = join(ARTIFACT_DIR, `ui-render-${record.generatedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(artifact, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`[F7] ${record.ok ? 'PASS' : 'FAIL'} 180 器件 UI 渲染：${results.map((item) => `${item.name} median ${item.medianMs}ms`).join('；')}；行数 ${rendered}/${COMPONENT_COUNT}；回归告警 ${regressions.length} 条；证据 ${artifact}\n`);
  expect(record.ok).toBe(true);
});
