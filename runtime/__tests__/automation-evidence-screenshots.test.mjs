import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDefaultRecipeRegistry, validateRecipe } from '../automation/recipes.mjs';
import { runRecipe } from '../automation/runner.mjs';
import { createExecutors } from '../automation/executors.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function memoryJournal(entries) {
  return {
    append: (runId, payload) => { entries.push({ runId, ...payload }); return payload; },
    pathFor: () => null,
  };
}

function screenshotRecipe({ bytes = 4096 } = {}) {
  const base = createDefaultRecipeRegistry().get('eda-screenshot-evidence');
  return {
    ...base,
    id: 'screenshot-evidence-probe',
    steps: [{
      ...base.steps[0],
      expect: { ...base.steps[0].expect, assertions: [{ path: 'bytes', op: 'atLeast', value: bytes, label: '截图字节数' }] },
      evidence: { screenshot: true },
    }],
  };
}

test('E11 写步骤 before/after 截图：动作前取 before、验证后取 after，journal 记录两个 sha256 且不落 base64', async () => {
  const entries = [];
  let calls = 0;
  const executors = {
    api: async () => ({}),
    gui: async (action) => {
      if (action.action === 'screenshot') {
        calls += 1;
        if (calls === 2) return { base64: 'AFTER-SHOT-BASE64', bytes: 4096 }; // 第一次是 before 之外的顺序不可靠，下面按文档顺序断言
        if (calls === 1) return { base64: 'BEFORE-SHOT-BASE64', bytes: 4096 };
        return { base64: 'READBACK-SHOT-BASE64', bytes: 4096 };
      }
      return {};
    },
  };
  const result = await runRecipe({ recipe: screenshotRecipe(), executors, journal: memoryJournal(entries) });
  assert.equal(result.state, 'completed');
  const evidence = result.steps[0].evidence;
  assert.equal(evidence.before.ok, true);
  assert.equal(evidence.before.sha256, sha256('BEFORE-SHOT-BASE64'));
  assert.equal(evidence.after.ok, true);
  assert.notEqual(evidence.after.sha256, evidence.before.sha256, 'before/after 必须是两次独立采集');
  assert.equal(evidence.screenshot.sha256, evidence.after.sha256, '兼容字段 screenshot 仍指向 after');
  const phases = entries.map((entry) => entry.phase);
  assert.ok(phases.includes('step.evidence.before'), 'journal 必须记录 before 采集');
  assert.ok(phases.includes('step.evidence.after'), 'journal 必须记录 after 采集');
  const journalText = JSON.stringify(entries);
  assert.ok(!journalText.includes('BEFORE-SHOT-BASE64'), 'journal 只存 sha256，不落截图 base64');
});

test('E11 截图失败不阻断执行，但证据缺口 ok:false + 原因必须在场（不伪装成功）', async () => {
  const entries = [];
  let calls = 0;
  const executors = {
    api: async () => ({}),
    gui: async (action) => {
      if (action.action === 'screenshot') {
        calls += 1;
        // 第 1 次 before 采集与第 4 次 after 采集失败；动作与读回本身正常。
        if (calls === 1 || calls === 4) throw Object.assign(new Error('CDP 截图超时'), { code: 'CDP_SCREENSHOT_TIMEOUT' });
        return { base64: 'GOOD-SHOT-BASE64', bytes: 4096 };
      }
      return {};
    },
  };
  const result = await runRecipe({ recipe: screenshotRecipe(), executors, journal: memoryJournal(entries) });
  assert.equal(result.state, 'completed');
  const evidence = result.steps[0].evidence;
  assert.equal(evidence.before.ok, false);
  assert.equal(evidence.before.error, 'CDP_SCREENSHOT_TIMEOUT');
  assert.equal(evidence.after.ok, false);
  assert.equal(evidence.after.error, 'CDP_SCREENSHOT_TIMEOUT');
  const beforeEntry = entries.find((entry) => entry.phase === 'step.evidence.before');
  assert.equal(beforeEntry.ok, false);
});

test('E11 步骤失败也保留 before 截图证据（失败运行同样可审计）', async () => {
  const entries = [];
  const executors = {
    api: async () => ({}),
    gui: async (action) => {
      if (action.action === 'screenshot') return { base64: 'ONLY-BEFORE-BASE64', bytes: 100 }; // 永远不满足 atLeast 断言
      return {};
    },
  };
  const result = await runRecipe({ recipe: screenshotRecipe({ bytes: 1024 }), executors, journal: memoryJournal(entries) });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'failed');
  const beforeEntry = entries.find((entry) => entry.phase === 'step.evidence.before');
  assert.ok(beforeEntry, '失败步骤仍必须在 journal 留下 before 证据');
  assert.equal(beforeEntry.sha256, sha256('ONLY-BEFORE-BASE64'));
  assert.ok(!entries.some((entry) => entry.phase === 'step.evidence.after'), '未验证通过不得产生 after 证据');
});

test('E11 配方校验：evidence.screenshot 必须保留进规范化步骤；未知字段/非布尔值直接拒绝', () => {
  const base = createDefaultRecipeRegistry().get('eda-screenshot-evidence');
  const normalized = validateRecipe({ ...base, id: 'evidence-normalize-probe', steps: [{ ...base.steps[0], evidence: { screenshot: true } }] });
  assert.deepEqual(normalized.steps[0].evidence, { screenshot: true }, '声明了截图证据就必须出现在规范化结果里');
  const empty = validateRecipe({ ...base, id: 'evidence-empty-probe', steps: [{ ...base.steps[0], evidence: {} }] });
  assert.deepEqual(empty.steps[0].evidence, { screenshot: false });
  assert.throws(() => validateRecipe({ ...base, id: 'evidence-unknown-probe', steps: [{ ...base.steps[0], evidence: { video: true } }] }), /未知字段：video/);
  assert.throws(() => validateRecipe({ ...base, id: 'evidence-type-probe', steps: [{ ...base.steps[0], evidence: { screenshot: 'yes' } }] }), /必须是布尔值/);
});

test('E9/E11 截图通道降级：CDP 超时 → OS 窗口截图兜底（标注 kind/fallbackFrom）；两通道都失败则不伪造证据', async () => {
  const entries = [];
  const executors = createExecutors({
    bridge: null,
    gui: {
      execute: async (action) => {
        if (action === 'screenshot') throw Object.assign(new Error('CDP 调用超时：Page.captureScreenshot'), { code: 'EDA_GUI_TIMEOUT' });
        return {};
      },
    },
    windowCapture: async ({ outDir }) => ({ ok: true, kind: 'os-window-capture', path: `${outDir}/eda-window.png`, sha256: 'f'.repeat(64), bytes: 4096, bounds: { x: 0, y: 0, width: 1, height: 1 } }),
  });
  const result = await runRecipe({ recipe: screenshotRecipe(), executors, journal: memoryJournal(entries) });
  assert.equal(result.state, 'completed');
  const evidence = result.steps[0].evidence;
  assert.equal(evidence.before.kind, 'os-window-capture');
  assert.equal(evidence.before.sha256, 'f'.repeat(64));
  assert.equal(evidence.before.fallbackFrom, 'EDA_GUI_TIMEOUT');
  assert.equal(evidence.after.kind, 'os-window-capture');

  const brokenEntries = [];
  const broken = createExecutors({
    bridge: null,
    gui: { execute: async () => { throw Object.assign(new Error('CDP 调用超时'), { code: 'EDA_GUI_TIMEOUT' }); } },
    windowCapture: async () => { throw Object.assign(new Error('osascript 失败'), { code: 'EDA_WINDOW_BOUNDS_FAILED' }); },
  });
  const failed = await runRecipe({ recipe: screenshotRecipe(), executors: broken, journal: memoryJournal(brokenEntries) });
  assert.equal(failed.state, 'failed');
  const beforeEntry = brokenEntries.find((entry) => entry.phase === 'step.evidence.before');
  assert.equal(beforeEntry.ok, false);
  assert.equal(beforeEntry.error, 'EDA_SCREENSHOT_UNAVAILABLE');
});
