#!/usr/bin/env node
/**
 * B9：真实接口替代候选探测（保存证据，false PASS 防护）。
 *
 * 判定（全部满足才算 ok）：
 *   1) HTTP 200 且 summary.requested > 0；
 *   2) 至少一条 found（真实检索有结果）；
 *   3) 每条候选都带 match='keyword' + equivalence='unverified'（关键词命中不得冒充等价替代）；
 *   4) 没有把失败/无效条目静默丢掉（summary 计数与 results 对齐）。
 *
 * 用法：node scripts/b9-alternatives-probe.mjs [--token x] [--base http://127.0.0.1:4179]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const base = flag('--base', process.env.CIRCUITPILOT_RUNTIME_URL || 'http://127.0.0.1:4179').replace(/\/$/, '');
const token = flag('--token', process.env.CIRCUITPILOT_RUNTIME_TOKEN || readFileSync('/tmp/cp_my_token.txt', 'utf8').trim());
const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': token, origin: 'http://127.0.0.1:4177' };
const body = {
  items: [
    { lcscId: 'C23186', mpn: '0603WAF5101T5E', value: '5.1k', package: '0603' },
    { lcscId: 'C6186', mpn: 'AMS1117-3.3', value: '3.3V', package: 'SOT-223' },
    { lcscId: 'C999999999', mpn: '', value: '' },
  ],
  maxCandidates: 3,
};
const response = await fetch(`${base}/api/supply/alternatives`, { method: 'POST', headers, body: JSON.stringify(body) });
const payload = await response.json().catch(() => ({ raw: 'unparsable' }));
const results = payload.results || [];
const candidates = results.flatMap((item) => item.candidates || []);
const summary = payload.summary || {};
const checks = {
  httpOk: response.status === 200 && payload.ok === true,
  hasFound: summary.found > 0,
  candidatesMarkedUnverified: candidates.length > 0 && candidates.every((item) => item.match === 'keyword' && item.equivalence === 'unverified'),
  candidatesHaveRealIds: candidates.every((item) => /^C\d+$/.test(item.lcscId)),
  summaryMatches: summary.requested === results.length && summary.candidates === candidates.length && summary.invalid === results.filter((item) => item.status === 'invalid').length,
};
const evidence = {
  schemaVersion: 1,
  kind: 'b9-supply-alternatives',
  at: new Date().toISOString(),
  request: body,
  httpStatus: response.status,
  summary,
  results,
  checks,
  ok: Object.values(checks).every(Boolean),
};
const dir = join(process.cwd(), 'artifacts/b9-alternatives');
mkdirSync(dir, { recursive: true });
const file = join(dir, `b9-alternatives-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`[b9] http=${response.status} found=${summary.found}/${summary.requested} candidates=${summary.candidates} invalid=${summary.invalid} failed=${summary.failed}`);
for (const item of results) console.log(`[b9] ${item.lcscId} q="${item.query}" ${item.status}`, (item.candidates || []).map((candidate) => `${candidate.lcscId}:${candidate.stock ?? '?'}`).join(','));
console.log(`[b9] 证据：${file}`);
if (!evidence.ok) { console.error(`[b9] 失败：${JSON.stringify(checks)}`); process.exit(1); }
