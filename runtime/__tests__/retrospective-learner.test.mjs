import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeStore } from '../knowledge.mjs';
import { createEvidenceStore } from '../evidence-store.mjs';
import {
  RETRO_CODES,
  RETRO_EVIDENCE_KINDS,
  collectRetroFacts,
  buildLessonDraftPrompt,
  createRetrospectiveLearner,
  buildExperienceBundle,
  experienceBundlePreview,
  deriveRetroCandidates,
  mergeRetroDefects,
  extractDefects,
  normalizeLessons,
  projectKeyOf,
} from '../agents/retrospective-learner.mjs';

const env = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rla-'));
  return {
    dir,
    store: createKnowledgeStore({ root: join(dir, 'knowledge'), now: () => new Date('2026-10-29T08:00:00.000Z') }),
    evidenceStore: createEvidenceStore({ root: join(dir, 'evidence'), now: () => new Date('2026-10-29T08:00:00.000Z') }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const evidence = (kind, verdict, findings = [], extra = {}) => ({
  kind, digest: `${kind}-${verdict}-${findings.map((item) => item.code).join('-') || 'none'}`.padEnd(24, '0'),
  savedAt: '2026-10-29T07:00:00.000Z', fingerprint: { pcbUuid: 'pcb-1' },
  payload: { verdict, findings, ...extra },
});

const lessonFailure = {
  kind: 'failure', title: '复盘中发现的 48V 缓启动缺失', symptom: '上电瞬间输入电流冲击导致保险丝慢断',
  rootCause: '输入电容无 NTC/缓启动，浪涌未限制', detection: '示波器测输入电流尖峰', prevention: ['加 NTC 或缓启动 MOSFET', '输入电容 ≥100µF 时必做浪涌评估'],
};
const lessonRule = {
  kind: 'rule', title: '24V 以上输入必须评估浪涌', statement: '输入电压 ≥24V 且电容 ≥100µF 时，必须做上电浪涌评估并给出限流措施。',
  limits: ['输入 ≥24V', 'Cin ≥100µF', '峰值电流 ≤ 保险丝额定 2 倍'], check: '上电示波器测输入电流峰值', category: '电源/保护',
};
const lessonModule = {
  kind: 'module', title: '双电池无缝切换：二极管 OR + 优先级充电', purpose: '两路电池并联供电时避免反灌并保持切换无缝。',
  whenToUse: '双电池/备份电源；需要主备自动切换且不允许断电。', designPoints: ['理想二极管 OR 或 PMOS 自动切换', '两路电池各自限流/充电优先级', '切换点加 TVS 与去耦'],
  keyParameters: ['切换压差 ≤0.3V', 'OR 管 Vf 越低越好'], pitfalls: ['共地用单点连接避免地环流'],
};

test('projectKeyOf：项目/板号/UUID 回退，非法字符归一化', () => {
  assert.equal(projectKeyOf({ projectId: 'DBTS-A01 双电池' }), 'dbts-a01');
  assert.equal(projectKeyOf({ boardId: 'PCB 1_1' }), 'pcb-1-1');
  assert.equal(projectKeyOf({ pcbUuid: '084751e2c073fcf2' }), '084751e2c073fcf2');
  assert.equal(projectKeyOf({}), 'unspecified');
});

test('extractDefects：blocked/unknown 的 error findings 归并去重；pass/warning 不产缺陷', () => {
  const files = [
    evidence('rules', 'blocked', [{ code: 'DRC_CLEARANCE', severity: 'error', message: '间距 0.15mm < 0.2mm' }]),
    evidence('rules', 'blocked', [{ code: 'DRC_CLEARANCE', severity: 'error', message: '间距 0.15mm < 0.2mm' }, { code: 'SILK_OVERLAP', severity: 'warning', message: '丝印重叠' }]),
    evidence('netlist-diff', 'unknown', [{ code: 'NET_MISSING', severity: 'error', message: 'GND 少连接 2 个引脚' }]),
    evidence('dfm-evidence', 'pass', [{ code: 'DFM_WARN', severity: 'warning', message: '仅提示' }]),
    evidence('signoff', 'pass', []),
    evidence('rules', 'blocked', [], { reason: '规则引擎不可用' }),
  ];
  const { defects, warningCount } = extractDefects({ evidence: files });
  const codes = defects.map((item) => item.code);
  assert.deepEqual(codes, ['DRC_CLEARANCE', 'NET_MISSING', 'RULES_BLOCKED']);
  const clearance = defects.find((item) => item.code === 'DRC_CLEARANCE');
  assert.equal(clearance.occurrences, 2);
  assert.deepEqual(clearance.evidenceKinds, ['rules']);
  assert.equal(warningCount, 2);
  assert.ok(RETRO_EVIDENCE_KINDS.includes('fabrication-release'));
});

test('normalizeLessons：缺症状/缺数值边界/缺目的的经验被拒绝并给行号', () => {
  const bad = normalizeLessons({ lessons: [
    { kind: 'failure', title: '无症状' },
    { kind: 'rule', title: '无边界', statement: '应该加宽走线' },
    { kind: 'module', title: '无目的' },
    { kind: 'weird', title: 'x' },
  ] });
  assert.equal(bad.lessons.length, 0);
  assert.equal(bad.problems.length, 4);
  assert.deepEqual(bad.problems.map((item) => item.code), ['LESSON_SYMPTOM_MISSING', 'LESSON_LIMITS_MISSING', 'LESSON_PURPOSE_MISSING', 'LESSON_KIND_INVALID']);
  const good = normalizeLessons({ lessons: [lessonFailure, lessonRule, lessonModule] });
  assert.equal(good.problems.length, 0);
  assert.deepEqual(good.lessons.map((item) => item.kind), ['failure', 'rule', 'module']);
});

test('deriveRetroCandidates：项目复盘 module + 缺陷 failure + 三类经验条目，id 确定性', () => {
  const facts = collectRetroFacts({
    projectId: 'dbts-a01', boardId: 'PCB1', pcbUuid: 'pcb-1', projectName: 'DBTS-A01',
    evidence: [evidence('rules', 'blocked', [{ code: 'DRC_CLEARANCE', severity: 'error', message: '间距不足' }])],
    release: { releaseId: 'rel-1', gateVerdict: 'blocked', decision: 'draft' },
    changes: [{ summary: 'C39 抬高 20mm' }],
    docRefs: ['docs/pcb-layout/06-踩坑台账.md'],
  });
  const candidates = deriveRetroCandidates({ facts, lessons: normalizeLessons({ lessons: [lessonFailure, lessonRule, lessonModule] }).lessons });
  assert.deepEqual(candidates.map((item) => item.kind), ['module', 'failure', 'failure', 'rule', 'module']);
  assert.equal(candidates[0].payload.moduleId, 'RETRO-dbts-a01-PROJECT');
  assert.equal(candidates[0].payload.category, '项目复盘');
  assert.ok(candidates[0].payload.pitfalls.some((item) => item.includes('DRC_CLEARANCE')));
  const defectFailure = candidates[1];
  assert.equal(defectFailure.payload.failureId, 'RETRO-dbts-a01-DRC-CLEARANCE');
  assert.equal(defectFailure.payload.needsInvestigation, true);
  assert.equal(defectFailure.payload.rootCause, null, '没有根因不许编造');
  assert.equal(candidates[3].payload.ruleId, 'RETRO-dbts-a01-R01');
  assert.deepEqual(candidates[3].payload.limits, lessonRule.limits);
  assert.equal(candidates[4].payload.moduleId, 'RETRO-dbts-a01-M01');
  // 同样的输入必须给同样的 payload（否则重复运行会不断产生新版本，无法去重）
  const again = deriveRetroCandidates({ facts: collectRetroFacts({
    projectId: 'dbts-a01', boardId: 'PCB1', pcbUuid: 'pcb-1', projectName: 'DBTS-A01',
    evidence: [evidence('rules', 'blocked', [{ code: 'DRC_CLEARANCE', severity: 'error', message: '间距不足' }])],
    release: { releaseId: 'rel-1', gateVerdict: 'blocked', decision: 'draft' },
    changes: [{ summary: 'C39 抬高 20mm' }],
    docRefs: ['docs/pcb-layout/06-踩坑台账.md'],
  }), lessons: normalizeLessons({ lessons: [lessonFailure, lessonRule, lessonModule] }).lessons });
  assert.deepEqual(candidates.map((item) => item.payload), again.map((item) => item.payload));
});

test('RLA：没有事实也没有经验 → RETRO_NO_EVIDENCE，不写任何条目/证据', () => {
  const { store, evidenceStore, cleanup } = env();
  try {
    const agent = createRetrospectiveLearner({ store, evidenceStore });
    assert.throws(() => agent.run({ projectId: 'p1' }), (error) => error.code === RETRO_CODES.NO_EVIDENCE);
    assert.equal(store.list({ includeExpired: true }).length, 0);
    assert.deepEqual(evidenceStore.list('retrospective'), []);
    const safe = agent.runSafely({ projectId: 'p1' });
    assert.equal(safe.ok, false);
    assert.equal(safe.code, RETRO_CODES.NO_EVIDENCE);
    assert.equal(agent.status().lastRun.code, RETRO_CODES.NO_EVIDENCE);
  } finally { cleanup(); }
});

test('RLA：证据 + 经验 → 只写 candidate + retrospective 证据；重复运行幂等', () => {
  const { store, evidenceStore, cleanup } = env();
  try {
    const agent = createRetrospectiveLearner({ store, evidenceStore });
    const input = {
      projectId: 'dbts-a01', boardId: 'PCB1', pcbUuid: 'pcb-1', projectName: 'DBTS-A01',
      evidence: [evidence('rules', 'blocked', [{ code: 'DRC_CLEARANCE', severity: 'error', message: '间距不足' }])],
      release: { releaseId: 'rel-1', gateVerdict: 'blocked', decision: 'draft' },
      lessons: [lessonFailure, lessonRule, lessonModule],
      docRefs: ['docs/pcb-layout/06-踩坑台账.md'],
    };
    const first = agent.run(input);
    assert.equal(first.ok, true);
    assert.equal(first.summary.total, 5);
    assert.equal(first.summary.created, 5);
    assert.equal(first.summary.duplicates, 0);
    assert.ok(first.evidencePath && first.evidencePath.includes('retrospective-'));
    const entries = store.list({ includeExpired: true });
    assert.equal(entries.length, 5);
    assert.ok(entries.every((entry) => entry.review.state === 'candidate'), '绝不自动 approved');
    assert.ok(entries.every((entry) => entry.provenance.source === 'retrospective'));
    assert.ok(entries.every((entry) => store.isUsableForGate(entry) === false), 'candidate 不能当门禁依据');

    const second = agent.run(input);
    assert.equal(second.summary.created, 0);
    assert.equal(second.summary.duplicates, 5);
    assert.equal(store.list({ includeExpired: true }).length, 5, '同内容不新增版本');
    assert.equal(evidenceStore.list('retrospective').length, 2, '每轮复盘都留一份证据');
    assert.deepEqual(agent.status().totals, { runs: 2, created: 5 });
    const record = JSON.parse(JSON.stringify(agent.status().lastRun));
    assert.equal(record.ok, true);
  } finally { cleanup(); }
});

test('RLA：经验不合法 → LESSON_INVALID，且不写半套候选', () => {
  const { store, evidenceStore, cleanup } = env();
  try {
    const agent = createRetrospectiveLearner({ store, evidenceStore });
    assert.throws(
      () => agent.run({ projectId: 'p1', evidence: [evidence('rules', 'blocked', [{ code: 'X', severity: 'error', message: 'm' }])], lessons: [{ kind: 'rule', title: '无边界' }] }),
      (error) => error.code === RETRO_CODES.LESSON_INVALID && error.details.length === 1,
    );
    assert.equal(store.list({ includeExpired: true }).length, 0);
    assert.deepEqual(evidenceStore.list('retrospective'), []);
  } finally { cleanup(); }
});

test('RLA：只有 warning 不算可复盘事实（不生成空 failure）', () => {
  const { store, evidenceStore, cleanup } = env();
  try {
    const agent = createRetrospectiveLearner({ store, evidenceStore });
    assert.throws(
      () => agent.run({ projectId: 'p1', evidence: [evidence('dfm-evidence', 'pass', [{ code: 'DFM_WARN', severity: 'warning', message: '仅提示' }])] }),
      (error) => error.code === RETRO_CODES.NO_EVIDENCE,
    );
  } finally { cleanup(); }
});

test('RLA：写盘点（status）声明能力边界，不声明 approved/写设计', () => {
  const { store, cleanup } = env();
  try {
    const status = createRetrospectiveLearner({ store }).status();
    assert.equal(status.agent, 'retrospective-learner');
    assert.ok(status.writes.includes('knowledge:candidate'));
    assert.ok(status.never.includes('knowledge:approved'));
    assert.ok(status.never.includes('eda:write'));
    assert.deepEqual(status.lessonKinds, ['failure', 'rule', 'module']);
  } finally { cleanup(); }
});

test('AI 起草的经验：进库 trust=unverified，人工经验 trust=reference', () => {
  const { store, evidenceStore, cleanup } = env();
  try {
    const agent = createRetrospectiveLearner({ store, evidenceStore });
    const run = agent.run({
      projectId: 'p-ai',
      lessons: [
        { ...lessonFailure, title: 'AI 起草：上电浪涌', origin: 'ai' },
        { ...lessonRule, origin: 'human' },
      ],
    });
    const aiEntry = store.list({ includeExpired: true }).find((entry) => entry.title === 'AI 起草：上电浪涌');
    const humanEntry = store.list({ includeExpired: true }).find((entry) => entry.title === lessonRule.title);
    assert.equal(aiEntry.trust, 'unverified');
    assert.equal(humanEntry.trust, 'reference');
    assert.ok(store.isUsableForGate(aiEntry) === false);
    assert.equal(run.lessons.byKind.rule, 1);
    assert.ok(JSON.stringify(run.candidates.map((item) => item.kind)).includes('failure'));
  } finally { cleanup(); }
});

test('buildLessonDraftPrompt：把事实与"不得编造"约束写进提示词，不泄漏无关字段', () => {
  const facts = collectRetroFacts({ projectId: 'p1', evidence: [evidence('rules', 'blocked', [{ code: 'X', severity: 'error', message: 'm' }])], notes: '备注' });
  const prompt = buildLessonDraftPrompt({ facts, maxLessons: 4 });
  assert.ok(prompt.includes('1~4 条'));
  assert.ok(prompt.includes('不得编造'));
  assert.ok(prompt.includes('evidenceDigests'));
  assert.ok(prompt.includes('facts'));
  assert.ok(prompt.includes('X'));
});

test('mergeRetroDefects：同缺陷码跨 2 个项目才合并成一条候选，重复运行幂等', () => {
  const { store, cleanup } = env();
  try {
    // 造两个项目的复盘候选（直接走 store，等价于两次 RLA run）
    const saveOne = (projectKey, code) => store.save({
      kind: 'failure',
      title: `复盘缺陷：${code}（${projectKey}）`,
      payload: {
        failureId: `RETRO-${projectKey}-${code}`, projectKey, code, category: '复盘缺陷', severity: 'error',
        symptom: `症状-${projectKey}`, rootCause: null, detection: '复盘', prevention: [],
        occurrences: 1, evidenceRefs: [`digest-${projectKey}`], needsInvestigation: true, source: 'retrospective',
      },
      provenance: { source: 'retrospective', version: '1.0.0', fetchedAt: '2026-10-29T08:00:00.000Z', collector: 'retrospective-learner' },
      trust: 'reference', ttlDays: 365, reviewState: 'candidate',
    });
    saveOne('proj-a', 'DRC_CLEARANCE');
    saveOne('proj-b', 'DRC_CLEARANCE');
    saveOne('proj-a', 'ONLY_A');
    const first = mergeRetroDefects({ store });
    assert.equal(first.groups, 1);
    assert.equal(first.created, 1);
    const merged = first.candidates[0];
    assert.equal(merged.entityKey, 'RETRO-CODE-DRC-CLEARANCE');
    assert.deepEqual(merged.projects, ['proj-a', 'proj-b']);
    const entry = store.list({ includeExpired: true }).find((item) => item.entityKey === 'RETRO-CODE-DRC-CLEARANCE');
    assert.equal(entry.review.state, 'candidate');
    assert.equal(entry.payload.rootCause, null);
    assert.equal(entry.payload.needsInvestigation, true);
    assert.deepEqual(entry.payload.projectKeys, ['proj-a', 'proj-b']);
    const second = mergeRetroDefects({ store });
    assert.equal(second.created, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(store.list({ includeExpired: true }).filter((item) => item.entityKey === 'RETRO-CODE-DRC-CLEARANCE').length, 1);
  } finally { cleanup(); }
});

test('buildExperienceBundle：默认脱敏（ID 只给哈希、message 丢弃、路径/邮箱被擦），哈希稳定', () => {
  const facts = collectRetroFacts({
    projectId: 'p-secret', boardId: 'PCB1', pcbUuid: 'uuid-secret', projectName: '某客户 48V 板',
    evidence: [evidence('rules', 'blocked', [{ code: 'ERC_ERROR', severity: 'error', message: 'C39 与 NET_VBAT 短路，见 /Users/alice/Desktop/x.kicad_pcb' }])],
    notes: '联系 alice@example.com 确认',
  });
  const lessons = normalizeLessons({ lessons: [lessonFailure] }).lessons;
  const bundle = buildExperienceBundle({ facts, lessons, note: '由 /Users/alice/secret 导出' });
  const text = JSON.stringify(bundle);
  assert.equal(bundle.kind, 'circuitpilot-experience-bundle');
  assert.equal(bundle.project.projectName, null);
  assert.match(bundle.project.projectKeyHash, /^[a-f0-9]{12}$/);
  assert.match(bundle.project.boardIdHash, /^[a-f0-9]{12}$/);
  assert.equal(bundle.facts.defects[0].message, null);
  assert.equal(bundle.facts.notes, null);
  assert.ok(!text.includes('/Users/alice'), '本机路径必须被擦除');
  assert.ok(!text.includes('alice@example.com'), '邮箱必须被擦除');
  assert.ok(!text.includes('uuid-secret'));
  assert.ok(!text.includes('某客户 48V 板'));
  assert.match(bundle.bundleSha256, /^[a-f0-9]{64}$/);
  assert.equal(bundle.bytes > 0, true);
  // 同内容两次导出哈希一致（createdAt 固定）
  const again = buildExperienceBundle({ facts, lessons, note: '由 /Users/alice/secret 导出', now: () => new Date(bundle.createdAt) });
  assert.equal(again.bundleSha256, bundle.bundleSha256);
  // 显式开启才带项目名/消息（且仍脱敏路径）
  const open = buildExperienceBundle({ facts, lessons, includeProjectName: true, includeMessages: true, note: null });
  assert.equal(open.project.projectName, '某客户 48V 板');
  assert.ok(open.facts.defects[0].message.includes('[REDACTED_USER]'), '用户名被擦除');
  assert.ok(open.facts.defects[0].message.includes('C39'), '缺陷正文里的位号保留（用户显式开启才导出）');
  assert.ok(!open.facts.defects[0].message.includes('/Users/alice'), '路径原文不出现');
  const preview = experienceBundlePreview(open);
  assert.equal(preview.defects, 1);
  assert.equal(preview.lessons, 1);
  assert.equal(preview.redaction.messages, 'redacted');
});
