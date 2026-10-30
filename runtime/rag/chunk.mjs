/**
 * RAG 文档分块：Markdown 感知（保留标题路径），目标块大小可控，块间带重叠。
 * 目标：一个块能独立回答一个工程问题（DRC 规则/器件约束/流程要求），而不是切碎句子。
 */

export function chunkMarkdown(text, { maxChars = 700, minChars = 60, overlapChars = 90 } = {}) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const headingStack = [];
  const chunks = [];
  let buffer = [];
  let bufferChars = 0;
  let startLine = 1;
  let currentLine = 0;

  const flush = (endLine) => {
    const body = buffer.join('\n').trim();
    buffer = [];
    bufferChars = 0;
    if (!body) return;
    const heading = headingStack.map((item) => item.title).join(' > ');
    const previousTail = chunks.length && overlapChars > 0 ? chunks[chunks.length - 1].text.slice(-overlapChars) : '';
    const content = previousTail ? `${previousTail}\n${body}` : body;
    chunks.push({ index: chunks.length, heading, text: content.slice(0, maxChars + overlapChars), startLine, endLine, chars: content.length });
  };

  const pushText = (text) => {
    let rest = text;
    while (rest.length > 0) {
      if (bufferChars >= maxChars) flush(currentLine);
      const space = Math.max(1, maxChars - bufferChars);
      if (rest.length <= space) {
        buffer.push(rest);
        bufferChars += rest.length + 1;
        return;
      }
      buffer.push(rest.slice(0, space));
      bufferChars += space;
      flush(currentLine);
      rest = rest.slice(space);
    }
  };

  for (const line of lines) {
    currentLine += 1;
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      if (bufferChars > 0) flush(currentLine - 1);
      const level = headingMatch[1].length;
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
      headingStack.push({ level, title: headingMatch[2].trim() });
      startLine = currentLine;
      continue;
    }
    if (!line.trim()) {
      if (bufferChars >= maxChars) { flush(currentLine - 1); startLine = currentLine + 1; }
      else if (bufferChars > 0) buffer.push('');
      continue;
    }
    pushText(line);
    if (bufferChars >= maxChars) { flush(currentLine); startLine = currentLine + 1; }
  }
  if (bufferChars >= minChars || chunks.length === 0) flush(currentLine);
  return chunks.filter((chunk) => chunk.text.trim().length > 0);
}

export function chunkPlainText(text, options = {}) {
  return chunkMarkdown(String(text ?? ''), options);
}
