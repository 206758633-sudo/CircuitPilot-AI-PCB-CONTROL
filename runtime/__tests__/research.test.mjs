import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESEARCH_CODES,
  assertPublicAddresses,
  assertPublicUrl,
  decodeHtmlEntities,
  fetchPage,
  htmlToText,
  isPrivateIpv4,
  isPrivateIpv6,
  parseBingResults,
  parseDuckDuckGoResults,
  searchWeb,
} from '../research.mjs';

const PUBLIC_RESOLVE = async () => [{ address: '93.184.216.34', family: 4 }];

const responseOf = (body, { status = 200, url = 'https://example.com/', contentType = 'text/html; charset=utf-8' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: { get: (key) => (String(key).toLowerCase() === 'content-type' ? contentType : null) },
  arrayBuffer: async () => Buffer.from(body, 'utf8'),
});

const DDG_HTML = `<!DOCTYPE html><html><body>
<div class="result results_links results_links_deep web-result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.lcsc.com%2Fproduct-detail%2FC114586.html&amp;rut=abc">WS2812B 数据手册与料号</a>
  <a class="result__snippet" href="#">WS2812B 是一颗内置控制电路的 5050 RGB LED，单线级联。</a>
</div>
<div class="result results_links web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.espressif.com%2Fen%2Fproducts%2Fsocs%2Fesp32-s3">ESP32-S3 Datasheet</a>
  <a class="result__snippet" href="#">ESP32-S3 is a dual-core Xtensa LX7 MCU with Wi-Fi and BLE.</a>
</div>
</body></html>`;

const BING_HTML = `<!DOCTYPE html><html><body>
<li class="b_algo"><h2><a href="https://www.espressif.com/en/products/socs/esp32-s3">ESP32-S3 Datasheet</a></h2>
<p class="b_lineclamp4">ESP32-S3 is a dual-core Xtensa LX7 MCU with Wi-Fi and BLE.</p></li>
<li class="b_algo"><h2><a href="https://www.lcsc.com/product-detail/C114586.html">WS2812B datasheet - LCSC</a></h2>
<p class="b_lineclamp4">WS2812B intelligent control RGB LED.</p></li>
</body></html>`;

test('htmlToText：去脚本/样式/标签，保留可读文字并解码实体', () => {
  const text = htmlToText('<html><head><style>.a{color:red}</style></head><body><script>alert(1)</script><h1>WS2812B &amp; 数据手册</h1><p>电压&nbsp;5V</p></body></html>');
  assert.ok(text.includes('WS2812B & 数据手册'));
  assert.ok(text.includes('电压 5V'));
  assert.ok(!text.includes('alert'));
  assert.ok(!text.includes('color:red'));
  assert.equal(decodeHtmlEntities('&lt;a&gt; &#39;q&#39; &amp; &#x4E2D;'), "<a> 'q' & 中");
});

test('私有地址判定：IPv4/IPv6 常见网段', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.1.1', '192.168.1.1', '169.254.1.1', '0.0.0.0', '100.64.0.1', '224.0.0.1']) {
    assert.equal(isPrivateIpv4(ip.split('.').map(Number)), true, `${ip} 应判为私网/保留`);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '202.106.0.20']) assert.equal(isPrivateIpv4(ip.split('.').map(Number)), false, `${ip} 不应判为私网`);
  for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1']) assert.equal(isPrivateIpv6(ip), true, `${ip} 应判为私网`);
  assert.equal(isPrivateIpv6('2001:4860:4860::8888'), false);
});

test('assertPublicUrl：只放行公网 http(s)，拒绝本机/私网/凭据/非 http 协议', () => {
  for (const ok of ['https://www.lcsc.com/product-detail/C114586.html', 'http://example.com/x?y=1']) {
    assert.equal(assertPublicUrl(ok).hostname, new URL(ok).hostname);
  }
  const blocked = ['http://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.2/x', 'http://192.168.1.1/x', 'http://169.254.1.1/x', 'http://[::1]/x', 'http://foo.local/x', 'http://foo.internal/x', 'file:///etc/passwd', 'http://user:pass@example.com/x'];
  for (const url of blocked) {
    assert.throws(() => assertPublicUrl(url), (error) => error.code === RESEARCH_CODES.URL_BLOCKED || error.code === RESEARCH_CODES.URL_INVALID, `${url} 应被拒绝`);
  }
  assert.throws(() => assertPublicAddresses([{ address: '93.184.216.34' }, { address: '10.0.0.5' }]), (error) => error.code === RESEARCH_CODES.URL_BLOCKED);
});

test('parseDuckDuckGoResults：还原 uddg 重定向并提取标题/摘要', () => {
  const results = parseDuckDuckGoResults(DDG_HTML);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://www.lcsc.com/product-detail/C114586.html');
  assert.ok(results[0].title.includes('WS2812B'));
  assert.ok(results[0].snippet.includes('单线级联'));
});

test('parseDuckDuckGoResults：剔除广告/跟踪跳转链接', () => {
  const html = `<div><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;ad_provider=bingv7aa">广告结果</a>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.lcsc.com%2Fproduct-detail%2FC114586.html">正常结果</a></div>`;
  const results = parseDuckDuckGoResults(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://www.lcsc.com/product-detail/C114586.html');
});

test('parseBingResults：解析 b_algo 块', () => {
  const results = parseBingResults(BING_HTML);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://www.espressif.com/en/products/socs/esp32-s3');
  assert.ok(results[1].url.includes('C114586'));
});

test('searchWeb：DuckDuckGo 命中即返回来源/结果/digest', async () => {
  const calls = [];
  const result = await searchWeb({
    query: 'WS2812B datasheet',
    fetchImpl: async (url) => { calls.push(url); return responseOf(DDG_HTML); },
    resolveHost: PUBLIC_RESOLVE,
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'duckduckgo');
  assert.equal(result.results.length, 2);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.ok(result.fetchedAt);
  assert.ok(calls[0].includes('html.duckduckgo.com'));
  assert.ok(calls[0].startsWith('https://'));
});

test('searchWeb：首选源 0 结果时按顺序回退到 Bing，并记录 attempts', async () => {
  const calls = [];
  const result = await searchWeb({
    query: 'ESP32-S3 datasheet',
    fetchImpl: async (url) => {
      calls.push(url);
      return responseOf(/bing\.com/.test(url) ? BING_HTML : '<html><body>no results</body></html>');
    },
    resolveHost: PUBLIC_RESOLVE,
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'bing');
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].provider, 'duckduckgo');
  assert.equal(result.attempts[0].ok, false);
  assert.equal(result.attempts[1].ok, true);
});

test('searchWeb：全部源失败 → NO_RESULTS，不伪造结果', async () => {
  const result = await searchWeb({
    query: 'something',
    fetchImpl: async () => responseOf('<html><body>empty</body></html>'),
    resolveHost: PUBLIC_RESOLVE,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, RESEARCH_CODES.NO_RESULTS);
  assert.equal(result.results, undefined);
});

test('searchWeb：DNS 解析到私网 → URL_BLOCKED（防 DNS 指向内网）', async () => {
  const result = await searchWeb({
    query: 'test',
    fetchImpl: async () => responseOf(DDG_HTML),
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, RESEARCH_CODES.URL_BLOCKED);
});

test('searchWeb：输入校验（空/超长/非法源/结果数）', async () => {
  const badQuery = await searchWeb({ query: 'a', fetchImpl: async () => responseOf(DDG_HTML), resolveHost: PUBLIC_RESOLVE });
  assert.equal(badQuery.code, RESEARCH_CODES.INPUT_INVALID);
  const tooLong = await searchWeb({ query: 'x'.repeat(201), fetchImpl: async () => responseOf(DDG_HTML), resolveHost: PUBLIC_RESOLVE });
  assert.equal(tooLong.code, RESEARCH_CODES.INPUT_INVALID);
  const badProvider = await searchWeb({ query: 'abc', provider: 'google', fetchImpl: async () => responseOf(DDG_HTML), resolveHost: PUBLIC_RESOLVE });
  assert.equal(badProvider.code, RESEARCH_CODES.INPUT_INVALID);
  const badLimit = await searchWeb({ query: 'abc', limit: 99, fetchImpl: async () => responseOf(DDG_HTML), resolveHost: PUBLIC_RESOLVE });
  assert.equal(badLimit.code, RESEARCH_CODES.INPUT_INVALID);
});

test('fetchPage：抓取公网 HTML 并转纯文本，带 digest 与最终 URL', async () => {
  const page = await fetchPage({
    url: 'https://www.lcsc.com/product-detail/C114586.html',
    fetchImpl: async () => responseOf('<html><body><script>x()</script><h1>WS2812B</h1><p>5V RGB LED</p></body></html>', { url: 'https://www.lcsc.com/product-detail/C114586.html' }),
    resolveHost: PUBLIC_RESOLVE,
  });
  assert.equal(page.ok, true);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('WS2812B'));
  assert.ok(page.text.includes('5V RGB LED'));
  assert.ok(!page.text.includes('x()'));
  assert.match(page.digest, /^[a-f0-9]{64}$/);
  assert.equal(page.finalUrl, 'https://www.lcsc.com/product-detail/C114586.html');
});

test('fetchPage：302 跳转到私网被拒绝（重定向后复检）', async () => {
  const page = await fetchPage({
    url: 'https://example.com/x',
    fetchImpl: async () => responseOf('internal', { url: 'http://127.0.0.1/secret' }),
    resolveHost: PUBLIC_RESOLVE,
  });
  assert.equal(page.ok, false);
  assert.equal(page.code, RESEARCH_CODES.URL_BLOCKED);
});

test('fetchPage：PDF / 超大响应 / 非 http 分别 fail-closed', async () => {
  const pdf = await fetchPage({ url: 'https://example.com/a.pdf', fetchImpl: async () => responseOf('%PDF-1.7', { contentType: 'application/pdf' }), resolveHost: PUBLIC_RESOLVE });
  assert.equal(pdf.code, RESEARCH_CODES.CONTENT_UNSUPPORTED);
  const big = await fetchPage({ url: 'https://example.com/big', maxBytes: 10, fetchImpl: async () => responseOf('x'.repeat(100), { contentType: 'text/plain' }), resolveHost: PUBLIC_RESOLVE });
  assert.equal(big.code, RESEARCH_CODES.RESPONSE_TOO_LARGE);
  const file = await fetchPage({ url: 'file:///etc/passwd' });
  assert.equal(file.code, RESEARCH_CODES.URL_BLOCKED);
});

test('fetchPage：HTTP 失败与超时都返回原因码，不抛栈', async () => {
  const http = await fetchPage({ url: 'https://example.com/x', fetchImpl: async () => responseOf('nope', { status: 500 }), resolveHost: PUBLIC_RESOLVE });
  assert.equal(http.code, RESEARCH_CODES.HTTP_ERROR);
  const timeout = await fetchPage({ url: 'https://example.com/x', fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, resolveHost: PUBLIC_RESOLVE });
  assert.equal(timeout.code, RESEARCH_CODES.TIMEOUT);
});
