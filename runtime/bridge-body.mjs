export const DEFAULT_BODY_LIMIT = 1_000_000;
// A validated 50 MB native archive expands to at most 66.7 MB as base64.
export const AUTHENTICATED_EXECUTE_LIMIT = 72_000_000;

export function readBridgeBody(request, limit = DEFAULT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, settled = false;
    const fail = (message, code, status) => {
      if (settled) return;
      settled = true; chunks = [];
      reject(Object.assign(new Error(message), { code, status, dispatched: false }));
      // Drain rather than destroy: the caller must be able to deliver HTTP 413.
      request.resume();
    };
    request.on('error', error => fail(error.message, 'BRIDGE_BODY_INTERRUPTED', 400));
    request.on('aborted', () => fail('Request body interrupted', 'BRIDGE_BODY_INTERRUPTED', 400));
    const declared = Number(request.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      fail(`请求超过桥接传输上限 ${limit} 字节；未发送到 EDA`, 'BRIDGE_PAYLOAD_TOO_LARGE', 413);
      return;
    }
    request.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) return fail(`请求超过桥接传输上限 ${limit} 字节；未发送到 EDA`, 'BRIDGE_PAYLOAD_TOO_LARGE', 413);
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      try { const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; settled = true; chunks = []; resolve(body); }
      catch { fail('Invalid JSON body', 'BRIDGE_BODY_INVALID', 400); }
    });
  });
}
