import { test, expect, type Page } from '@playwright/test';

const pages = [
  ['overview', '概览'],
  ['design', 'AI 设计'],
  ['eda', 'EDA 执行'],
  ['automation', '自动化'],
  ['validation', '验证与交付'],
  ['versions', '版本与问题'],
  ['settings', '系统设置'],
] as const;

async function openPage(page: Page, id: string, title: string) {
  await page.getByTestId(`nav-${id}`).click();
  await expect(page.locator('.page-head h1')).toHaveText(title);
  await expect(page).toHaveURL(new RegExp(`#${id}$`));
}

async function openDesignTab(page: Page, tab: 'chat' | 'req' | 'select' | 'assets') {
  await page.evaluate((next) => { window.location.hash = `design/${next}`; }, tab);
  await expect(page.locator('.page-head h1')).toHaveText('AI 设计');
}

async function openProjects(page: Page) {
  await page.evaluate(() => { window.location.hash = 'projects'; });
  await expect(page.locator('.page-head h1')).toHaveText('项目与工程资料');
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

test('六个主页面可导航、可恢复Hash并明确标注Demo边界', async ({ page }) => {
  for (const [id, title] of pages) {
    await openPage(page, id, title);
    // 界面上真实的文案是 “REAL READ ONLY”（空格），不是 “REAL READ-ONLY”。
    await expect(page.locator('.demo-flag')).toContainText(/DEMO MODE|REAL READ ONLY/);
    await expect(page.locator('.page-head')).toContainText('DEMO 数据');
  }
  await page.reload();
  await expect(page.locator('.page-head h1')).toHaveText('系统设置');

  // 回归守护：一级导航必须能直达「项目 / 需求约束 / 布局微调」。
  await page.getByTestId('nav-projects').click();
  await expect(page.locator('.page-head h1')).toHaveText('项目与工程资料');
  await expect(page.getByRole('button', { name: '新建项目' })).toBeVisible();

  await page.getByTestId('nav-requirements').click();
  await expect(page.locator('.page-head h1')).toHaveText('AI 设计');
  await expect(page.locator('.page-tabs button.is-active')).toHaveText(/需求约束/);

  await page.getByTestId('nav-placement').click();
  await expect(page.locator('.page-head h1')).toHaveText('验证与交付');
  await expect(page.locator('.page-tabs button.is-active')).toHaveText(/布局微调/);

  // 项目卡也应直达项目页（以前回概览，找不到新建项目）。
  await page.getByTestId('project-switch').click();
  await expect(page.locator('.page-head h1')).toHaveText('项目与工程资料');
});

test('项目创建、切换与归档保护可工作', async ({ page }) => {
  await openProjects(page);
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
  await openProjects(page);
  const card = page.locator('.project-card').filter({ hasText: 'CAN 电机节点' });
  await card.getByRole('button', { name: '删除' }).click();
  await expect(page.getByRole('dialog', { name: '永久删除这个项目？' })).toContainText('不会删除你电脑上的工程目录');
  await page.getByRole('button', { name: '永久删除' }).click();
  await expect(card).toHaveCount(0);
});

test('真实AI聊天可发送、显示追问并由用户确认需求建议', async ({ page }) => {
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/chat/sessions/*/messages', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { sessionId: 'chat-default', threadActive: true, reply: '还需要确认最大输入电流。', questions: ['最大输入电流是多少？'], requirementSuggestions: [{ id: 'suggestion-e2e', action: 'add', targetRequirementId: null, category: '电源', name: '最大输入电流', value: '1', unit: 'A', kind: 'hard', blocking: true, note: '影响电源与线宽', status: 'pending' }], eda: { status: 'unavailable', reason: '没有已连接的EDA窗口', windowCount: 0 } } }) }));
  await openDesignTab(page, 'chat');
  await page.getByLabel('发送给Codex的PCBA需求').fill('帮我检查还缺什么');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('还需要确认最大输入电流。')).toBeVisible();
  await expect(page.getByText('最大输入电流是多少？')).toBeVisible();
  await page.getByRole('button', { name: '接受并写入' }).click();
  await expect(page.getByText('已接受', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /9 项需求/ }).click();
  await expect(page.locator('.page-tabs button.is-active')).toHaveText(/需求约束/);
  await expect(page.getByText('最大输入电流', { exact: true })).toBeVisible();
});

test('BOM可搜索嘉立创EDA器件库并人工确认绑定', async ({ page }) => {
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/eda/library/devices/search', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, search: { query: 'C190794', mode: 'lcsc', beta: true, readOnly: true, candidates: [{ name: 'nRF52840-QIAA', uuid: 'device-1', libraryUuid: 'system-lib', description: 'BLE MCU', symbol: { name: 'nRF52840', uuid: 'symbol-1', libraryUuid: 'system-lib' }, footprint: { name: 'aQFN-73', uuid: 'footprint-1', libraryUuid: 'system-lib' }, model3D: { name: 'aQFN-73-3D', uuid: 'model-1', libraryUuid: 'system-lib' } }] } }) }));
  await openDesignTab(page, 'assets');
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
  await openDesignTab(page, 'chat');
  await page.getByLabel('发送给Codex的PCBA需求').fill('根据需求建立BOM');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('region', { name: '传感器控制板BOM' })).toContainText('U99');
  await page.getByRole('button', { name: '确认写入当前项目BOM' }).click();
  await page.getByRole('button', { name: '确认写入BOM' }).click();
  await expect(page.getByRole('region', { name: '传感器控制板BOM' })).toContainText('已写入BOM');
  await openDesignTab(page, 'assets');
  await page.getByRole('tab', { name: /BOM 清单/ }).click();
  await expect(page.getByRole('row').filter({ hasText: 'U99' })).toContainText('STM32G0');
});

test('AI对话按项目隔离并在切换后恢复', async ({ page }) => {
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/chat/sessions/*/messages', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { threadActive: true, reply: '这是Mira项目记忆。', questions: [], requirementSuggestions: [], eda: { status: 'unavailable', reason: '无窗口', windowCount: 0 } } }) }));
  await openDesignTab(page, 'chat');
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
  await openDesignTab(page, 'chat');
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
  await openDesignTab(page, 'chat');
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
  await openPage(page, 'eda', 'EDA 执行');
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
  await openPage(page, 'eda', 'EDA 执行');
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
  await openPage(page, 'eda', 'EDA 执行');
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
  await openPage(page, 'eda', 'EDA 执行');
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
  await openPage(page, 'validation', '验证与交付');
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
  await openPage(page,'validation','验证与交付'); await page.getByRole('button',{name:/阶段1 · 高速数字/}).click();
  await expect(page.getByText('不可变工程报告')).toBeVisible(); await expect(page.getByText('解析门禁通过',{exact:true})).toBeVisible(); await expect(page.getByText(/正式生产仍强制要求官方DRC/)).toBeVisible();
});

test('版本快照、比较和Demo回滚可以完整操作', async ({ page }) => {
  await openPage(page, 'versions', '版本与问题');
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
  await openPage(page, 'versions', '版本与问题');
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
  // 页面上还有「联网检索」的 .provider-test；这里只断言 Provider 测试结果那一块。
  await expect(page.locator('.provider-test').first()).toContainText('Demo 本地模拟');
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

test('第三方平台API登录口可按平台保存Key、显示独立凭据状态并给出申请入口', async ({ page }) => {
  await page.route('http://127.0.0.1:4178/api/health', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, service: 'circuitpilot-runtime', version: '0.6.1', sessionProof: 'e2e-provider-session-proof' }) }));
  await page.route('http://127.0.0.1:4178/api/diagnostics', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, diagnostics: { checkedAt: new Date().toISOString() } }) }));
  let configured = false;
  await page.route('http://127.0.0.1:4178/api/providers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, providers: [{ id: 'deepseek_api', label: 'DeepSeek 开放平台', kind: 'api', configured, ready: configured, keyUrl: 'https://platform.deepseek.com/api_keys' }] }) }));
  const stored: string[] = [];
  await page.route('http://127.0.0.1:4178/api/providers/deepseek_api/key', (route) => {
    stored.push(String(route.request().postDataJSON().key));
    configured = true;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, credential: { configured: true, hint: '••••1234' } }) });
  });
  const consoles: string[] = [];
  await page.route('http://127.0.0.1:4178/api/providers/deepseek_api/console', (route) => {
    consoles.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, console: { provider: 'deepseek_api', url: 'https://platform.deepseek.com/api_keys', opened: true } }) });
  });
  await openPage(page, 'settings', '系统设置');
  await page.getByRole('button', { name: '刷新本机状态' }).click();
  // Demo/账号型没有平台控制台入口。
  await expect(page.getByRole('button', { name: '去平台申请Key' })).toHaveCount(0);
  await page.getByLabel('Provider').selectOption('deepseek_api');
  // 打包后的桌面壳层不会为 target="_blank" 开新窗口，所以入口必须走本机 Runtime 调起系统浏览器。
  const keyButton = page.getByRole('button', { name: '去平台申请Key' });
  await expect(keyButton).toBeVisible();
  await keyButton.click();
  await expect.poll(() => consoles.length).toBe(1);
  await expect(page.locator('.toast').filter({ hasText: '的 Key 管理页' })).toBeVisible();
  await expect(page.locator('.provider-status')).toContainText('尚未配置');
  await page.locator('input[type="password"]').fill('sk-e2e-third-party-key-1234');
  await page.getByRole('button', { name: '安全保存' }).click();
  // toast 只渲染 message（title 不落 DOM），所以按提示正文断言。
  await expect(page.locator('.toast').filter({ hasText: '已写入macOS钥匙串' })).toBeVisible();
  expect(stored).toEqual(['sk-e2e-third-party-key-1234']);
  // Key 只经请求体送往本机Runtime，前端不保留明文（输入框清空且不落 LocalStorage）。
  await expect(page.locator('input[type="password"]')).toHaveValue('');
  const persisted = await page.evaluate(() => Object.values(localStorage).join('\n'));
  expect(persisted).not.toContain('sk-e2e-third-party-key-1234');
  await expect(page.locator('.provider-status')).toContainText('钥匙串中已配置');
  await expect(page.getByRole('button', { name: '撤销Key' })).toBeVisible();
});

test('切换到第三方平台时会把不属于该平台的模型回落为auto', async ({ page }) => {
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/providers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, providers: [] }) }));
  await page.route('http://127.0.0.1:4178/api/diagnostics', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, diagnostics: { checkedAt: new Date().toISOString() } }) }));
  await openPage(page, 'settings', '系统设置');
  await page.getByLabel('Provider').selectOption('openai_api');
  await page.getByRole('combobox', { name: /^模型/ }).fill('gpt-5.6-sol');
  await page.getByLabel('Provider').selectOption('deepseek_api');
  await expect(page.getByRole('combobox', { name: /^模型/ })).toHaveValue('auto');
  // 平台建议列表里已有的模型不会被重置。
  await page.getByRole('combobox', { name: /^模型/ }).fill('deepseek-reasoner');
  await page.getByLabel('Provider').selectOption('moonshot_api');
  await expect(page.getByRole('combobox', { name: /^模型/ })).toHaveValue('auto');
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
  // 应用启动会握手/api/health并读取providers/diagnostics；mock模式下不stub它们会被浏览器记为连接失败错误。
  // 先装好 mock 再挂 console 监听并重载：否则启动瞬间的轮询请求会先撞上 beforeEach 的 abort 路由，
  // 记下一条 net::ERR_FAILED（时序不同则时有时无，曾造成随机失败）。
  await mockRuntimeHealth(page);
  await page.route('http://127.0.0.1:4178/api/providers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, providers: [] }) }));
  await page.route('http://127.0.0.1:4178/api/diagnostics', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, diagnostics: { checkedAt: new Date().toISOString() } }) }));
  // 握手成功后应用会继续拉聚合状态。这三条若落到 beforeEach 的 abort 路由，会在控制台留下
  // net::ERR_FAILED；返回 503 同样会被 Chromium 记为 error。这里返回合法的空状态，
  // 让应用走"Runtime 上没有业务数据"的正常分支。
  await page.route('http://127.0.0.1:4178/api/project-state', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, savedAt: null, state: { projects: [], activeProjectId: '', requirements: [], components: [], assets: [] } }),
  }));
  await page.route('http://127.0.0.1:4178/api/trace-state', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, savedAt: null, state: { versions: [], changes: [], audit: [] } }),
  }));
  await page.route('http://127.0.0.1:4178/api/issue-state', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, savedAt: null, state: { issues: [] } }),
  }));
  page.on('pageerror', (error) => errors.push(error.message));
  // 带上 URL：否则失败信息只有 “Failed to load resource: net::ERR_FAILED”，
  // 无法判断是哪个请求挂了（曾因此把一个真实的门禁问题当成随机波动）。
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.text()} @ ${message.location()?.url || 'unknown'}`); });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await openDesignTab(page, 'chat');
  await page.screenshot({ path: 'artifacts/circuitpilot-ai-1280x800.png', fullPage: true });
  expect(errors).toEqual([]);
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.status-bus')).toBeVisible();
  await expect(page.locator('.page-content')).toBeVisible();
});

test('第三方平台 DeepSeek API 可作为AI后端，并支持第三方供应商Base URL', async ({ page }) => {
  await mockRuntimeHealth(page);
  const providers = [{ id: 'deepseek_api', label: 'DeepSeek 开放平台', kind: 'api', configured: true, ready: true, keyUrl: 'https://platform.deepseek.com/api_keys' }];
  await page.route('http://127.0.0.1:4178/api/providers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, providers }) }));
  await page.route('http://127.0.0.1:4178/api/diagnostics', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, diagnostics: { checkedAt: new Date().toISOString() } }) }));
  const statusCalls: string[] = [];
  await page.route('http://127.0.0.1:4178/api/chat/status*', (route) => { statusCalls.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { ready: true, provider: providers[0], activeSessions: 0 } }) }); });
  let sentBody: any = null;
  await page.route('http://127.0.0.1:4178/api/chat/sessions/*/messages', async (route) => {
    sentBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { sessionId: 'chat-deepseek', threadActive: false, reply: 'DeepSeek已接入。', questions: [], requirementSuggestions: [], bomDraft: null, eda: { status: 'unavailable', reason: '无窗口', windowCount: 0 } } }) });
  });
  await openPage(page, 'settings', '系统设置');
  await page.getByLabel('Provider').selectOption('deepseek_api');
  await page.getByLabel('第三方供应商 Base URL（可选）').fill('https://gateway.example.com/v1');
  await page.getByRole('combobox', { name: /^模型/ }).fill('deepseek-reasoner');
  await page.getByRole('button', { name: '保存设置' }).click();
  await openDesignTab(page, 'chat');
  await expect(page.getByLabel('发送给Codex的PCBA需求')).toBeEnabled();
  await page.getByLabel('发送给Codex的PCBA需求').fill('用DeepSeek检查需求');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('DeepSeek已接入。')).toBeVisible();
  expect(sentBody.provider).toBe('deepseek_api');
  expect(sentBody.baseUrl).toBe('https://gateway.example.com/v1');
  expect(sentBody.model).toBe('deepseek-reasoner');
  expect(statusCalls.some((url) => url.includes('provider=deepseek_api'))).toBe(true);
});

test('自定义 API 可填写 URL、Key 和模型名称，并作为AI后端使用', async ({ page }) => {
  await mockRuntimeHealth(page);
  let configured = false;
  await page.route('http://127.0.0.1:4178/api/providers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, providers: [{ id: 'custom_api', label: '自定义 API（OpenAI 兼容）', kind: 'api', configured, ready: configured, custom: true }] }) }));
  await page.route('http://127.0.0.1:4178/api/diagnostics', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, diagnostics: { checkedAt: new Date().toISOString() } }) }));
  const storedKeys: string[] = [];
  await page.route('http://127.0.0.1:4178/api/providers/custom_api/key', (route) => {
    storedKeys.push(String(route.request().postDataJSON().key));
    configured = true;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, credential: { configured: true, hint: '••••1234' } }) });
  });
  await page.route('http://127.0.0.1:4178/api/chat/status*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { ready: true, provider: { id: 'custom_api', label: '自定义 API（OpenAI 兼容）', kind: 'api', ready: true }, activeSessions: 0 } }) }));
  let sentBody: any = null;
  await page.route('http://127.0.0.1:4178/api/chat/sessions/*/messages', async (route) => {
    sentBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, chat: { sessionId: 'chat-custom', threadActive: false, reply: '自定义API已接入。', questions: [], requirementSuggestions: [], bomDraft: null, eda: { status: 'unavailable', reason: '无窗口', windowCount: 0 } } }) });
  });
  await openPage(page, 'settings', '系统设置');
  await page.getByRole('button', { name: '刷新本机状态' }).click();
  await page.getByLabel('Provider').selectOption('custom_api');
  // 自定义 API 没有平台控制台入口，但必须有 URL、模型和 Key 三个输入。
  await expect(page.getByRole('button', { name: '去平台申请Key' })).toHaveCount(0);
  await expect(page.getByLabel('API URL *')).toBeVisible();
  await expect(page.getByRole('combobox', { name: /^模型/ })).toHaveValue('deepseek-chat');
  await page.getByLabel('API URL *').fill('https://my-gateway.example.com/v1');
  await page.getByRole('combobox', { name: /^模型/ }).fill('deepseek-reasoner');
  await page.locator('input[type="password"]').fill('sk-e2e-custom-key-1234');
  await page.getByRole('button', { name: '安全保存' }).click();
  await expect(page.locator('.toast').filter({ hasText: '已写入macOS钥匙串' })).toBeVisible();
  expect(storedKeys).toEqual(['sk-e2e-custom-key-1234']);
  await page.getByRole('button', { name: '保存设置' }).click();
  await openDesignTab(page, 'chat');
  await expect(page.getByLabel('发送给Codex的PCBA需求')).toBeEnabled();
  await page.getByLabel('发送给Codex的PCBA需求').fill('用自定义API检查需求');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('自定义API已接入。')).toBeVisible();
  expect(sentBody.provider).toBe('custom_api');
  expect(sentBody.baseUrl).toBe('https://my-gateway.example.com/v1');
  expect(sentBody.model).toBe('deepseek-reasoner');
});


test('自定义模型 API 页签：注册多 Provider、维护模型目录、获取模型、设为当前并删除', async ({ page }) => {
  await mockRuntimeHealth(page);
  // Runtime 侧状态：保存后 /api/providers 才返回这个自定义 Provider（与真实 Runtime 一致）。
  let saved: any = null;
  const putBodies: any[] = [];
  const probeCalls: string[] = [];
  let deleteCalls = 0;
  const customSummary = () => saved && {
    id: saved.id, label: saved.label, kind: 'api', configured: saved.configured, ready: saved.configured,
    custom: true, editable: true, protocol: saved.protocol, baseUrl: saved.baseUrl, models: saved.models,
  };
  await page.route('http://127.0.0.1:4178/api/providers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, providers: customSummary() ? [customSummary()] : [] }) }));
  await page.route('http://127.0.0.1:4178/api/diagnostics', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, diagnostics: { checkedAt: new Date().toISOString() } }) }));
  await page.route('http://127.0.0.1:4178/api/custom-providers/acme-gateway', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      putBodies.push(body);
      saved = { id: 'acme-gateway', ...body, configured: Boolean(saved?.configured) };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, customProvider: { ...saved, ready: saved.configured } }) });
    }
    deleteCalls += 1;
    saved = null;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, removed: true, credential: { configured: false } }) });
  });
  await page.route('http://127.0.0.1:4178/api/custom-providers/acme-gateway/models', (route) => {
    probeCalls.push('acme-gateway');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, models: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }] }) });
  });
  const keyNotes: string[] = [];
  await page.route('http://127.0.0.1:4178/api/providers/acme-gateway/key', (route) => {
    if (route.request().method() === 'POST') {
      keyNotes.push(String(route.request().postDataJSON().key));
      saved.configured = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, credential: { configured: true, hint: '••••9f2a' } }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, credential: { configured: false } }) });
  });
  await openPage(page, 'settings', '系统设置');
  // 设置页不会在挂载时自动探测（与既有交互一致），点一次「刷新本机状态」让页面进入真实会话。
  await page.getByRole('button', { name: '刷新本机状态' }).click();
  // 默认页签必须仍是平台 Provider；自定义模型 API 是显式切换的第二个页签。
  await expect(page.getByRole('combobox', { name: /^Provider / })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Provider ID/ })).toHaveCount(0);
  // 入口可发现性（用户必须能自己找到，而不是靠文档）：面板头部按钮直达自定义页签。
  await page.getByRole('button', { name: '自定义模型 API' }).click();
  await expect(page.getByRole('textbox', { name: /^Provider ID/ })).toBeVisible();
  // 回到平台页签，再用 Provider 下拉里的「＋ 新增自定义 Provider…」直达（下拉入口只导航，不改 Provider）。
  await page.getByRole('tab', { name: '平台 Provider' }).click();
  await page.getByRole('combobox', { name: /^Provider / }).selectOption({ value: '__manage_custom_provider__' });
  await expect(page.getByRole('textbox', { name: /^Provider ID/ })).toBeVisible();
  // 空表单点保存必须一次说清哪里不对（用户容易把灰色占位符当成已填好的值）。
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByRole('alert')).toContainText('项需要修正');
  await expect(page.getByRole('alert')).toContainText('Provider ID');
  await expect(page.locator('.custom-provider-list__head')).toContainText('已定义 Provider（0）');
  await page.getByRole('textbox', { name: /^Provider ID/ }).fill('acme-gateway');
  await page.getByRole('textbox', { name: /^显示名称/ }).fill('Acme 网关');
  await page.getByLabel('API 地址').fill('https://gateway.example.com/v1');
  await page.getByLabel('API 协议').selectOption('anthropic');
  await page.getByLabel('模型 1 模型 ID').fill('claude-sonnet-4-5');
  await page.getByLabel('模型 1 显示名称').fill('Claude Sonnet 4.5');
  await page.getByLabel('模型 1 上下文窗口').fill('200000');
  await page.getByLabel('模型 1 最大输出 token 数').fill('16000');
  await page.getByLabel('模型 1 输入类型 图片').check();
  await page.locator('.custom-provider-form input[type="password"]').fill('sk-e2e-acme');
  await page.getByRole('button', { name: '保存配置' }).click();
  // 保存后 Key 只写钥匙串；界面不回显明文。
  await expect(page.locator('.toast').filter({ hasText: '••••9f2a' })).toBeVisible();
  expect(keyNotes).toEqual(['sk-e2e-acme']);
  expect(putBodies).toHaveLength(1);
  expect(putBodies[0]).toEqual({
    label: 'Acme 网关',
    protocol: 'anthropic',
    baseUrl: 'https://gateway.example.com/v1',
    models: [{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', contextWindow: 200000, maxOutputTokens: 16000, input: ['text', 'image'], reasoning: false }],
  });
  // 获取可用模型：增量合并（已存在的不覆盖），不是覆盖用户手填的窗口/输入类型。
  await page.getByRole('button', { name: '获取可用模型' }).click();
  await expect(page.getByLabel('模型 2 模型 ID')).toHaveValue('claude-haiku-4-5');
  await expect(page.getByLabel('模型 1 上下文窗口')).toHaveValue('200000');
  expect(probeCalls).toEqual(['acme-gateway']);
  // 设为当前 Provider：写回注册表并切换到「平台 Provider」，模型下拉只列目录里的模型。
  await page.getByRole('button', { name: '设为当前 Provider' }).click();
  // 用页面上持续存在的状态提示断言（toast 会自动消失，不适合作为跨步骤断言）。
  await expect(page.getByText('该 Provider 当前正被 AI 任务使用')).toBeVisible();
  await page.getByRole('tab', { name: '平台 Provider' }).click();
  await expect(page.getByRole('combobox', { name: /^Provider / })).toHaveValue('acme-gateway');
  await expect(page.getByRole('combobox', { name: /^模型 / })).toHaveValue('claude-sonnet-4-5');
  // 删除：配置与钥匙串条目一起删，列表回到空态。
  await page.getByRole('tab', { name: '自定义模型 API' }).click();
  await page.getByRole('button', { name: '删除该自定义模型' }).click();
  await expect(page.getByRole('dialog', { name: '删除该自定义模型？' })).toContainText('配置与 macOS 钥匙串条目');
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByText('还没有自定义 Provider')).toBeVisible();
  expect(deleteCalls).toBe(1);
});

test('自动化中心：DEMO 下明确不可执行，且不伪造配方数据', async ({ page }) => {
  await page.getByTestId('nav-automation').click();
  await expect(page.locator('.page-head h1')).toHaveText('自动化');
  await expect(page.getByText('自动化执行中心')).toBeVisible();
  // 没连真实 Runtime 时必须显式提示，而不是展示可点击的"运行"假成功入口
  await expect(page.getByText('自动化中心只展示配方元信息，不能签发批准或执行')).toBeVisible();
  await expect(page.getByText('暂无配方（Real Runtime 连接后自动加载）')).toBeVisible();
});

/**
 * T06 前端交接死链回归：
 * 1) 验证页「创建AI修复任务」→ AI 页必须带同一目标（不是只切页面）；
 * 2) 选型提案草稿（sessionStorage）→ EDA 页必须把结构化计划填进计划编辑器并标明来源。
 */
test('验证页创建AI修复任务后，AI页带同一修复目标（交接不再是死链）', async ({ page }) => {
  await openPage(page, 'validation', '验证与交付');
  await page.locator('.finding-row').filter({ hasText: '电源输入未标记PWR_FLAG' }).getByRole('button', { name: '处理' }).click();
  await page.getByRole('button', { name: '创建AI修复任务' }).click();
  await expect(page.locator('.page-head h1')).toHaveText('AI 设计');
  const banner = page.locator('.inline-alert').filter({ hasText: '已从验证页带入修复目标' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('电源输入未标记PWR_FLAG');
  await expect(page.getByLabel('发送给Codex的PCBA需求')).toHaveValue(/修复验证问题：电源输入未标记PWR_FLAG/);
});

test('选型计划草稿进入 EDA 页：计划编辑器载入结构化计划并标明来源', async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem('circuitpilot.schematic-plan-draft', JSON.stringify({
      plan: { marker: 'E2E_HANDOFF', operations: [] },
      planHash: 'e2e-handoff-plan-hash',
      sourceLabel: '元件选型提案（E2E）',
      source: 'part-proposal',
      createdAt: new Date().toISOString(),
    }));
  });
  await page.goto('/');
  await openPage(page, 'eda', 'EDA 执行');
  const alert = page.locator('.inline-alert').filter({ hasText: '计划草稿来自' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('元件选型提案（E2E）');
  await expect(alert).toContainText('e2e-handoff-');
  await expect(page.getByLabel('结构化设计计划')).toHaveValue(/E2E_HANDOFF/);
});

/**
 * C3 系统事件时间线：必须说清它是"进程内存日志"而非持久审计；Runtime 不可达时明确报错，
 * 不把空列表伪装成"一切正常"。
 */
test('系统事件时间线：标明进程内存边界，Runtime 不可达时明确报错', async ({ page }) => {
  await openPage(page, 'versions', '版本与问题');
  await page.getByRole('tab', { name: /系统事件/ }).click();
  await expect(page.getByText(/Runtime 日志事件是/)).toBeVisible();
  await expect(page.getByText(/^读取失败：/)).toBeVisible();
  await expect(page.getByRole('button', { name: '导出运行事件 JSON' })).toBeDisabled();
});

/**
 * A13 ERC 面板：DEMO 模式必须禁用真机取证并说明原因；面板要明确聚合计数≠逐条明细。
 */
test('ERC 收敛面板：DEMO 下禁止真机取证，并区分聚合计数与逐条明细', async ({ page }) => {
  await openPage(page, 'validation', '验证与交付');
  const panel = page.locator('.panel').filter({ hasText: '原理图 ERC 收敛' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/ERC 是只读取证/)).toBeVisible();
  const runButton = panel.getByRole('button', { name: '运行 ERC 取证' });
  await expect(runButton).toBeDisabled();
  await expect(runButton).toHaveAttribute('title', /DEMO/);
  await expect(panel.getByText('还没有 ERC 证据')).toBeVisible();
});
