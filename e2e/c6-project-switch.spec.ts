import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * C6 剩余验收：**真实运行时 + 真实界面**的两项目切换与数据隔离。
 *
 * 与 app.spec.ts 不同，这里不 mock Runtime：spec 自己拉起一个全新状态目录的
 * `runtime/server.mjs`（端口 4178，前端默认连接地址），通过真实 API 种两个项目，
 * 再在浏览器里点「设为当前」来回切换，最后用 API 读回两项目切面证明没有串数据。
 *
 * 边界：本 spec 不连接嘉立创EDA（不需要真机/写板批准），验证的是项目级状态隔离与
 * 切换链路；EDA 窗口↔项目绑定校验由 C6 的 `/api/projects/:id/binding/verify` 另行覆盖。
 */
const RUNTIME_PORT = 4178;
const RUNTIME_URL = `http://127.0.0.1:${RUNTIME_PORT}`;
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
let runtime: ChildProcess | null = null;
let token = '';
let preexistingRuntime = false;
const stateDir = mkdtempSync(join(tmpdir(), 'cp-c6-state-'));
const evidenceDir = mkdtempSync(join(tmpdir(), 'cp-c6-evidence-'));
const automationDir = mkdtempSync(join(tmpdir(), 'cp-c6-automation-'));
const releasesDir = mkdtempSync(join(tmpdir(), 'cp-c6-releases-'));

const PROJECT_A = { id: 'c6-proj-a', name: 'C6 项目甲', code: 'C6-A', description: '甲项目', stage: '概念', rootPath: '', edaProjectPath: '', archived: false, progress: 0, updatedAt: '2026-10-20T05:00:00.000Z' };
const PROJECT_B = { id: 'c6-proj-b', name: 'C6 项目乙', code: 'C6-B', description: '乙项目', stage: '概念', rootPath: '', edaProjectPath: '', archived: false, progress: 0, updatedAt: '2026-10-20T05:00:00.000Z' };
const REQ_A = { id: 'c6-req-a', projectId: PROJECT_A.id, category: '电源', name: '仅甲项目需求', value: '3.3', unit: 'V', kind: 'hard', status: 'confirmed', note: '甲', source: 'user' };
const REQ_B = { id: 'c6-req-b', projectId: PROJECT_B.id, category: '电源', name: '仅乙项目需求', value: '5', unit: 'V', kind: 'hard', status: 'confirmed', note: '乙', source: 'user' };

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
  throw new Error('C6：真实 Runtime 未在 30s 内起来');
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
  const health = await waitHealth();
  token = health.sessionProof;
  if (!token) throw new Error('C6：真实 Runtime 未发放会话令牌（HTTP token issuance 被关闭？）');
  // 聚合状态 + 两份项目切片：两个项目各有自己的需求，互不串。
  await api('/api/project-state', { method: 'PUT', body: JSON.stringify({ state: { projects: [PROJECT_A, PROJECT_B], activeProjectId: PROJECT_A.id, requirements: [REQ_A], components: [], assets: [] } }) });
  await api(`/api/projects/${PROJECT_A.id}/state`, { method: 'PUT', body: JSON.stringify({ state: { projects: [PROJECT_A], activeProjectId: PROJECT_A.id, requirements: [REQ_A], components: [], assets: [] } }) });
  await api(`/api/projects/${PROJECT_B.id}/state`, { method: 'PUT', body: JSON.stringify({ state: { projects: [PROJECT_B], activeProjectId: PROJECT_B.id, requirements: [REQ_B], components: [], assets: [] } }) });
});

test.afterAll(async () => {
  runtime?.kill('SIGTERM');
  runtime = null;
});

test('C6 真实运行时：界面两项目来回切换，需求工作集不串、落盘切面不串', async ({ page, request }) => {
  test.skip(preexistingRuntime, '4178 端口已有其它 Runtime（桌面版注入令牌实例），本用例需要独占端口自行拉起开发 Runtime');
  await page.goto('/#projects');
  await expect(page.getByText('C6 项目甲').first()).toBeVisible();
  await expect(page.getByText('C6 项目乙').first()).toBeVisible();
  // 项目甲是当前项目：它的需求应已在工作集里。
  await page.goto('/#design/req');
  await expect(page.getByText('仅甲项目需求').first()).toBeVisible();
  await expect(page.getByText('仅乙项目需求')).toHaveCount(0);

  // 切到项目乙（真实 dispatch + 真实 Runtime 切面加载）。
  await page.goto('/#projects');
  const rowB = page.locator('article.project-card', { hasText: 'C6 项目乙' });
  await rowB.getByRole('button', { name: '设为当前' }).click();
  await expect(rowB.getByRole('button', { name: '当前项目' })).toBeVisible();
  await page.goto('/#design/req');
  await expect(page.getByText('仅乙项目需求').first()).toBeVisible();
  await expect(page.getByText('仅甲项目需求')).toHaveCount(0);

  // 切回项目甲：甲的数据应恢复，乙的不出现。
  await page.goto('/#projects');
  const rowA = page.locator('article.project-card', { hasText: 'C6 项目甲' });
  await rowA.getByRole('button', { name: '设为当前' }).click();
  await expect(rowA.getByRole('button', { name: '当前项目' })).toBeVisible();
  await page.goto('/#design/req');
  await expect(page.getByText('仅甲项目需求').first()).toBeVisible();
  await expect(page.getByText('仅乙项目需求')).toHaveCount(0);

  // 服务端读回：两份项目切面各自只有自己的需求，没有交叉写入。
  const headers = { 'x-circuitpilot-token': token, origin: TRUSTED_ORIGIN };
  const sliceA = await (await request.get(`${RUNTIME_URL}/api/projects/${PROJECT_A.id}/state`, { headers })).json();
  const sliceB = await (await request.get(`${RUNTIME_URL}/api/projects/${PROJECT_B.id}/state`, { headers })).json();
  expect(sliceA.state.requirements.map((item: { id: string }) => item.id)).toEqual([REQ_A.id]);
  expect(sliceB.state.requirements.map((item: { id: string }) => item.id)).toEqual([REQ_B.id]);
  expect(sliceA.state.projects.map((item: { id: string }) => item.id)).toEqual([PROJECT_A.id]);
  expect(sliceB.state.projects.map((item: { id: string }) => item.id)).toEqual([PROJECT_B.id]);
});
