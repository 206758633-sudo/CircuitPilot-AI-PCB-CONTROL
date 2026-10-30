/**
 * 特征哈希向量（零依赖语义近似）：
 *   - 把 token 和相邻 token 对（短语）哈希到固定维度，带符号累加；
 *   - TF 用 1+log(tf)，L2 归一化 → 点积即余弦相似度；
 *   - 纯确定性：同样文本任何机器/进程得到同样向量，可持久化、可复现，不依赖外部 embedding API。
 * 这是"离线可审计"的语义通道；词法通道由 index.mjs 的 BM25 提供，两者混合排序。
 */

export const EMBED_DIMS = 384;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a(text) {
  let hash = FNV_OFFSET >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export function embedTokens(tokens, { dims = EMBED_DIMS } = {}) {
  if (!Number.isInteger(dims) || dims < 8) throw Object.assign(new Error('向量维度必须是不小于 8 的整数'), { code: 'RAG_EMBED_INVALID' });
  const vector = new Float32Array(dims);
  const frequencies = new Map();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const add = (feature, weight) => {
    const hash = fnv1a(feature);
    const index = hash % dims;
    const sign = (hash >>> 31) & 1 ? -1 : 1;
    vector[index] += sign * weight;
  };
  for (const [token, count] of frequencies) add(`t:${token}`, (1 + Math.log(count)) * (token.length > 1 ? 1 : 0.45));
  for (let index = 1; index < tokens.length; index += 1) add(`b:${tokens[index - 1]}\u0000${tokens[index]}`, 0.55);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index];
  return dot;
}

/** Float32Array → base64（索引持久化用，比 JSON 数字数组小 ~4 倍）。 */
export function encodeVector(vector) {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

export function decodeVector(base64, dims = EMBED_DIMS) {
  const buffer = Buffer.from(String(base64 ?? ''), 'base64');
  const copy = new Uint8Array(buffer);
  const floats = new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
  if (floats.length !== dims) throw Object.assign(new Error(`向量维度不符：期望 ${dims}，实际 ${floats.length}`), { code: 'RAG_VECTOR_INVALID' });
  return floats;
}
