import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { TOOL_NAMES, TOOL_ROUTES, DEFAULT_TOOL_CONFIG } from '../lib/tools.mjs';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const read = (name) => readFile(join(pluginDir, name), 'utf8');

test('package.json：type=module / main / exports / dsh.bundle.patch / engines / peerDependencies', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.name, 'dsh-circuitpilot');
  assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'index.mjs');
  assert.equal(pkg.exports['.'], './index.mjs');
  assert.equal(pkg.exports['./lib/*'], './lib/*');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.engines.node, '>=22');
  assert.equal(pkg.dependencies, undefined, '插件不应引入运行时 npm 依赖');
  for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-mcp-client']) {
    assert.ok(pkg.peerDependencies[peer], `缺少 peerDependency ${peer}`);
    assert.match(pkg.peerDependencies[peer], /0\.2\.\d-rc\.\d|4\.0\.\d|3\.18\.\d/);
  }
  assert.ok(pkg.files.includes('cordis.patch.yml'));
  assert.ok(pkg.files.includes('skills'));
});

test('cordis.patch.yml：insert dsh-circuitpilot 条目与默认 config', async () => {
  const yml = await read('cordis.patch.yml');
  assert.match(yml, /- insert:/);
  assert.match(yml, /id: dsh-circuitpilot/);
  assert.match(yml, /name: 'dsh-circuitpilot'/);
  assert.match(yml, /runtimeUrl: 'http:\/\/127\.0\.0\.1:4178'/);
  assert.match(yml, /approvalMode: chat/);
  assert.match(yml, /uiUrl: 'http:\/\/127\.0\.0\.1:4177'/);
});

test('SKILL.md：frontmatter name/description/whenToUse + 对话规程关键约束', async () => {
  const raw = await read('skills/circuitpilot/SKILL.md');
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  assert.ok(front, 'skill 必须有 frontmatter');
  assert.match(front[1], /^name: circuitpilot$/m);
  const description = /^description: (.+)$/m.exec(front[1])?.[1];
  assert.ok(description && description.length > 30);
  assert.match(front[1], /^whenToUse: (.+)$/m);
  for (const phrase of ['cp_status', 'cp_design_plan', 'cp_pcb_plan', 'cp_approve', 'cp_execute', 'cp_job', 'cp_validation', 'includeAllProjects', 'boards', '禁止', 'truncated', 'approvalToken', '写暂停', '签核']) {
    assert.ok(raw.includes(phrase), `skill 正文缺少：${phrase}`);
  }
});

test('README：安装、token、chat 审批风险、approval token 不暴露、测试命令', async () => {
  const readme = await read('README.md');
  for (const phrase of [
    'plugin --profile cp-test add',
    'link:',
    'agent-token.json',
    'CIRCUITPILOT_AGENT_TOKEN_FILE',
    'approvalMode',
    'chat 审批模式',
    '不返回给模型',
    'node --test "plugin/dsh-circuitpilot/test/*.test.mjs"',
    'AGENT_TOKEN_MISSING',
    'AGENT_ROUTE_FORBIDDEN',
    'includeAllProjects',
    'projectLimit',
    'projectOverview',
    'batch validation',
    'SCHEMATIC_UUID_REQUIRED',
  ]) {
    assert.ok(readme.includes(phrase), `README 缺少：${phrase}`);
  }
  for (const toolName of TOOL_NAMES) assert.ok(readme.includes(toolName), `README 工具表缺少 ${toolName}`);
});

test('index.mjs：DSH 入口导出与注册 API 用法', async () => {
  const index = await read('index.mjs');
  assert.match(index, /export const name = 'dsh-circuitpilot'/);
  assert.match(index, /export const inject = \['tools', 'skills', 'systemPrompt'\]/);
  assert.match(index, /export const Config = z && typeof z\.object === 'function'/);
  assert.ok(index.includes('z.object({'));
  assert.ok(index.includes('fallbackConfig'));
  for (const key of ['runtimeUrl', 'approvalMode', 'agentTokenFile', 'maxResultBytes']) {
    assert.ok(index.includes(`${key}:`), `Config 缺少 ${key}`);
  }
  assert.match(index, /export async function apply\(ctx, config = \{\}\)/);
  assert.ok(index.includes("import('@deepseek-ai/dsh-mcp-client')"));
  assert.ok(index.includes('createMcpToolDefinition'));
  assert.ok(index.includes('ctx.tools.register('));
  assert.ok(index.includes('ctx.skills.registerProvider('));
  assert.ok(index.includes('ctx.systemPrompt.section('));
  assert.ok(index.includes('isConcurrencySafe'));
  assert.ok(index.includes("import('@deepseek-ai/dsh-skill')"));
  assert.ok(index.includes('BUNDLED_SKILL_RANK'));
  // 降级路径必须存在：简单对象 + execute
  assert.match(index, /inputSchema: tool\.inputSchema/);
  assert.match(index, /execute: call/);
});

test('lib/** 不 import @deepseek-ai（host-independent，可供 verification 直接测试）', async () => {
  const files = await readdir(join(pluginDir, 'lib'));
  assert.deepEqual(files.sort(), ['jobs.mjs', 'projection.mjs', 'runtime.mjs', 'tools.mjs']);
  for (const file of files) {
    const source = await readFile(join(pluginDir, 'lib', file), 'utf8');
    assert.equal(source.includes('@deepseek-ai/'), false, `${file} 不应依赖 DSH peer 包`);
  }
});

test('工具常量与路由映射：12 个工具、写工具都有明确路由或本地 job 说明', () => {
  assert.equal(TOOL_NAMES.length, 12);
  assert.equal(new Set(TOOL_NAMES).size, 12);
  assert.equal(TOOL_NAMES[0], 'cp_status');
  assert.ok(TOOL_NAMES.includes('cp_approve'));
  assert.ok(TOOL_NAMES.includes('cp_execute'));
  assert.deepEqual(Object.keys(TOOL_ROUTES).sort(), [...TOOL_NAMES].sort());
  for (const name of TOOL_NAMES) {
    assert.ok(Array.isArray(TOOL_ROUTES[name]) && TOOL_ROUTES[name].length > 0, `${name} 缺少路由映射`);
  }
  assert.equal(TOOL_ROUTES.cp_approve.some((route) => route.includes('/api/design/approve')), true);
  assert.equal(TOOL_ROUTES.cp_approve.some((route) => route.includes('/api/pcb/approve')), true);
  assert.equal(TOOL_ROUTES.cp_execute.some((route) => route.includes('/api/design/execute')), true);
  assert.equal(TOOL_ROUTES.cp_export.some((route) => route.includes('/api/production/export')), true);
  assert.equal(DEFAULT_TOOL_CONFIG.approvalMode, 'chat');
  assert.equal(DEFAULT_TOOL_CONFIG.maxResultBytes, 16384);
});

test('测试目录：不读取真实 token 路径、不依赖 DSH/EDA', async () => {
  const dir = join(pluginDir, 'test');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.mjs'));
  assert.ok(files.includes('helpers.mjs'));
  for (const file of files) {
    if (file === 'package.test.mjs') continue; // 本文件自身包含断言关键字
    const source = await readFile(join(dir, file), 'utf8');
    assert.equal(source.includes('~/Library'), false, `${file} 不应直接使用真实 token 路径`);
    assert.equal(/@deepseek-ai\//.test(source), false, `${file} 不应依赖 DSH 包`);
  }
  const helper = await readFile(join(dir, 'helpers.mjs'), 'utf8');
  assert.ok(helper.includes('mkdtemp'));
  assert.ok(helper.includes("server.listen(0"));
});

test('index.mjs 可被独立 import（无 DSH peer 也能加载）并导出入口契约', async () => {
  const mod = await import('../index.mjs');
  assert.equal(mod.name, 'dsh-circuitpilot');
  assert.deepEqual(mod.inject, ['tools', 'skills', 'systemPrompt']);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(typeof mod.Config, 'function');
  const resolved = mod.Config(undefined);
  assert.equal(resolved.runtimeUrl, 'http://127.0.0.1:4178');
  assert.equal(resolved.approvalMode, 'chat');
  assert.equal(resolved.maxResultBytes, 16384);
  const off = mod.Config({ approvalMode: 'off', maxResultBytes: 999999 });
  assert.equal(off.approvalMode, 'off');
  assert.equal(off.maxResultBytes, 262144);
});

test('index.mjs apply：fake DSH ctx 上注册 12 工具 / bundled skill / systemPrompt / effect', async () => {
  const mod = await import('../index.mjs');
  const { TOOL_NAMES } = await import('../lib/tools.mjs');
  const registered = [];
  const sections = [];
  const effects = [];
  const warnings = [];
  let providerFactory = null;
  const ctx = {
    tools: { register: (definition) => { registered.push(definition); return () => {}; } },
    skills: { registerProvider: (factory) => { providerFactory = factory; } },
    systemPrompt: { section: (section) => { sections.push(section); }, getSectionOrder: () => 11 },
    effect: (factory, label) => { effects.push({ factory, label }); },
    logger: { info: () => {}, warn: (message) => warnings.push(message) },
  };
  const api = await mod.apply(ctx, { runtimeUrl: 'http://127.0.0.1:1', approvalMode: 'chat', maxResultBytes: 4096 });
  assert.deepEqual(registered.map((tool) => tool.name), [...TOOL_NAMES]);
  assert.ok(registered.every((tool) => typeof tool.execute === 'function' && tool.inputSchema.type === 'object'));
  assert.equal(typeof providerFactory, 'function');
  const provider = providerFactory();
  const list = await provider.list();
  assert.equal(list[0].name, 'circuitpilot');
  assert.ok(list[0].description.length > 30);
  assert.ok(list[0].whenToUse);
  const skill = await provider.get(list[0]);
  assert.ok(skill.content.includes('cp_approve'));
  assert.ok(skill.content.includes('禁止'));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'circuitpilot');
  assert.equal(sections[0].order, 11);
  assert.ok(sections[0].text().includes('cp_execute'));
  assert.equal(effects.length, 1);
  assert.equal(effects[0].label, 'dsh-circuitpilot.lifecycle');
  // 真实 cordis 会把 apply 返回值当 effect；返回值必须是 undefined，清理走 ctx.effect。
  assert.equal(api, undefined);
  assert.equal(effects.length, 1);
  assert.equal(typeof effects[0].factory(), 'function');
  effects[0].factory()();
  assert.ok(Array.isArray(warnings));
});
