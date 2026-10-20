import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatManager } from '../chat.mjs';
import { ProductionManager } from '../production.mjs';

const plan = () => ({
  projectId: 'P1', title: 'memory board',
  board: { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 },
  constraints: { profileId: 'jlc-low-cost-2l', minClearanceMm: 0.2, minCopperToEdgeMm: 0.3 },
  components: [
    { ref: 'J1', primitiveId: 'C1', role: 'edge-connector', footprint: 'USB-C', lcscId: 'C165948', placement: { xMm: 2, yMm: 15, rotation: 90 }, sizeMm: { width: 2, height: 8 } },
    { ref: 'U1', primitiveId: 'C2', role: 'mcu', footprint: 'TSSOP-20', lcscId: 'C720477', placement: { xMm: 20, yMm: 15, rotation: 0 }, sizeMm: { width: 7, height: 7 } },
  ],
  nets: [{ name: 'VBUS', class: 'power', endpoints: [{ ref: 'J1', pin: 'A4', xMm: 3, yMm: 15 }, { ref: 'U1', pin: 'VDD', xMm: 16, yMm: 15 }] }],
  evidence: [{ kind: 'eda-context', digest: 'abc' }], decisions: [{ key: 'board', approved: true }],
});

test('H4：终审记录有上限（内存不会随反复签核无限增长）', () => {
  const manager = new ProductionManager({ artifactsRoot: process.cwd(), pcb: { get: (id) => (id === 'exec-1' ? { id: 'exec-1' } : undefined) }, maxStoredReviews: 3 });
  const compiled = manager.compile(plan());
  for (let index = 0; index < 5; index += 1) {
    manager.finalReview({ semanticPlanHash: compiled.planHash, compiledPlanHash: compiled.compiledPlanHash, pcbExecutionId: 'exec-1', manifestHash: `manifest-${index}` });
  }
  assert.equal(manager.reviews.size, 3);
  const hashes = [...manager.reviews.values()].map((item) => item.manifestHash);
  assert.deepEqual(hashes, ['manifest-2', 'manifest-3', 'manifest-4']);
});

test('H4：聊天线程会话映射有上限，淘汰只丢映射不丢 transcript 文件', () => {
  const saved = [];
  const transcriptStore = { load: () => ({ data: { sessions: {} } }), save: (data) => saved.push(data) };
  const manager = new ChatManager({ maxSessions: 3, transcriptStore });
  for (let index = 0; index < 5; index += 1) manager.rememberSession(`chat-p${index}`, `thread-${index}`);
  assert.equal(manager.sessions.size, 3);
  assert.deepEqual([...manager.sessions.keys()], ['chat-p2', 'chat-p3', 'chat-p4']);
});

test('H4：transcript 会话表按 updatedAt 淘汰（最多 50 个会话）', () => {
  const store = new Map();
  const transcriptStore = { load: () => ({ data: { sessions: Object.fromEntries(store) } }), save: (data) => { store.clear(); for (const [key, value] of Object.entries(data.sessions)) store.set(key, value); } };
  const manager = new ChatManager({ transcriptStore });
  for (let index = 0; index < 55; index += 1) manager.appendTranscript(`chat-${String(index).padStart(2, '0')}`, [{ role: 'user', content: 'hi' }]);
  assert.equal(store.size, 50);
  assert.ok(store.has('chat-54'));
  assert.ok(!store.has('chat-00'), '最旧的会话应被淘汰');
});
