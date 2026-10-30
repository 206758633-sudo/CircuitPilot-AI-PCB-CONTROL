/**
 * 验证结果（validations）的 Runtime 权威副本。
 *
 * 复审计 2026-10-29 P0-1：官方 ERC/DRC 结论只活在前端内存，刷新/换机后 KPI 归零、
 * 阶段证据（drcPassed）失效，阶段却已推进 —— 出现"阶段=验证/生产，官方覆盖 0%"。
 *
 * 口径：
 *  - fail-closed 校验：形状不对、条目缺 id/name、id 重复 → `VALIDATION_STATE_INVALID`(400)，不静默修正；
 *  - 上限 200 条（官方记录 + demo/人工登记，实际远小于此）；
 *  - 原子写由 store.mjs 保证；损坏/版本不匹配抛 STORE_*，不假装空状态。
 */
import { createJsonStore } from './store.mjs';

export const VALIDATION_STATE_CODES = { INVALID: 'VALIDATION_STATE_INVALID' };
export const VALIDATION_LIMIT = 200;
const text = (value) => String(value ?? '').trim();

export function normalizeValidationState(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('验证状态必须是对象'), { code: VALIDATION_STATE_CODES.INVALID, details: { field: 'state' } });
  }
  if (input.validations !== undefined && !Array.isArray(input.validations)) {
    throw Object.assign(new Error('validations 必须是数组'), { code: VALIDATION_STATE_CODES.INVALID, details: { field: 'validations' } });
  }
  const seen = new Set();
  const validations = [];
  for (const item of (input.validations || []).slice(0, VALIDATION_LIMIT)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw Object.assign(new Error('validations 的条目必须是对象'), { code: VALIDATION_STATE_CODES.INVALID, details: { field: 'validations[]' } });
    }
    const id = text(item.id);
    if (!id) throw Object.assign(new Error('validations 的条目缺少 id'), { code: VALIDATION_STATE_CODES.INVALID, details: { field: 'validations[].id' } });
    if (seen.has(id)) throw Object.assign(new Error(`validations 的 id 重复：${id}`), { code: VALIDATION_STATE_CODES.INVALID, details: { field: 'validations[].id', id } });
    if (!text(item.name)) throw Object.assign(new Error('validations 的条目缺少 name'), { code: VALIDATION_STATE_CODES.INVALID, details: { field: 'validations[].name', id } });
    seen.add(id);
    validations.push(item);
  }
  return {
    state: { validations },
    truncated: Math.max(0, (input.validations || []).length - VALIDATION_LIMIT),
    total: validations.length,
  };
}

export function createValidationStateStore({ file, now = () => new Date() } = {}) {
  const store = createJsonStore({ file, schemaVersion: 1, now });
  return {
    load() {
      const loaded = store.load();
      const data = loaded.data && typeof loaded.data === 'object' ? loaded.data : {};
      const normalized = normalizeValidationState({ validations: data.validations });
      return { ...normalized, savedAt: loaded.savedAt, migratedFrom: loaded.migratedFrom };
    },
    save(input) {
      const normalized = normalizeValidationState(input);
      const payload = store.save(normalized.state);
      return { ...normalized, savedAt: payload.savedAt };
    },
  };
}
