import { test, expect, type Page } from '@playwright/test';

const pages = [
  ['projects', '项目总览'],
  ['requirements', '需求约束'],
  ['assets', '资料与 BOM'],
  ['ai', 'AI 需求对话'],
  ['eda', 'EDA 控制'],
  ['validation', '验证中心'],
  ['versions', '版本、日志与问题'],
  ['settings', '系统设置'],
] as const;

async function openPage(page: Page, id: string, title: string) {
  await page.getByTestId(`nav-${id}`).click();
  await expect(page.locator('.page-head h1')).toHaveText(title);
  await expect(page).toHaveURL(new RegExp(`#${id}$`));
}

async function mockRuntimeHealth(page: Page) {
  await page.route('http://127.0.0.1:4178/api/health', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, service: 'circuitpilot-runtime', version: '0.6.1', sessionProof: 'e2e-session-proof' }) }));
}

test.beforeEach(async ({ page }) => {
  // 默认让 Runtime 整体不可达：否则用例结果会取决于开发者本机是否恰好开着真实
  // `npm run dev:runtime`。真实 Runtime 可达时应用会进入 REAL 会话，断言 DEMO 边界的
  // 用例就会偶发失败（实测同一份代码在 Runtime 开着时出现过 20/21）。
  // 需要真实会话的用例在下面之后注册自己的 fulfill 路由即可 —— Playwright 中
  // 后注册的路由优先匹配。
  await page.route('http://127.0.0.1:4178/api/**', (route) => route.abort());
  await page.route('http://127.0.0.1:4178/api/chat/status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { ready: true, provider: { id: 'codex_account', label: 'Codex账号', kind: 'cli', ready: true }, activeSessions: 0 } }) }));
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
});

test('八个主页面可导航、可恢复Hash并明确标注Demo边界', async ({ page }) => {
  for (const [id, title] of pages) {
    await openPage(page, id, title);
    // 界面上真实的文案是 “REAL READ ONLY”（空格），不是 “REAL READ-ONLY”。
    await expect(page.locator('.demo-flag')).toContainText(/DEMO MODE|REAL READ ONLY/);
    await expect(page.locator('.page-head')).toContainText('DEMO 数据');
  }
  await page.reload();
  await expect(page.locator('.page-head h1')).toHaveText('系统设置');
});

test('项目创建、切换与归档保护可工作', async ({ page }) => {
  await page.getByRole('button', { name: '新建项目' }).click();
  await page.getByLabel('项目名称 *').fill('E2E Sensor Board');
  await page.getByLabel('项目代号 *').fill('e2e-a01');
  await page.getByLabel('项目描述').fill('自动化交互验证项目');
  await page.getByRole('button', { name: '创建并设为当前' }).click();
  const card = page.locator('.project-card').filter({ hasText: 'E2E Sensor Board' });
  await expect(card.getByRole('heading', { name: 'E2E Sensor Board' })).toBeVisible();
  await expect(page.locator('.status-bus')).toContainText('E2E-A01');
  await expect(card.getByRole('button', { name: '当前项目' })).toBeDisabled();
  await expect(card.getByRole('button', { name: '归档' })).toBeEnabled();
});

test('项目可永久删除但不会声称删除本机或EDA文件', async ({ page }) => {
  const card = page.locator('.project-card').filter({ hasText: 'CAN 电机节点' });
  await card.getByRole('button', { name: '删除' }).click();
  await expect(page.getByRole('dialog', { name: '永久删除这个项目？' })).toContainText('不会删除你电脑上的工程目录');
  await page.getByRole('button', { name: '永久删除' }).click();
  await expect(card).toHaveCount(0);
});

test('真实AI聊天可发送、显示追问并由用户确认需求建议', async ({ page }) => {
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/chat/sessions/*/messages', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { sessionId: 'chat-default', threadActive: true, reply: '还需要确认最大输入电流。', questions: ['最大输入电流是多少？'], requirementSuggestions: [{ id: 'suggestion-e2e', action: 'add', targetRequirementId: null, category: '电源', name: '最大输入电流', value: '1', unit: 'A', kind: 'hard', blocking: true, note: '影响电源与线宽', status: 'pending' }], eda: { status: 'unavailable', reason: '没有已连接的EDA窗口', windowCount: 0 } } }) }));
  await openPage(page, 'ai', 'AI 需求对话');
  await page.getByLabel('发送给Codex的PCBA需求').fill('帮我检查还缺什么');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('还需要确认最大输入电流。')).toBeVisible();
  await expect(page.getByText('最大输入电流是多少？')).toBeVisible();
  await page.getByRole('button', { name: '接受并写入' }).click();
  await expect(page.getByText('已接受', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /9 项需求/ }).click();
  await expect(page.locator('.page-head h1')).toHaveText('需求约束');
  await expect(page.getByText('最大输入电流', { exact: true })).toBeVisible();
});

test('BOM可搜索嘉立创EDA器件库并人工确认绑定', async ({ page }) => {
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/eda/library/devices/search', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, search: { query: 'C190794', mode: 'lcsc', beta: true, readOnly: true, candidates: [{ name: 'nRF52840-QIAA', uuid: 'device-1', libraryUuid: 'system-lib', description: 'BLE MCU', symbol: { name: 'nRF52840', uuid: 'symbol-1', libraryUuid: 'system-lib' }, footprint: { name: 'aQFN-73', uuid: 'footprint-1', libraryUuid: 'system-lib' }, model3D: { name: 'aQFN-73-3D', uuid: 'model-1', libraryUuid: 'system-lib' } }] } }) }));
  await openPage(page, 'assets', '资料与 BOM');
  await page.getByRole('tab', { name: /BOM 清单/ }).click();
  const row = page.getByRole('row').filter({ hasText: 'nRF52840-QIAA' });
  await row.getByRole('button', { name: '嘉立创EDA搜索' }).click();
  await page.getByRole('button', { name: '搜索器件库' }).click();
  await expect(page.getByRole('dialog', { name: '在嘉立创EDA搜索 · U1' }).getByText('aQFN-73', { exact: true })).toBeVisible();
  await expect(page.locator('.library-result__evidence')).toContainText('nRF52840');
  await page.getByRole('button', { name: '确认绑定' }).click();
  await expect(row.getByText('已绑定')).toBeVisible();
});

test('AI可生成BOM草案并在人工确认后写入当前项目', async ({ page }) => {
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/chat/sessions/*/messages', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { sessionId: 'chat-bom', threadActive: true, reply: '已根据当前需求生成BOM草案。', questions: [], requirementSuggestions: [], bomDraft: { id: 'draft-e2e', status: 'draft', title: '传感器控制板BOM', summary: '1行可审核草案', blockingQuestions: [], assumptions: ['颜色待确认'], items: [{ id: 'draft-row-1', refdes: 'U99', qty: 1, value: 'MCU', mpn: 'STM32G0', manufacturer: 'ST', package: 'LQFP-48', lcscId: 'C12345', status: 'ready', risk: '', evidence: ['已确认MCU需求'], confidence: 'high', candidates: [{ name: 'STM32G0 candidate', uuid: 'dev-99', libraryUuid: 'lib-99' }] }], appliedAt: null }, eda: { status: 'unavailable', reason: '无窗口', windowCount: 0 } } }) }));
  await openPage(page, 'ai', 'AI 需求对话');
  await page.getByLabel('发送给Codex的PCBA需求').fill('根据需求建立BOM');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('region', { name: '传感器控制板BOM' })).toContainText('U99');
  await page.getByRole('button', { name: '确认写入当前项目BOM' }).click();
  await page.getByRole('button', { name: '确认写入BOM' }).click();
  await expect(page.getByRole('region', { name: '传感器控制板BOM' })).toContainText('已写入BOM');
  await openPage(page, 'assets', '资料与 BOM');
  await page.getByRole('tab', { name: /BOM 清单/ }).click();
  await expect(page.getByRole('row').filter({ hasText: 'U99' })).toContainText('STM32G0');
});

test('AI对话按项目隔离并在切换后恢复', async ({ page }) => {
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/chat/sessions/*/messages', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { threadActive: true, reply: '这是Mira项目记忆。', questions: [], requirementSuggestions: [], eda: { status: 'unavailable', reason: '无窗口', windowCount: 0 } } }) }));
  await openPage(page, 'ai', 'AI 需求对话');
  await page.getByLabel('发送给Codex的PCBA需求').fill('记住Mira上下文');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('这是Mira项目记忆。')).toBeVisible();
  await page.getByLabel('选择AI对话项目').selectOption('motor-node');
  await expect(page.getByRole('heading', { name: '先告诉我你准备设计什么板' })).toBeVisible();
  await page.getByLabel('选择AI对话项目').selectOption('mira-sense');
  await expect(page.getByText('这是Mira项目记忆。')).toBeVisible();
});

test('AI对话可上传图片和文本文件并随本轮发送', async ({ page }) => {
  let requestBody: any = null;
  // 每个非GET请求都会先校验 /api/health 取一次性会话令牌；不mock它，附件请求会在发出前失败。
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/chat/sessions/*/messages', async (route) => { requestBody = route.request().postDataJSON(); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { sessionId: 'chat-default', threadActive: true, reply: '已分析附件。', questions: [], requirementSuggestions: [], bomDraft: null, eda: { status: 'unavailable', reason: '未连接', windowCount: 0 } } }) }); });
  await openPage(page, 'ai', 'AI 需求对话');
  const chooser = page.getByLabel('选择AI对话附件');
  // 真实1×1 PNG：Runtime会校验文件签名（runtime/chat.mjs:23），截断的假PNG会被真实运行时拒绝。
  const realPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await chooser.setInputFiles([{ name: 'board.png', mimeType: 'image/png', buffer: realPng }, { name: 'bom.csv', mimeType: 'text/csv', buffer: Buffer.from('Ref,MPN\nU1,ABC') }]);
  await expect(page.getByText('board.png', { exact: true })).toBeVisible();
  await expect(page.getByText('bom.csv', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('已分析附件。')).toBeVisible();
  expect(requestBody.attachments).toHaveLength(2);
  expect(requestBody.attachments[0].kind).toBe('image');
  expect(requestBody.attachments[0].dataBase64).toMatch(/^iVBORw0KGgo/);
  expect(requestBody.attachments[1].text).toContain('U1,ABC');
});

test('AI聊天失败后可重试，并可确认新建会话', async ({ page }) => {
  await mockRuntimeHealth(page);
  let attempts = 0;
  await page.route('http://127.0.0.1:4178/api/chat/sessions/*/messages', (route) => {
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'CODEX_TIMEOUT', message: 'Codex回答超时' } }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { sessionId: 'chat-default', threadActive: true, reply: '重试成功。', questions: [], requirementSuggestions: [], eda: { status: 'unavailable', reason: '无窗口', windowCount: 0 } } }) });
  });
  await page.route('http://127.0.0.1:4178/api/chat/sessions/*', (route) => route.request().method() === 'DELETE' ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { reset: true } }) }) : route.continue());
  await openPage(page, 'ai', 'AI 需求对话');
  await page.getByLabel('发送给Codex的PCBA需求').fill('检查接口');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-error').getByText('Codex回答超时')).toBeVisible();
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('重试成功。')).toBeVisible();
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByRole('button', { name: '新建对话' }).last().click();
  await expect(page.getByRole('heading', { name: '先告诉我你准备设计什么板' })).toBeVisible();
});

test('EDA诊断、只读命令和写权限阻断均写入控制台', async ({ page }) => {
  await openPage(page, 'eda', 'EDA 控制');
  await page.getByRole('button', { name: /高级控制/ }).click();
  await page.getByRole('button', { name: '运行全量检查' }).click();
  await expect(page.getByRole('button', { name: '运行全量检查' })).toBeEnabled({ timeout: 8_000 });
  const readCard = page.locator('.command-card').filter({ hasText: 'eda.connection.health' });
  await readCard.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.console')).toContainText('eda.connection.health');
  const writeCard = page.locator('.command-card').filter({ hasText: 'eda.schematic.controlledWrite' });
  await writeCard.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.console')).toContainText('BLOCKED: 写命令不能从命令卡直接运行');
});

test('简单控制板流程会阻止缺失器件信息，并可完成绑定批准与审计展示', async ({ page }) => {
  const completePlan = { title: 'E2E简单板', blocks: Object.fromEntries(['mcu', 'power', 'led', 'button'].map((id) => [id, { libraryUuid: `lib-${id}`, uuid: `dev-${id}`, value: id }])), nets: ['3V3', 'GND'], placements: [], operations: [{ type: 'component.create', args: { component: { libraryUuid: 'lib-mcu', uuid: 'dev-mcu' }, x: 10, y: 20 } }], assumptions: [] };
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/design/context', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, context: { apiVersion: 1, windowId: 'W1', capturedAt: new Date().toISOString(), targetFingerprint: 'abcdef1234567890', sourceDigest: 'source123', project: {}, document: {}, catalog: {}, components: {}, wires: [] } }) }));
  await page.route('http://127.0.0.1:4178/api/design/plan', async (route) => { const request = route.request().postDataJSON(); const ready = Boolean(request.plan?.blocks?.mcu?.libraryUuid); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, planning: { plan: request.plan, ready, missing: ready ? [] : ['mcu:libraryUuid'], planHash: ready ? 'planhash-complete' : 'planhash-blocked' } }) }); });
  await page.route('http://127.0.0.1:4178/api/design/approve', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, approval: { token: 'one-time-token', planHash: 'planhash-complete', targetFingerprint: 'abcdef1234567890', windowId: 'W1', steps: ['snapshot', 'write', 'save', 'readback', 'drc', 'rollback'], expiresAt: Date.now() + 300000, used: false } }) }));
  await openPage(page, 'eda', 'EDA 控制');
  await page.getByRole('button', { name: /高级控制/ }).click();
  const netlistPanel = page.locator('.panel').filter({ hasText: '项目网络表 → 原理图受控执行' });
  // 读取当前原理图 → GET /api/design/context：为审批绑定真实目标窗口与指纹
  await page.getByRole('button', { name: '读取当前原理图', exact: true }).click();
  await expect(netlistPanel).toContainText('abcdef123456');
  // 未补全的默认计划 → POST /api/design/plan：被阻断，缺失字段由产品明确给出
  await netlistPanel.getByRole('button', { name: '3. 校验计划', exact: true }).click();
  await expect(page.locator('.toast').filter({ hasText: 'mcu:libraryUuid' })).toBeVisible();
  await expect(netlistPanel).toContainText('缺少 1 项');
  await expect(page.getByRole('button', { name: '4. 人工批准', exact: true })).toBeDisabled();
  // 补全后 → POST /api/design/plan 通过，人工批准开放 → POST /api/design/approve 后执行开放
  await page.getByLabel('结构化设计计划').fill(JSON.stringify(completePlan));
  await netlistPanel.getByRole('button', { name: '3. 校验计划', exact: true }).click();
  await expect(netlistPanel.locator('.permission-matrix div').filter({ hasText: /^计划门禁/ })).toContainText('可批准');
  await expect(page.getByRole('button', { name: '4. 人工批准', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '4. 人工批准', exact: true }).click();
  await expect(page.getByRole('button', { name: '5. 生成原理图', exact: true })).toBeEnabled();
});

test('PCB生产流程可读取真实目标、编译、校验、批准并展示执行回读', async ({ page }) => {
  const pcbPlan = { title: 'E2E PCB', board: { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 }, constraints: {}, operations: [{ type: 'pcb.save', args: {} }, { type: 'pcb.drc', args: {} }] };
  // 编译/校验/批准/执行都是POST：必须先mock /api/health，否则请求在取会话令牌时就以RUNTIME_UNREACHABLE中止。
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/pcb/context', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, context: { apiVersion: 1, windowId: 'W-PCB', capturedAt: new Date().toISOString(), targetFingerprint: 'pcb-target-abcdef', sourceDigest: 'source-pcb', complete: true, project: {}, pcb: { document: {}, components: [{ id: 'U1' }], lines: [], vias: [], pours: [], readErrors: [] }, rules: {} } }) }));
  await page.route('http://127.0.0.1:4178/api/pcb/fixtures/ch32v003/compile', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, planning: { plan: pcbPlan, ready: true, missing: [], planHash: 'pcb-plan-hash' } }) }));
  await page.route('http://127.0.0.1:4178/api/pcb/plan', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, planning: { plan: pcbPlan, ready: true, missing: [], planHash: 'pcb-plan-hash' } }) }));
  await page.route('http://127.0.0.1:4178/api/pcb/approve', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, approval: { token: 'pcb-token', planHash: 'pcb-plan-hash', targetFingerprint: 'pcb-target-abcdef', windowId: 'W-PCB', steps: ['save', 'drc', 'rollback'], expiresAt: Date.now() + 300000, used: false } }) }));
  await page.route('http://127.0.0.1:4178/api/pcb/execute', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, execution: { id: 'PCB-E1', state: 'completed', planHash: 'pcb-plan-hash', targetFingerprint: 'pcb-target-abcdef', events: [{ at: new Date().toISOString(), stage: 'readback', status: 'passed', detail: { componentCount: 1 } }], snapshot: { digest: 'snap', size: 100 }, readback: { sourceDigest: 'after', targetFingerprint: 'after-target', componentCount: 1, lineCount: 4, viaCount: 0, pourCount: 0 }, drc: { passed: true, findings: [] } } }) }));
  await openPage(page, 'eda', 'EDA 控制');
  await page.getByRole('button', { name: /高级控制/ }).click();
  await page.getByRole('button', { name: '1. 读取真实PCB' }).click();
  await page.getByRole('button', { name: '2. 编译CH32V003计划' }).click();
  await page.getByRole('button', { name: '3. 校验PCB计划' }).click();
  await expect(page.getByRole('button', { name: '4. 人工批准PCB' })).toBeEnabled();
  await page.getByRole('button', { name: '4. 人工批准PCB' }).click();
  await expect(page.getByRole('button', { name: '5. 执行PCB写入' })).toBeEnabled();
  await page.getByRole('button', { name: '5. 执行PCB写入' }).click();
  const pcbPanel = page.locator('.panel').filter({ hasText: 'PCB真实读取、审批与执行' });
  await expect(pcbPanel.getByText('官方PCB DRC').locator('..')).toContainText('通过');
  await expect(page.getByText('PCB EXECUTION AUDIT')).toBeVisible();
});

test('EDA默认是对话驱动工作台并可读取当前设计的PCB预览', async ({ page }) => {
  let pcbContextReads = 0;
  // 读取PCB是GET，但Runtime所有路由（除/api/health）都要求会话令牌，因此仍需mock健康握手。
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/pcb/context', (route) => { pcbContextReads += 1; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, context: { apiVersion: 1, windowId: 'W-PREVIEW', capturedAt: new Date().toISOString(), targetFingerprint: 'preview-target', sourceDigest: 'preview-source', complete: true, project: {}, pcb: { document: {}, components: [{ id: 'u1', ref: 'U1', x: 120, y: 90 }], lines: [{ id: 'l1', startX: 120, startY: 90, endX: 260, endY: 150 }], vias: [{ id: 'v1' }], pours: [], readErrors: [] }, rules: {} } }) }); });
  await openPage(page, 'eda', 'EDA 控制');
  // 默认视图就是对话驱动工作台，而不是高级命令面板
  await expect(page.getByRole('region', { name: 'AI PCB设计工作台' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI 直接协助当前项目设计' })).toBeVisible();
  await expect(page.getByLabel('PCB设计指令')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建EDA文件', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '绑定当前EDA设计', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '读取当前PCB', exact: true })).toBeVisible();
  // 未绑定EDA文件时，对话门禁停在第一步“绑定当前EDA设计”
  await expect(page.getByRole('button', { name: '1. 绑定当前EDA设计', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '运行全量检查', exact: true })).toBeHidden();
  // 触发预览 → GET /api/pcb/context，指标来自真实回读的PCB上下文
  await page.getByRole('button', { name: '读取当前PCB', exact: true }).click();
  await expect(page.locator('.eda-preview__bar')).toContainText('上次读取证据');
  await expect(page.locator('.eda-preview__metrics')).toContainText('元件 1');
  expect(pcbContextReads).toBeGreaterThan(0);
});

test('验证问题可记录有原因的人工豁免', async ({ page }) => {
  await openPage(page, 'validation', '验证中心');
  await page.locator('.finding-row').filter({ hasText: '电源输入未标记PWR_FLAG' }).getByRole('button', { name: '处理' }).click();
  await page.getByRole('button', { name: '申请豁免' }).click();
  await expect(page.getByRole('button', { name: '确认豁免并留痕' })).toBeDisabled();
  await page.getByLabel('豁免原因 *').fill('仅限Rev.A功能样机，Rev.B补充PWR_FLAG并复核。');
  await page.getByRole('button', { name: '确认豁免并留痕' }).click();
  await expect(page.getByText('已豁免', { exact: true }).first()).toBeVisible();
});

test('三阶段工程样板通过真实Runtime接口展示不可变报告和审批边界', async ({ page }) => {
  await page.route('http://127.0.0.1:4178/api/health', (route) => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,service:'circuitpilot-runtime',version:'0.6.0',sessionProof:'e2e-session-proof'})}));
  await page.route('http://127.0.0.1:4178/api/engineering/analyze', (route) => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,analysis:{schemaVersion:1,kind:'advanced-pcb-engineering-report',passed:true,reportHash:'a'.repeat(64),findings:[],operations:[{type:'pcb.line.create',stage:'routing',args:{}}],highSpeed:[{passed:true,findings:[],metrics:{},provenance:{}}],hdi:{viaCapabilities:{ready:true,findings:[]},transitions:[],bga:[]},rf:[],layout:{passed:true,findings:[],placements:[],deterministic:true},silkscreen:{passed:true,findings:[],labels:[]},simulationJobs:[],humanReviewRequired:true,officialDrcRequired:true,onlineDfmRequired:true}})}));
  await openPage(page,'validation','验证中心'); await page.getByRole('button',{name:/阶段1 · 高速数字/}).click();
  await expect(page.getByText('不可变工程报告')).toBeVisible(); await expect(page.getByText('解析门禁通过',{exact:true})).toBeVisible(); await expect(page.getByText(/正式生产仍强制要求官方DRC/)).toBeVisible();
});

test('版本快照、比较和Demo回滚可以完整操作', async ({ page }) => {
  await openPage(page, 'versions', '版本、日志与问题');
  await page.getByRole('button', { name: '创建手动快照' }).click();
  await page.getByLabel('快照名称 *').fill('E2E快照');
  await page.getByRole('button', { name: '创建快照' }).click();
  const item = page.locator('.timeline-item').filter({ hasText: 'E2E快照' });
  await expect(item.getByRole('heading', { name: 'E2E快照' })).toBeVisible();
  await item.getByRole('button', { name: '回滚' }).click();
  await page.getByRole('button', { name: '确认模拟回滚' }).click();
  await expect(page.getByText('回滚至 E2E快照')).toBeVisible();
});

test('修改日志可查看差异，问题中心可记录处理说明并持久化', async ({ page }) => {
  await openPage(page, 'versions', '版本、日志与问题');
  await page.getByRole('tab', { name: /修改日志/ }).click();
  await expect(page.locator('.trace-list')).toContainText('读取当前原理图文档信息');
  await page.locator('.trace-list').getByRole('button', { name: '查看差异' }).first().click();
  await expect(page.getByText('修改前', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('tab', { name: /问题中心/ }).click();
  // 启动时未连接Runtime会额外登记一条RUNTIME_UNREACHABLE问题，必须显式定位到LIB-PKG-011这条
  const issueRow = page.locator('.trace-list article').filter({ hasText: 'LIB-PKG-011' });
  await issueRow.getByRole('button', { name: '处理' }).click();
  await page.getByRole('button', { name: '解决' }).click();
  await page.getByLabel('处理说明 *').fill('E2E确认封装与引脚兼容，复核通过。');
  await page.getByRole('button', { name: '确认更新' }).click();
  await page.reload();
  await page.getByRole('tab', { name: /问题中心/ }).click();
  await page.getByLabel('筛选问题状态').selectOption('resolved');
  await expect(page.locator('.trace-list')).toContainText('LIB-PKG-011');
});

test('设置可测试、保存并在刷新后恢复', async ({ page }) => {
  await openPage(page, 'settings', '系统设置');
  await page.getByLabel('Provider').selectOption({ label: 'Demo 本地模拟' });
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.locator('.provider-test')).toContainText('Demo 本地模拟');
  await page.getByRole('switch', { name: /全局暂停所有写入/ }).click();
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.reload();
  await expect(page.getByLabel('Provider')).toHaveValue('demo');
  await expect(page.getByRole('switch', { name: /全局暂停所有写入/ })).toHaveAttribute('aria-checked', 'true');
});

test('Codex官方登录识别已认证状态并自动更新Provider', async ({ page }) => {
  await page.route('http://127.0.0.1:4178/api/health',(route)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,service:'circuitpilot-runtime',version:'0.6.1',sessionProof:'e2e-login-session-proof'})}));
  await page.route('http://127.0.0.1:4178/api/diagnostics',(route)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,diagnostics:{checkedAt:new Date().toISOString(),macos:{status:'pass',detail:'macOS'},codex:{status:'pass',detail:'codex-cli 0.148.0'}}})}));
  let ready=false;
  await page.route('http://127.0.0.1:4178/api/providers',(route)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,providers:[{id:'codex_account',label:'Codex账号',kind:'cli',installed:true,authenticated:ready,ready,status:ready?'Logged in using ChatGPT':'Not logged in'}]})}));
  await page.route('http://127.0.0.1:4178/api/providers/codex_account/login',(route)=>{ready=true;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,login:{state:'already_authenticated',started:false,authenticated:true,status:'Logged in using ChatGPT'}})});});
  await openPage(page,'settings','系统设置'); await page.getByRole('button',{name:'刷新本机状态'}).click(); await page.getByLabel('Provider').selectOption('codex_account'); await page.getByRole('button',{name:'启动官方登录'}).click();
  await expect(page.locator('.provider-status')).toContainText('Logged in using ChatGPT'); await expect(page.getByText('READY',{exact:true})).toBeVisible();
});

test('所有主页面可见按钮都有名称，禁用按钮都有原因且不存在无处理器死按钮', async ({ page }) => {
  for (const [id, title] of pages) {
    await openPage(page, id, title);
    const result = await page.locator('button:visible').evaluateAll((buttons) => buttons.map((button) => ({
      name: (button.getAttribute('aria-label') || button.textContent || '').trim(),
      disabled: (button as HTMLButtonElement).disabled,
      title: button.getAttribute('title') || '',
      hasHandler: typeof (button as HTMLButtonElement).onclick === 'function',
    })));
    expect(result.filter((item) => !item.name), `${title} 存在无可访问名称按钮`).toEqual([]);
    expect(result.filter((item) => item.disabled && !item.title), `${title} 存在无原因禁用按钮`).toEqual([]);
    expect(result.filter((item) => !item.hasHandler), `${title} 存在无点击处理器按钮`).toEqual([]);
  }
});

test('1280×800工业工作台视觉基线与控制台错误检查', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  // 应用启动会握手/api/health并读取providers/diagnostics；mock模式下不stub它们会被浏览器记为连接失败错误。
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/providers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, providers: [] }) }));
  await page.route('http://127.0.0.1:4178/api/diagnostics', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, diagnostics: { checkedAt: new Date().toISOString() } }) }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPage(page, 'ai', 'AI 需求对话');
  await page.screenshot({ path: 'artifacts/circuitpilot-ai-1280x800.png', fullPage: true });
  expect(errors).toEqual([]);
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.status-bus')).toBeVisible();
  await expect(page.locator('.page-content')).toBeVisible();
});
