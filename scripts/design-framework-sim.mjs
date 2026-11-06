#!/usr/bin/env node
/**
 * 复合设计框架「模拟验收」脚本（离线、可重复、不写 EDA、不碰用户 App）：
 *
 *   1) 起一个隔离的 CircuitPilot Runtime（临时 state/evidence/token，随机空闲端口）；
 *   2) 通过真实 HTTP 跑矩阵：
 *        - GET  /api/design/framework/status   （分层元数据 + 外部工具探测）
 *        - GET  /api/design/framework/golden   （金板评估指标）
 *        - POST /api/design/framework/run      （5 个金板用例 + 确定性 + 失败语义）
 *        - 未认证请求 / 非法模型 / 超大模型 / 非法 JSON 的 fail-closed 校验
 *        - 响应中不泄漏 agent token
 *   3) 退出码：0 全通过；1 有失败；2 启动/环境错误。
 *
 * 用法：
 *   node scripts/design-framework-sim.mjs [--json] [--out <file>] [--port <port>]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = join(ROOT, 'eval/golden');
const START_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const args = { json: false, out: null, port: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--port') args.port = Number.parseInt(argv[++index] ?? '', 10);
    else if (arg === '--help' || arg === '-h') { args.help = true; }
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

const printHelp = () => process.stdout.write([
  '复合设计框架模拟验收',
  '',
  '用法：node scripts/design-framework-sim.mjs [--json] [--out <file>] [--port <port>]',
  '  --json   输出结构化结果（写进 --out 时会包含每项断言）',
  '  --port   指定 Runtime 端口（默认自动挑空闲端口）',
].join('\n') + '\n');

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** 挑一个空闲端口（bind 0 再释放；有竞态但足够模拟用）。 */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
      lastError = new Error(`health HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`Runtime 未在 ${timeoutMs}ms 内就绪：${lastError?.message ?? 'timeout'}`);
}

const goldenCases = () => readdirSync(GOLDEN_DIR).filter((name) => name.endsWith('.json')).sort()
  .map((name) => JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return 0; }

  const workdir = mkdtempSync(join(tmpdir(), 'cp-design-sim-'));
  const stateDir = join(workdir, 'state');
  const evidenceDir = join(workdir, 'evidence');
  const automationDir = join(workdir, 'automation');
  const tokenFile = join(stateDir, 'agent-token.json');
  const port = Number.isInteger(args.port) && args.port > 0 ? args.port : await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [join(ROOT, 'runtime/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      CIRCUITPILOT_RUNTIME_PORT: String(port),
      CIRCUITPILOT_STATE_DIR: stateDir,
      CIRCUITPILOT_EVIDENCE_DIR: evidenceDir,
      CIRCUITPILOT_AUTOMATION_DIR: automationDir,
      CIRCUITPILOT_AGENT_TOKEN_FILE: tokenFile,
      CIRCUITPILOT_KNOWLEDGE_WEB: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  const assertions = [];
  const record = (name, ok, detail = null) => assertions.push({ name, ok, detail });

  try {
    await waitForHealth(baseUrl);
    const token = JSON.parse(readFileSync(tokenFile, 'utf8'));
    const agentToken = token.token || token.value;
    if (!agentToken) throw new Error('agent token 文件没有 token 字段');

    const call = async (method, pathname, { body = null, headers = {}, auth = true } = {}) => {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
          ...(body === null ? {} : { 'content-type': 'application/json' }),
          ...(auth ? { 'x-circuitpilot-agent-token': agentToken } : {}),
          ...headers,
        },
        ...(body === null ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { status: response.status, text, body: parsed };
    };

    /* 1) status */
    {
      const response = await call('GET', '/api/design/framework/status');
      const framework = response.body?.framework;
      record('GET /api/design/framework/status', response.status === 200 && framework?.schemaVersion === 1
        && typeof framework?.kicad?.available === 'boolean'
        && framework?.externalSolvers?.ortools?.available === false,
      { status: response.status, kicad: framework?.kicad?.available, layers: framework?.layers?.length });
    }

    /* 2) golden */
    {
      const response = await call('GET', '/api/design/framework/golden');
      const evaluation = response.body?.evaluation;
      record('GET /api/design/framework/golden：5/5 金板通过', response.status === 200 && evaluation?.ok === true
        && evaluation?.metrics?.total === 5 && evaluation?.metrics?.failed === 0,
      { status: response.status, metrics: evaluation?.metrics });
    }

    /* 3) 5 个金板用例（真实 HTTP 闭环） */
    const cases = goldenCases();
    for (const caseDef of cases) {
      const response = await call('POST', '/api/design/framework/run', { body: { model: caseDef.model, options: caseDef.options ?? {} } });
      const framework = response.body?.framework;
      const statusIn = Array.isArray(caseDef.expect?.statusIn) ? caseDef.expect.statusIn : null;
      const ok = response.status === 200
        && Boolean(framework)
        && (!statusIn || statusIn.includes(framework.status))
        && (caseDef.expect?.blockingAfter === undefined || framework.summary?.blocking === caseDef.expect.blockingAfter)
        && (caseDef.expect?.blockingAfterAtLeast === undefined || (framework.summary?.blocking ?? 0) >= caseDef.expect.blockingAfterAtLeast)
        && (framework.ok === (framework.status !== 'blocked'));
      record(`POST run · ${caseDef.id}`, ok, {
        status: response.status,
        loopStatus: framework?.status,
        blocking: framework?.summary?.blocking,
        review: framework?.summary?.review,
        repairs: framework?.repairCount,
        planOperations: framework?.plan?.operations,
      });
    }

    /* 4) 确定性：同一输入两次 digest 相同 */
    {
      const model = cases[0].model;
      const first = await call('POST', '/api/design/framework/run', { body: { model } });
      const second = await call('POST', '/api/design/framework/run', { body: { model } });
      record('确定性：同输入两次 run 的 digest 一致', first.body?.framework?.digest === second.body?.framework?.digest
        && typeof first.body?.framework?.digest === 'string' && first.body.framework.digest.length === 64,
      { first: first.body?.framework?.digest, second: second.body?.framework?.digest });
    }

    /* 5) 非法模型 → 400 fail-closed */
    {
      const response = await call('POST', '/api/design/framework/run', { body: { model: { board: {} } } });
      const invalidCode = response.body?.error?.code ?? response.body?.code ?? null;
      record('非法模型 → 400 且 code=DESIGN_FRAMEWORK_RUN_FAILED', response.status === 400
        && invalidCode === 'DESIGN_FRAMEWORK_RUN_FAILED', { status: response.status, code: invalidCode });
    }

    /* 6) 超大模型 → 413 fail-closed */
    {
      const bigModel = { board: { widthMm: 60, heightMm: 40 }, components: [], nets: [], meta: { note: 'x'.repeat(210_000) } };
      const response = await call('POST', '/api/design/framework/run', { body: { model: bigModel } });
      const tooLargeCode = response.body?.error?.code ?? response.body?.code ?? null;
      record('超大模型 → 413 且 code=DESIGN_FRAMEWORK_MODEL_TOO_LARGE', response.status === 413
        && tooLargeCode === 'DESIGN_FRAMEWORK_MODEL_TOO_LARGE', { status: response.status, code: tooLargeCode });
    }

    /* 7) 未认证 → 401/403 */
    {
      const response = await call('POST', '/api/design/framework/run', { body: { model: cases[0].model }, auth: false });
      record('未认证请求被拒绝（401/403）', [401, 403].includes(response.status) && response.body?.ok === false, { status: response.status, code: response.body?.code });
    }

    /* 8) 非法 JSON body → 400 且不崩溃 */
    {
      const response = await call('POST', '/api/design/framework/run', { body: '{not-json' });
      record('非法 JSON body → 400 且服务仍可用', response.status === 400, { status: response.status, code: response.body?.code });
    }

    /* 9) token 不泄漏 */
    {
      const responses = [];
      for (const pathname of ['/api/design/framework/status', '/api/design/framework/golden']) {
        responses.push(await call('GET', pathname));
      }
      responses.push(await call('POST', '/api/design/framework/run', { body: { model: cases[0].model } }));
      const leaked = responses.filter((response) => response.text.includes(agentToken) || /cpa_[a-z0-9]{20,}/i.test(response.text));
      record('响应不包含 agent token / cpa_ 前缀', leaked.length === 0, { responses: responses.length });
    }

    const failed = assertions.filter((item) => !item.ok);
    const report = {
      ok: failed.length === 0,
      baseUrl,
      runtime: 'isolated',
      assertions,
      summary: { total: assertions.length, passed: assertions.length - failed.length, failed: failed.length },
    };
    if (args.out) writeFileSync(resolve(args.out), `${JSON.stringify(report, null, 2)}\n`);
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(`模拟验收：${report.summary.passed}/${report.summary.total} 通过\n`);
      for (const item of assertions) {
        process.stdout.write(`  ${item.ok ? '✔' : '✖'} ${item.name}\n`);
        if (!item.ok) process.stdout.write(`      detail=${JSON.stringify(item.detail)}\n`);
      }
    }
    return report.ok ? 0 : 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(workdir, { recursive: true, force: true });
  }
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`design-framework-sim: ${error?.message ?? error}\n`);
  process.exitCode = 2;
});
