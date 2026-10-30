import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * WP4 P1-15：研究（联网）开关的 Runtime 权威配置。
 *
 * 复审发现：设置页的“允许联网研究”只是前端开关 + `/api/research/status` 里硬编码
 * `enabled:false`，没有任何 Runtime 消费者，开关拨动对真实能力没有任何影响（P1-15）。
 * 这里提供唯一的权威配置：持久化到 stateDir，默认 **关闭**（fail-closed），损坏也按关闭处理；
 * server 用 `snapshot()/get()/set()` 接 `/api/research/config` 并让 `/api/research/status` 读同一个值。
 *
 * 注意：研究能力本身不在本模块内启动；这里只回答“是否允许联网研究”，真正发起请求的模块
 * 必须调用 `(await config.get())` 再决定是否出网（否则又只是 UI 假开关）。
 */
export const RESEARCH_CONFIG_CODES = Object.freeze({
  INVALID: 'RESEARCH_CONFIG_INVALID',
});

const emptyState = () => ({ enabled: false, updatedAt: null, actor: null, version: 0 });

export function createResearchConfig({
  file = join(process.env.CIRCUITPILOT_STATE_DIR || join(process.cwd(), 'artifacts/state'), 'research-config.json'),
  now = () => new Date(),
} = {}) {
  let state = emptyState();
  let loaded = false;
  let loadError = null;

  const snapshot = () => ({
    enabled: state.enabled === true,
    updatedAt: state.updatedAt ?? null,
    actor: state.actor ?? null,
    version: state.version ?? 0,
    file,
    ...(loadError ? { loadError } : {}),
  });

  const load = async () => {
    if (loaded) return snapshot();
    loaded = true;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed?.enabled !== 'boolean') {
        loadError = 'research-config.enabled 字段缺失或不是布尔值';
        state = { ...emptyState(), enabled: false };
      } else {
        state = {
          enabled: parsed.enabled,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
          actor: typeof parsed.actor === 'string' ? parsed.actor.slice(0, 80) : null,
          version: Number.isFinite(Number(parsed.version)) ? Number(parsed.version) : 0,
        };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 损坏/不可读 → fail-closed：宁可不能联网，也不能因为一个坏文件默认放开研究。
        loadError = String(error?.message || error).slice(0, 240);
        state = { ...emptyState(), enabled: false };
      }
    }
    return snapshot();
  };

  /** 当前是否允许联网研究（会先确保已读盘）。 */
  const get = async () => (await load()).enabled === true;

  /** 显式设置；写入失败必须抛出，不能内存改了、重启又回到默认关闭/放开。 */
  const set = async ({ enabled, actor = '本机用户' } = {}) => {
    await load();
    if (typeof enabled !== 'boolean') {
      throw Object.assign(new Error('research-config.enabled 必须是布尔值'), { code: RESEARCH_CONFIG_CODES.INVALID, status: 400 });
    }
    const next = {
      enabled,
      updatedAt: now().toISOString(),
      actor: String(actor || '本机用户').slice(0, 80),
      version: (Number(state.version) || 0) + 1,
    };
    await fs.mkdir(dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.rename(temp, file);
    state = next;
    loadError = null;
    return snapshot();
  };

  return { load, get, set, snapshot, get file() { return file; } };
}
