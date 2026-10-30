/**
 * RAG 分词（中文友好、零依赖）：
 *   - 英文/数字/料号：按连续字母数字串切词，小写化；
 *   - 中文：单字 + 相邻二元组（bigram），解决"不用词典也能召回中文短语"的问题；
 *   - 去掉高频虚词/停用词，避免 BM25 被"的/了/the"刷分。
 * 纯函数：输入文本，输出 token 数组（保留重复次数，供 TF 统计）。
 */

const EN_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'as', 'at', 'by', 'from', 'that', 'this', 'these', 'those', 'it', 'its', 'not', 'no', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must', 'if', 'then', 'than', 'so', 'such', 'via', 'per', 'into', 'over', 'under', 'about', 'after', 'before', 'between', 'during', 'within', 'without', 'and/or']);
const CN_STOPCHARS = new Set(['的', '了', '是', '在', '和', '与', '及', '或', '为', '对', '把', '被', '这', '那', '有', '无', '不', '也', '都', '就', '而', '其', '之', '以', '于', '等', '中', '上', '下', '个', '些', '很', '更', '最', '可', '会', '能', '要', '将', '已', '并', '由', '从', '向', '给', '让', '使', '得', '地', '着', '过', '吗', '呢', '吧', '啊']);

export function tokenize(text) {
  const raw = String(text ?? '').normalize('NFKC').toLowerCase();
  const tokens = [];
  for (const match of raw.matchAll(/[a-z0-9][a-z0-9_.+-]*/g)) {
    const token = match[0].replace(/[.+-]+$/, '');
    if (!token || EN_STOPWORDS.has(token)) continue;
    tokens.push(token);
  }
  for (const match of raw.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
    const chars = [...match[0]];
    for (const char of chars) {
      if (!CN_STOPCHARS.has(char)) tokens.push(char);
    }
    for (let index = 1; index < chars.length; index += 1) {
      const pair = chars[index - 1] + chars[index];
      if (CN_STOPCHARS.has(chars[index - 1]) && CN_STOPCHARS.has(chars[index])) continue;
      tokens.push(pair);
    }
  }
  return tokens;
}

export function termFrequencies(tokens) {
  const frequencies = new Map();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  return frequencies;
}
