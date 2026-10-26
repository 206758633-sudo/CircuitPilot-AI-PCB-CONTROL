import { PROVIDERS, authHeaders, normalizeBaseUrl, resolveChatBaseUrl } from './providers.mjs';

/**
 * 第三方供应商平台的对话通道（OpenAI Chat Completions / Anthropic Messages）。
 *
 * 设计边界：
 * - 只接受声明表里的 API Provider，或调用方（chat.mjs）传入的**已校验描述符**
 *   （自定义模型 Provider 由 customProviders.mjs#resolve 产出，形状与内置条目一致）；
 *   Base URL 可被请求覆盖（第三方网关/代理），但要经过 normalizeBaseUrl 校验：
 *   HTTPS，或本机回环 HTTP，且不允许 URL 内嵌凭据。
 * - 只用 JSON 输出模式，不执行模型返回的任何脚本；模型输出始终按"不可信文本"解析。
 * - 错误码保持稳定，前端据 code 展示中文人话，不把 Key 或完整响应写进错误消息。
 * - 协议差异（端点/鉴权头/请求体/图片块/响应结构）只在这里收口：调用方按描述符透传
 *   protocol/auth/headers/maxTokens，不需要知道对方是 OpenAI 还是 Anthropic。
 */

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 240_000;
const DEFAULT_MAX_TOKENS = 4_000;
const ANTHROPIC_VERSION = '2023-06-01';

function error(code, message, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

/** 从模型输出中尽力提取一个 JSON 对象（兼容 ```json 围栏与前后说明文字）。 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw error('PROVIDER_RESPONSE_INVALID', '第三方平台返回了空响应');
  const withoutFence = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(withoutFence); } catch { /* 继续尝试提取对象 */ }
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(withoutFence.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw error('PROVIDER_RESPONSE_INVALID', '第三方平台未返回可解析的 JSON（请确认模型支持 JSON 输出）');
}

/** 图片附件 → OpenAI 的 image_url data URL（不落盘、不经过任何第三方图床）。 */
function openAiImagePart(image) {
  return { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.dataBase64}` } };
}

/** 图片附件 → Anthropic Messages 的 base64 source 块。 */
function anthropicImagePart(image) {
  return { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.dataBase64 } };
}

/** 把 401/403/429/其它 HTTP 错误统一映射成稳定错误码（消息里绝不含 Key）。 */
function httpError(response, body) {
  const message = String(body?.error?.message || body?.message || '');
  const err = error(
    response.status === 401 ? 'PROVIDER_UNAUTHORIZED' : response.status === 403 ? 'PROVIDER_FORBIDDEN' : response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_HTTP_ERROR',
    response.status === 401 ? '第三方平台 API Key 无效或已撤销'
      : response.status === 403 ? '第三方平台拒绝访问（Key 权限或模型未开通）'
        : response.status === 429 ? '第三方平台配额或速率受限'
          : `第三方平台返回 HTTP ${response.status}${message ? `：${message.slice(0, 200)}` : ''}`,
    response.status === 401 ? 401 : 502,
  );
  err.jsonModeRejected = response.status === 400 && /response_format|json_object|json mode/i.test(message);
  return err;
}

/**
 * 发起一轮 JSON 对话。
 * @param {{ providerId?: string, provider?: object, key: string, model?: string|null, instructions: string, input: string,
 *           schema?: object, history?: Array<{role:'user'|'assistant',content:string}>, baseUrl?: string,
 *           protocol?: 'openai'|'anthropic', auth?: 'bearer'|'x-api-key'|'x-goog-api-key',
 *           headers?: Record<string,string>, maxTokens?: number,
 *           images?: Array<{ name: string, mime: string, dataBase64: string }>,
 *           timeoutMs?: number, fetchImpl?: typeof fetch }} options
 */
export async function completeJson(options) {
  // 有描述符（自定义 Provider）时以描述符为准；没有时沿用内置声明表，旧调用/旧测试行为不变。
  const descriptor = options.provider && typeof options.provider === 'object' ? options.provider : null;
  const declared = descriptor || PROVIDERS[options.providerId];
  if (!declared || declared.kind !== 'api') throw error('PROVIDER_CHAT_UNSUPPORTED', '所选 Provider 不支持 API 对话');
  const protocol = options.protocol === 'anthropic' || declared.protocol === 'anthropic' ? 'anthropic' : 'openai';
  // 自定义 Provider 的根地址就是 Base URL；内置平台仍走 resolveChatBaseUrl（含"自定义 API 必须填 URL"的提示）。
  const base = descriptor
    ? (normalizeBaseUrl(options.baseUrl) || normalizeBaseUrl(declared.chatBaseUrl) || normalizeBaseUrl(declared.baseUrl))
    : resolveChatBaseUrl(declared, options.baseUrl);
  if (!base) throw error('PROVIDER_BASE_URL_REQUIRED', '该 Provider 没有可用的 Base URL，请先在系统设置填写');
  // 'auto'（前端传 null）时回落到平台声明的默认模型；未声明默认模型的平台必须显式选择，
  // 避免把 DeepSeek 的模型 ID 误发给不兼容的平台。
  const model = String(options.model || '').trim() || String(declared.chatModel || '').trim();
  if (!model) throw error('PROVIDER_MODEL_REQUIRED', '请在系统设置选择该平台的具体模型（auto 需要平台声明默认模型）', 400);
  const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(1_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT));
  const maxTokens = Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0 ? Math.trunc(Number(options.maxTokens)) : DEFAULT_MAX_TOKENS;
  // 图片与文本都来自用户上传，注释里明确"仅作为证据"；图片只在本进程内转成 data URL/base64 块，不经任何图床。
  const images = (Array.isArray(options.images) ? options.images : [])
    .filter((image) => image && typeof image.dataBase64 === 'string' && image.dataBase64 && typeof image.mime === 'string' && image.mime);
  const schemaNote = options.schema
    ? `\n\n你只能输出一个符合以下 JSON Schema 的 JSON 对象（不要输出 Markdown 围栏、解释或额外字段）：\n${JSON.stringify(options.schema)}`
    : '';
  const system = `${options.instructions}${schemaNote}`;
  const history = Array.isArray(options.history)
    ? options.history.slice(-12).map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: String(item.content ?? '') }))
    : [];
  const fetchImpl = options.fetchImpl || fetch;
  // 鉴权头与额外头都以描述符为准，但允许调用方显式覆盖（auth/headers），这样 chat.mjs 只需透传。
  const effectiveProvider = { ...declared, auth: options.auth || declared.auth, headers: { ...(declared.headers || {}), ...(options.headers || {}) } };
  const authHeaderSet = authHeaders(effectiveProvider, options.key);

  const send = async (endpoint, payload, headers, retryableJsonMode) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const err = httpError(response, body);
        err.jsonModeRejected = Boolean(retryableJsonMode) && Boolean(err.jsonModeRejected);
        throw err;
      }
      return body;
    } catch (err) {
      if (err.name === 'AbortError') throw error('PROVIDER_TIMEOUT', '第三方平台响应超时');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  if (protocol === 'anthropic') {
    /**
     * Anthropic Messages：system 是顶层字段（不是 messages[0]），图片是 base64 source 块，
     * 没有 response_format 概念——JSON 输出只能靠上面提示词里的 Schema 约束，
     * 所以这里不做"去掉 response_format 重试"那套降级。
     */
    const messages = [
      ...history,
      {
        role: 'user',
        content: images.length
          ? [{ type: 'text', text: String(options.input ?? '') }, ...images.map(anthropicImagePart)]
          : String(options.input ?? ''),
      },
    ];
    const body = await send(
      `${base}/messages`,
      { model, max_tokens: maxTokens, temperature: 0.2, system, messages },
      { ...authHeaderSet, 'anthropic-version': effectiveProvider.headers['anthropic-version'] || ANTHROPIC_VERSION },
      false,
    );
    // 正常响应是 content:[{type:'text',text}]；可能有多个文本块（例如思考块之后的正文），按顺序拼接。
    const content = Array.isArray(body?.content)
      ? body.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('')
      : '';
    return { json: extractJson(content), text: content, model: body?.model || model, provider: options.providerId || declared.id || null, protocol };
  }

  const messages = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: images.length ? [{ type: 'text', text: String(options.input ?? '') }, ...images.map(openAiImagePart)] : String(options.input ?? '') },
  ];
  const callOpenAi = async (jsonMode) => send(
    `${base}/chat/completions`,
    {
      model,
      messages,
      temperature: 0.2,
      // max_tokens 只作成本上限；用户可在模型目录里给每个模型单独设上限（chat.mjs 负责取 min(4000, 上限)）。
      max_tokens: maxTokens,
      stream: false,
      // 推理型模型（DeepSeek-V4-Flash）：思考 token 计入 completion，按调用方要求降低思考强度，
      // 否则多轮对话里 4000 token 会被思考吃光、正文为空（真机实测）。仅显式传入时才发送该字段。
      ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      ...(jsonMode && options.schema ? { response_format: { type: 'json_object' } } : {}),
    },
    authHeaderSet,
    true,
  );

  let body;
  try { body = await callOpenAi(true); }
  catch (err) {
    // 部分平台不支持 response_format；去掉该字段重试一次，仍要求模型按 Schema 输出 JSON。
    if (!err?.jsonModeRejected) throw err;
    body = await callOpenAi(false);
  }
  const content = body?.choices?.[0]?.message?.content;
  return { json: extractJson(content), text: String(content ?? ''), model: body?.model || model, provider: options.providerId || declared.id || null, protocol };
}
