import { createJsonStore } from './store.mjs';
import { logger } from './logger.mjs';
import { normalizeBaseUrl } from './providers.mjs';

/**
 * 自定义模型 Provider 注册表（Runtime 权威持久化）。
 *
 * 与 providers.mjs 的声明式内置目录互补：内置平台是"代码里写死的常量"，这里则是
 * "用户在设置里维护的多个 Provider"（id/label/协议/Base URL/模型目录）。设计要点：
 *
 * 1. **密钥永不落盘**：custom-providers.json 只存公开配置；API Key 走 macOS 钥匙串的
 *    独立条目（config.mjs#customKeychainService），注册表里没有任何密钥字段，
 *    因此 list()/statuses() 的返回值天生不含敏感信息。
 * 2. **校验只做一次、只在 Runtime 做**：前端的镜像校验只是为了即时反馈，最终裁决在这里；
 *    任何不合规输入都以 `CUSTOM_PROVIDER_INVALID`(400) 拒绝，而不是"尽量存下来"。
 * 3. **fail-closed**：状态文件损坏/版本不符时 createJsonStore 抛 STORE_*，构造函数不吞错
 *    （server 侧捕获后降级为内存注册表并大声记日志，与其它子系统一致），
 *    绝不把"读失败"伪装成"没有自定义 Provider"再继续放行。
 * 4. **协议是数据，不是分支**：openai / anthropic 的差别全部收在描述符里
 *    （auth/headers/protocol/baseUrl），下游 apiChat.mjs 只按描述符发请求，
 *    以后新增协议只需扩展 PROTOCOLS 与 apiChat，不必再改 server.mjs。
 */

export const CUSTOM_PROVIDER_PROTOCOLS = Object.freeze(['openai', 'anthropic']);

/** id 规则：小写字母开头，2~40 字符（与 keychain.mjs 的服务名派生规则一致）。 */
export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{1,39}$/;

const MAX_PROVIDERS = 20;
const MAX_MODELS = 20;
const MODEL_ID_MAX = 120;
const MAX_CONTEXT_WINDOW = 10_000_000;
const MIN_CONTEXT_WINDOW = 1_000;
const MAX_OUTPUT_TOKENS = 1_000_000;
const MIN_OUTPUT_TOKENS = 100;
const INPUT_KINDS = Object.freeze(['text', 'image']);

/**
 * 永远保留的 id：`demo` 是前端 ProviderId 的字面量（离线演示），并不在 PROVIDERS 表里，
 * 但同样不能被自定义 Provider 占用——否则前端会把"演示 Provider"解析成真实 API。
 * 其余内置 id（codex_account / claude_account / *_api / custom_api）由调用方通过
 * reservedIds 传入 Object.keys(PROVIDERS)，避免这里重复维护一份容易漂移的清单。
 */
const ALWAYS_RESERVED_IDS = Object.freeze(['demo']);

function invalid(message) {
  return Object.assign(new Error(message), { code: 'CUSTOM_PROVIDER_INVALID', status: 400 });
}

/** 未知 id 的统一错误（server 的 key/test/models/DELETE 路由共用同一份中文提示）。 */
export function customProviderNotFound(id) {
  return Object.assign(new Error(`自定义模型 Provider 不存在：${id}（请刷新列表后重试）`), { code: 'CUSTOM_PROVIDER_NOT_FOUND', status: 404 });
}

const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);

/** 只回公开配置的深拷贝：注册表内部对象不允许被调用方顺手塞字段（尤其密钥）。 */
function cloneProvider(provider) {
  return {
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    models: provider.models.map((model) => ({ ...model, input: [...model.input] })),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

function normalizeModel(raw, index) {
  const at = `第 ${index + 1} 个模型`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`${at}不是对象`);
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) throw invalid(`${at}缺少模型 ID`);
  if (id.length > MODEL_ID_MAX) throw invalid(`${at}的模型 ID 超过 ${MODEL_ID_MAX} 字符`);
  // 模型 ID 会被拼进请求体与错误提示，空白字符既容易看错也不被任何平台接受。
  if (/\s/.test(id)) throw invalid(`${at}的模型 ID 不能包含空白字符`);
  const rawLabel = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (rawLabel.length > 120) throw invalid(`${at}的显示名称不能超过 120 字符`);
  const label = rawLabel;
  const contextWindow = Number(raw.contextWindow);
  if (!Number.isInteger(contextWindow) || contextWindow < MIN_CONTEXT_WINDOW || contextWindow > MAX_CONTEXT_WINDOW) {
    throw invalid(`${at}的上下文窗口必须是 ${MIN_CONTEXT_WINDOW}~${MAX_CONTEXT_WINDOW} 的整数`);
  }
  const maxOutputTokens = Number(raw.maxOutputTokens);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < MIN_OUTPUT_TOKENS || maxOutputTokens > MAX_OUTPUT_TOKENS) {
    throw invalid(`${at}的最大输出 token 数必须是 ${MIN_OUTPUT_TOKENS}~${MAX_OUTPUT_TOKENS} 的整数`);
  }
  if (maxOutputTokens > contextWindow) throw invalid(`${at}的最大输出 token 数不能大于上下文窗口`);
  if (!Array.isArray(raw.input) || !raw.input.length) throw invalid(`${at}必须声明输入类型（input）`);
  const input = [];
  for (const kind of raw.input) {
    if (!INPUT_KINDS.includes(kind)) throw invalid(`${at}的输入类型只能是 text/image`);
    if (!input.includes(kind)) input.push(kind);
  }
  // 只支持图片或只支持文本的对话模型没有实际意义，而且没有 text 时请求体都拼不出来。
  if (!input.includes('text')) throw invalid(`${at}的输入类型必须包含 text`);
  if (raw.reasoning !== undefined && raw.reasoning !== null && typeof raw.reasoning !== 'boolean') throw invalid(`${at}的推理等级（reasoning）必须是布尔值`);
  return { id, label: label || id, contextWindow, maxOutputTokens, input, reasoning: raw.reasoning === true };
}

/**
 * 校验并归一化一条自定义 Provider 配置。
 * @param {object} input 请求体（{ id?, label, protocol, baseUrl, models }）
 * @param {{ reservedIds?: string[], idFromPath?: string|null }} options
 * @returns {{ id: string, label: string, protocol: string, baseUrl: string, models: object[] }}
 */
export function validateCustomProvider(input, { reservedIds = [], idFromPath = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('自定义 Provider 配置必须是对象');
  const bodyId = typeof input.id === 'string' ? input.id.trim() : '';
  const pathId = typeof idFromPath === 'string' ? idFromPath.trim() : '';
  // 路径 id 与 body id 不一致时必须报错：否则"PUT /acme 改的是 beta"这种静默改错对象无法排查。
  if (pathId && bodyId && pathId !== bodyId) throw invalid(`路径中的 Provider ID（${pathId}）与请求体中的 id（${bodyId}）不一致`);
  const id = pathId || bodyId;
  if (!id) throw invalid('自定义 Provider 必须指定 ID（小写字母开头，2~40 字符，如 acme-gateway）');
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(id)) throw invalid(`Provider ID 不合法：${id}（必须小写字母开头，仅含小写字母/数字/点/下划线/连字符，2~40 字符）`);
  const reserved = new Set([...ALWAYS_RESERVED_IDS, ...reservedIds.map((item) => String(item))]);
  if (reserved.has(id)) throw invalid(`Provider ID 与内置 Provider 冲突：${id}（请换一个自定义 ID）`);

  // 名称超长要明确报错而不是静默截断：截断后界面上看到的和存下来的不是同一个东西。
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label) throw invalid('显示名称不能为空（1~60 字符）');
  if (label.length > 60) throw invalid(`显示名称不能超过 60 字符（当前 ${label.length} 字符）`);

  if (!CUSTOM_PROVIDER_PROTOCOLS.includes(input.protocol)) {
    throw invalid(`API 协议必须是 ${CUSTOM_PROVIDER_PROTOCOLS.join(' 或 ')}（当前 ${String(input.protocol)} 不受支持）`);
  }
  // baseUrl 复用内置 Provider 的地址规则：只接受 HTTPS 或本机回环 HTTP，且不允许内嵌凭据。
  if (input.baseUrl === undefined || input.baseUrl === null || String(input.baseUrl).trim() === '') {
    throw invalid('API 地址不能为空（例如 https://gateway.example.com/v1）');
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) throw invalid('API 地址不能为空（例如 https://gateway.example.com/v1）');

  if (!Array.isArray(input.models) || !input.models.length) throw invalid('模型目录至少需要 1 个模型');
  if (input.models.length > MAX_MODELS) throw invalid(`模型目录最多 ${MAX_MODELS} 个模型（当前 ${input.models.length}）`);
  const models = input.models.map(normalizeModel);
  const duplicates = models.map((model) => model.id).filter((id2, index, list) => list.indexOf(id2) !== index);
  if (duplicates.length) throw invalid(`模型 ID 重复：${[...new Set(duplicates)].join('、')}`);

  return { id, label, protocol: input.protocol, baseUrl, models };
}

/**
 * /api/providers 中自定义 Provider 的摘要（§3）。
 * 只从"公开配置 + 钥匙串是否存在凭据"派生，不含任何密钥字段——这是取不到明文的前提，
 * 而不是"取到了再擦掉"。
 */
export function summarizeCustomProvider(provider, configured) {
  return {
    id: provider.id,
    label: provider.label,
    kind: 'api',
    configured: Boolean(configured),
    ready: Boolean(configured),
    custom: true,
    editable: true,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    models: provider.models.map((model) => ({ ...model, input: [...model.input] })),
  };
}

export class CustomProviderRegistry {
  /**
   * @param {{ file?: string|null, reservedIds?: string[], now?: () => Date }} options
   *   file 为空时退化为纯内存注册表（server 侧在状态文件损坏时的降级路径）。
   */
  constructor({ file = null, reservedIds = [], now = () => new Date() } = {}) {
    this.file = file || null;
    this.reservedIds = [...reservedIds];
    this.now = now;
    this.store = this.file ? createJsonStore({ file: this.file, schemaVersion: 1, initial: () => ({ providers: [] }) }) : null;
    // 构造时就加载一次：读损坏/版本不符必须在这里抛出 STORE_*，让 server 有机会降级并记日志。
    this.providers = this.#load();
  }

  #load() {
    if (!this.store) return [];
    const loaded = this.store.load();
    const data = loaded?.data;
    if (!data || typeof data !== 'object' || !Array.isArray(data.providers)) {
      throw Object.assign(new Error(`自定义 Provider 状态文件结构无效（缺少 providers 数组）：${this.file}`), {
        code: 'STORE_CORRUPT', details: { file: this.file },
      });
    }
    const providers = [];
    for (const raw of data.providers) {
      try {
        // 手改过的文件可能混进不合规条目：逐条复校验，坏行丢掉并留下日志，
        // 不让一条笔误把整个注册表（包括其它正常 Provider）带崩。
        const normalized = validateCustomProvider(raw, { reservedIds: this.reservedIds });
        providers.push({
          ...normalized,
          createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
        });
      } catch (error) {
        logger.warn('CustomProviders', '丢弃一条不合规的自定义 Provider 记录', { code: error?.code, message: text(error?.message, 200) });
      }
    }
    return providers;
  }

  #persist() {
    if (!this.store) return;
    this.store.save({ providers: this.providers.map(cloneProvider) });
  }

  /** 全部配置（含 createdAt/updatedAt，无任何密钥字段）。 */
  list() {
    return this.providers.map(cloneProvider);
  }

  get(id) {
    const provider = this.providers.find((item) => item.id === id);
    return provider ? cloneProvider(provider) : null;
  }

  /**
   * 新建或更新一个自定义 Provider。
   * @returns {{ created: boolean, provider: object }}
   */
  upsert(input, { idFromPath = null } = {}) {
    const normalized = validateCustomProvider(input, { reservedIds: this.reservedIds, idFromPath });
    const existingIndex = this.providers.findIndex((item) => item.id === normalized.id);
    if (existingIndex < 0 && this.providers.length >= MAX_PROVIDERS) {
      throw Object.assign(new Error(`自定义 Provider 数量已达上限 ${MAX_PROVIDERS} 个，请先删除不再使用的配置`), { code: 'CUSTOM_PROVIDER_LIMIT', status: 409 });
    }
    const nowIso = this.now().toISOString();
    const existing = existingIndex >= 0 ? this.providers[existingIndex] : null;
    // 更新时保留 createdAt：配置的"创建时间"是审计事实，不因为改了一次名字就重置。
    const provider = { ...normalized, createdAt: existing?.createdAt || nowIso, updatedAt: nowIso };
    if (existing) this.providers[existingIndex] = provider;
    else this.providers.push(provider);
    this.#persist();
    return { created: !existing, provider: cloneProvider(provider) };
  }

  /** 删除配置；未知 id 明确 404，不静默成功。钥匙串条目由调用方（server）负责删除。 */
  remove(id) {
    const index = this.providers.findIndex((item) => item.id === id);
    if (index < 0) throw customProviderNotFound(id);
    this.providers.splice(index, 1);
    this.#persist();
    return { removed: true };
  }

  /**
   * /api/providers 摘要列表。configured 只反映"钥匙串里有没有凭据"。
   * 单个条目探测失败（无钥匙串/权限问题）只让该条目标为未配置，不拖垮整个 Provider 列表。
   */
  async statuses(keychain) {
    const summaries = [];
    for (const provider of this.providers) {
      let configured = false;
      try {
        configured = Boolean(await keychain.configured(provider.id));
      } catch (error) {
        logger.warn('CustomProviders', '读取自定义 Provider 凭据状态失败，按未配置处理', { provider: provider.id, code: error?.code });
      }
      summaries.push(summarizeCustomProvider(provider, configured));
    }
    return summaries;
  }

  /**
   * 解析成下游（chat.mjs / apiChat.mjs / providers.mjs#testProvider）直接可用的描述符。
   * 形状与内置 PROVIDERS 条目对齐（auth/headers/chatBaseUrl/chatModel），
   * 这样两条通道共用同一套请求构造逻辑，不需要在调用方写 if (custom)。
   */
  resolve(id) {
    const provider = this.providers.find((item) => item.id === id);
    if (!provider) return null;
    const protocol = provider.protocol;
    return {
      id: provider.id,
      label: provider.label,
      kind: 'api',
      custom: true,
      editable: true,
      protocol,
      baseUrl: provider.baseUrl,
      chatBaseUrl: provider.baseUrl,
      chatModel: provider.models[0]?.id || null,
      // Anthropic Messages 用 x-api-key + anthropic-version；OpenAI 兼容用 Bearer。
      auth: protocol === 'anthropic' ? 'x-api-key' : 'bearer',
      headers: protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {},
      models: provider.models.map((model) => ({ ...model, input: [...model.input] })),
    };
  }
}
