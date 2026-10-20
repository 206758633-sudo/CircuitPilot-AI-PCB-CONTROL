import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOG_REDACTION_CODES,
  REDACTED,
  REDACTED_EMAIL,
  REDACTED_USER,
  isSensitiveKey,
  redactSecrets,
  redactString,
} from '../log-redaction.mjs';

test('C8：敏感字段名整值脱敏，嵌套对象/数组结构保持不变', () => {
  const input = {
    authorization: 'Bearer abcdefghijklmnop',
    nested: {
      apiKey: 'sk-live-1234567890',
      password: 'p@ssw0rd',
      headers: [{ cookie: 'sid=session-token' }, { accept: 'application/json' }],
      accessToken: 'tok_abcdefghijklmnop',
      safe: 'visible-value',
    },
    list: [1, 'two', true, null],
  };
  const output = redactSecrets(input);
  assert.equal(output.authorization, REDACTED);
  assert.equal(output.nested.apiKey, REDACTED);
  assert.equal(output.nested.password, REDACTED);
  assert.equal(output.nested.accessToken, REDACTED);
  // cookie 是敏感字段名 → 整个值被替换；同数组里的非敏感头保持原样
  assert.equal(output.nested.headers[0].cookie, REDACTED);
  assert.equal(output.nested.headers[1].accept, 'application/json');
  assert.equal(output.nested.safe, 'visible-value');
  assert.deepEqual(output.list, [1, 'two', true, null], '数组必须仍是数组，元素类型不变');
  assert.equal(Array.isArray(output.nested.headers), true);
  // 纯函数：不得改动入参
  assert.equal(input.nested.apiKey, 'sk-live-1234567890');
  assert.equal(input.authorization, 'Bearer abcdefghijklmnop');
});

test('C8：自由文本里的 token/JWT/URL 参数/邮箱/本机路径全部擦除', () => {
  const raw = [
    'Authorization: Bearer abcdefghijklmnop',
    'key=sk-live-ABCDEFGH123456',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureABCDEFGH',
    'url https://api.test/v1/run?token=supersecret&page=1',
    'mail alice@example.com',
    String.raw`mac /Users/jescochen/Desktop/AI- PCBA/artifacts/evidence`,
    String.raw`win C:\Users\jescochen\AppData\Local\CircuitPilot`,
    'file file:///Users/jescochen/.circuitpilot/runtime.log',
  ].join(' | ');

  const { text } = redactSecrets({ text: raw });
  for (const leaked of ['abcdefghijklmnop', 'sk-live-ABCDEFGH123456', 'eyJhbGciOiJIUzI1NiJ9', 'supersecret', 'alice@example.com', 'jescochen', 'runtime.log']) {
    assert.equal(text.includes(leaked), false, `不得泄漏 ${leaked}`);
  }
  assert.ok(text.includes(REDACTED));
  assert.ok(text.includes(REDACTED_EMAIL));
  assert.ok(text.includes(`/Users/${REDACTED_USER}`), 'mac 路径只擦用户名、保留尾部目录便于排障');
  assert.ok(text.includes(`C:\\Users\\${REDACTED_USER}`));
  assert.ok(text.includes('file://[REDACTED_PATH]'));
  // 同一套规则可直接作用于裸字符串
  assert.equal(redactString('/home/bob/app/secrets.env').includes('bob'), false);
});

test('C8：循环引用不崩溃（返回 [Circular]），DAG 共享引用仍正常展开', () => {
  const node = { name: 'root', token: 'secret-token-value' };
  node.self = node;
  node.children = [{ parent: node }];
  const output = redactSecrets(node);
  assert.equal(output.token, REDACTED);
  assert.equal(output.self, '[Circular]');
  assert.equal(output.children[0].parent, '[Circular]');
  assert.equal(output.name, 'root');

  const cycleArray = [];
  cycleArray.push(cycleArray, { name: 'safe' });
  assert.deepEqual(redactSecrets(cycleArray), ['[Circular]', { name: 'safe' }]);

  const shared = { id: 1 };
  const dag = redactSecrets({ a: shared, b: shared });
  assert.deepEqual(dag, { a: { id: 1 }, b: { id: 1 } }, '共享引用不是环，不能误标 [Circular]');

  // 脱敏结果必须能被 JSON.stringify（BigInt/环都已降级）
  assert.doesNotThrow(() => JSON.stringify(output));
});

test('C8：长字符串按 maxStringLength 截断并标注原始长度；深度超限降级', () => {
  const long = 'x'.repeat(1000);
  const output = redactSecrets({ long }, { maxStringLength: 100 });
  assert.ok(output.long.startsWith('x'.repeat(100)));
  assert.match(output.long, /\[truncated 900 chars\]/);
  assert.ok(output.long.length > 100, '截断标记必须保留原始长度信息');

  const exact = redactSecrets({ value: 'y'.repeat(100) }, { maxStringLength: 100 });
  assert.equal(exact.value, 'y'.repeat(100), '恰好等于上限时不应截断');

  let deep = {};
  let cursor = deep;
  for (let index = 0; index < 12; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  const limited = redactSecrets(deep, { maxDepth: 3 });
  let cursorOut = limited;
  for (let index = 0; index < 4; index += 1) cursorOut = cursorOut.next;
  assert.equal(cursorOut, '[DEPTH_LIMIT]');
});

test('C8：异常类型安全降级（Error/Date/Map/Set/Buffer/BigInt/函数/抛错 getter）', () => {
  const error = Object.assign(new Error('boom at /Users/jescochen/app with sk-live-abcdefgh1234'), { code: 'E_DEMO' });
  const throwingProxy = new Proxy({}, {
    ownKeys: () => ['boom'],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    get: () => { throw new Error('getter 爆炸'); },
  });
  const input = {
    error,
    date: new Date('2026-10-20T00:00:00.000Z'),
    badDate: new Date('not-a-date'),
    map: new Map([['token', 'secret-value'], ['safe', 'ok']]),
    set: new Set(['a', 'b']),
    buffer: Buffer.from('abc'),
    big: 10n,
    fn: () => 'nope',
    throwingProxy,
  };
  const output = redactSecrets(input);
  assert.equal(output.date, '2026-10-20T00:00:00.000Z');
  assert.equal(output.badDate, null);
  assert.equal(output.map.token, REDACTED);
  assert.equal(output.map.safe, 'ok');
  assert.deepEqual(output.set, ['a', 'b']);
  assert.equal(output.buffer, '[Buffer 3 bytes]');
  assert.equal(output.big, '10n');
  assert.equal(output.fn, '[Function]');
  assert.equal(output.throwingProxy.boom, '[UNREADABLE]');
  assert.equal(output.error.name, 'Error');
  assert.equal(output.error.code, 'E_DEMO');
  assert.equal(output.error.message.includes('jescochen'), false);
  assert.equal(output.error.message.includes('sk-live'), false);
  assert.equal(output.error.stack.includes('jescochen'), false);
});

test('C8：isSensitiveKey 命中常见密钥字段；非法 options 抛带 code 的错误', () => {
  for (const key of ['authorization', 'apiKey', 'api_key', 'accessToken', 'refresh_token', 'clientSecret', 'dbPassword', 'cookie', 'set-cookie', 'credentials']) {
    assert.equal(isSensitiveKey(key), true, `${key} 应视为敏感字段`);
  }
  for (const key of ['path', 'kind', 'username', 'monkey', 'safe']) {
    assert.equal(isSensitiveKey(key), false, `${key} 不应视为敏感字段`);
  }
  assert.throws(() => redactSecrets({}, { maxDepth: 0 }), (error) => error.code === LOG_REDACTION_CODES.OPTIONS_INVALID);
  assert.throws(() => redactSecrets({}, { maxStringLength: 4 }), (error) => error.code === LOG_REDACTION_CODES.OPTIONS_INVALID);
  assert.throws(() => redactSecrets({}, []), (error) => error.code === LOG_REDACTION_CODES.OPTIONS_INVALID);
});
