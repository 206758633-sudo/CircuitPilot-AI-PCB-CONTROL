import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

/**
 * D8 棘轮（ratchet）：任何 ≥110s 的 Runtime 调用都必须可被前端中止（传 AbortSignal），
 * 或在下面的白名单里显式登记"为什么没有/为什么不需要"。
 *
 * 白名单只会缩小：某方法接上 AbortSignal 后这里随即失败，提醒同步移除登记项，
 * 防止"文档说全迁移了、代码里又悄悄长出新的不可取消长调用"。
 * 阈值 110s 来自 D8：UI 长调用（≥110s）必须走统一长任务控制器。
 */
const TIMEOUT_THRESHOLD_SECONDS = 110;

/** 尚未接 AbortSignal 的长调用：每条都必须写清原因与 UI 现状。 */
const ALLOWLIST = {
  generateDesignPlan: '@legacy 且无 UI 调用方（仅为兼容旧调用方保留，不做长任务控制器）',
  productionRelease: '@legacy 且无 UI 调用方（UI 已走 releaseGate/productionExport，均有 signal）',
  runAutomation: '自动化运行：可经服务端 POST /runs/:id/abort 中止（页面「中止运行」），不依赖 AbortSignal',
};

function longCallsWithoutSignal(source) {
  const lines = source.split('\n');
  const found = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/(\d{3})_000/);
    if (!match) continue;
    const seconds = Number(match[1]);
    if (seconds < TIMEOUT_THRESHOLD_SECONDS) continue;
    if (lines[index].includes('signal')) continue;
    let name = '?';
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      const method = lines[cursor].match(/async ([A-Za-z0-9_]+)\(/);
      if (method) { name = method[1]; break; }
    }
    if (name === '?') continue;
    found.set(name, Math.max(found.get(name) ?? 0, seconds));
  }
  return found;
}

test('D8 棘轮：≥110s 的 Runtime 调用要么传 AbortSignal，要么在白名单登记原因', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/services/runtimeClient.ts'), 'utf8');
  const actual = [...longCallsWithoutSignal(source).keys()].sort();
  assert.deepEqual(actual, Object.keys(ALLOWLIST).sort(), '长调用白名单与代码不一致：新增不可取消长调用必须接 AbortSignal 或登记原因；迁移后必须移除登记');
});
