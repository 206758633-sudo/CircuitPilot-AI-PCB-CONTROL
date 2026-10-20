import { PROVIDERS, authHeaders, resolveChatBaseUrl } from './providers.mjs';

/**
 * 第三方供应商平台的 OpenAI 兼容对话通道。
 *
 * 设计边界：
 * - 只接受声明表里的 API Provider；Base URL 可被请求覆盖（第三方网关/代理），但要经过
 *   normalizeBaseUrl 校验：HTTPS，或本机回环 HTTP，且不允许 URL 内嵌凭据。
 * - 只用 JSON 输出模式，不执行模型返回的任何脚本；模型输出始终按“不可信文本”解析。
 * - 错误码保持稳定，前端据 code 展示中文人话，不把 Key 或完整响应写进错误消息。
 */

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 240_000;

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

/**
 * 发起一轮 JSON 对话。
 * @param {{ providerId: string, key: string, model?: string|null, instructions: string, input: string,
 *           schema?: object, history?: Array<{role:'user'|'assistant',content:string}>, baseUrl?: string,
 *           timeoutMs?: number, fetchImpl?: typeof fetch }} options
 */
export async function completeJson(options) {
  const provider = PROVIDERS[options.providerId];
  if (!provider || provider.kind !== 'api') throw error('PROVIDER_CHAT_UNSUPPORTED', '所选 Provider 不支持 API 对话');
  const base = resolveChatBaseUrl(provider, options.baseUrl);
  const endpoint = `${base}/chat/completions`;
  // 'auto'（前端传 null）时回落到平台声明的默认模型；未声明默认模型的平台必须显式选择，
  // 避免把 DeepSeek 的模型 ID 误发给不兼容的平台。
  const model = String(options.model || '').trim() || provider.chatModel || '';
  if (!model) throw error('PROVIDER_MODEL_REQUIRED', '请在系统设置选择该平台的具体模型（auto 需要平台声明默认模型）', 400);
  const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(1_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT));
  const schemaNote = options.schema
    ? `\n\n你只能输出一个符合以下 JSON Schema 的 JSON 对象（不要输出 Markdown 围栏、解释或额外字段）：\n${JSON.stringify(options.schema)}`
    : '';
  const messages = [
    { role: 'system', content: `${options.instructions}${schemaNote}` },
    ...(Array.isArray(options.history) ? options.history.slice(-12).map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: String(item.content ?? '') })) : []),
    { role: 'user', content: options.input },
  ];
  const fetchImpl = options.fetchImpl || fetch;
  const call = async (jsonMode) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const payload = {
        model,
        messages,
        temperature: 0.2,
        max_tokens: 4_000,
        stream: false,
        ...(jsonMode && options.schema ? { response_format: { type: 'json_object' } } : {}),
      };
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(provider, options.key) },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = String(body?.error?.message || body?.message || '');
        const err = error(
          response.status === 401 ? 'PROVIDER_UNAUTHORIZED' : response.status === 403 ? 'PROVIDER_FORBIDDEN' : response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_HTTP_ERROR',
          response.status === 401 ? '第三方平台 API Key 无效或已撤销'
            : response.status === 403 ? '第三方平台拒绝访问（Key 权限或模型未开通）'
              : response.status === 429 ? '第三方平台配额或速率受限'
                : `第三方平台返回 HTTP ${response.status}${message ? `：${message.slice(0, 200)}` : ''}`,
          response.status === 401 ? 401 : 502,
        );
        err.jsonModeRejected = jsonMode && response.status === 400 && /response_format|json_object|json mode/i.test(message);
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

  let body;
  try { body = await call(true); }
  catch (err) {
    // 部分平台不支持 response_format；去掉该字段重试一次，仍要求模型按 Schema 输出 JSON。
    if (!err?.jsonModeRejected) throw err;
    body = await call(false);
  }
  const content = body?.choices?.[0]?.message?.content;
  return { json: extractJson(content), text: String(content ?? ''), model: body?.model || model, provider: options.providerId };
}
