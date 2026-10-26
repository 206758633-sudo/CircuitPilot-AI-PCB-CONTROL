import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalStore, DesignManager, documentSourceDigest, normalizePlan, wireOperationMatches } from '../design.mjs';

const completePlan = {
  blocks: Object.fromEntries(['mcu', 'power', 'led', 'button'].map((id) => [id, { libraryUuid: `lib-${id}`, uuid: `dev-${id}`, value: id }])),
  nets: ['3V3', 'GND'],
  operations: [{ type: 'component.create', args: { component: { libraryUuid: 'lib-mcu', uuid: 'dev-mcu' }, x: 10, y: 20 } }],
};

test('plan normalization is deterministic and blocks unknown parts or arbitrary operations', () => {
  const first = normalizePlan(completePlan);
  const second = normalizePlan({ ...completePlan, title: 'MCU + 电源 + LED + 按键简单控制板' });
  assert.equal(first.ready, true);
  assert.equal(first.planHash, second.planHash);
  const blocked = normalizePlan({ ...completePlan, blocks: { ...completePlan.blocks, mcu: null }, operations: [{ type: 'javascript.eval', args: {} }] });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.missing.includes('mcu:未提供'));
  assert.ok(blocked.missing.includes('unsupported-operation:javascript.eval'));
});

test('approval tokens are bound, expire, and cannot be replayed', () => {
  let now = 1_000;
  const approvals = new ApprovalStore({ ttlMs: 100, now: () => now });
  const issued = approvals.issue({ planHash: 'plan', targetFingerprint: 'target', windowId: 'window', steps: ['write'] });
  assert.throws(() => approvals.consume(issued.token, { planHash: 'tampered', targetFingerprint: 'target', windowId: 'window' }), { code: 'APPROVAL_MISMATCH' });
  approvals.consume(issued.token, { planHash: 'plan', targetFingerprint: 'target', windowId: 'window' });
  assert.throws(() => approvals.consume(issued.token, { planHash: 'plan', targetFingerprint: 'target', windowId: 'window' }), { code: 'APPROVAL_REPLAYED' });
  const expiring = approvals.issue({ planHash: 'plan', targetFingerprint: 'target', windowId: 'window', steps: [] });
  now = 1_101;
  assert.throws(() => approvals.consume(expiring.token, { planHash: 'plan', targetFingerprint: 'target', windowId: 'window' }), { code: 'APPROVAL_EXPIRED' });
});

test('document digest ignores EasyEDA save metadata but detects design changes', () => {
  const a = 'HEAD||{"docType":"SCH_PAGE","client":"aaa","updateTime":1,"version":"1"}||BODY-A';
  const b = 'HEAD||{"docType":"SCH_PAGE","client":"bbb","updateTime":2,"version":"2"}||BODY-A';
  assert.equal(documentSourceDigest(a), documentSourceDigest(b));
  assert.notEqual(documentSourceDigest(a), documentSourceDigest(b.replace('BODY-A', 'BODY-B')));
});

test('wire readback accepts merged paths by net and exact segment geometry', () => {
  const operation = { type: 'wire.create', args: { net: '+5V', line: [45, 155, 130, 155, 130, 200] } };
  assert.equal(wireOperationMatches(operation, [{ net: '+5V', line: [160, 200, 130, 200, 130, 155, 45, 155] }]), true);
  assert.equal(wireOperationMatches({ type: 'wire.create', args: { net: '+5V', line: [160, 180, 160, 200] } }, [{ net: '+5V', line: [160, 160, 160, 220] }]), true);
  assert.equal(wireOperationMatches(operation, [{ net: '+5V', line: [45, 155, 130, 155] }]), false);
  assert.equal(wireOperationMatches(operation, [{ net: 'GND', line: [45, 155, 130, 155, 130, 200] }]), false);
});

test('mutated execution restores and verifies source when official DRC fails', async () => {
  let source = 'before-source';
  const bridge = {
    selectedWindowId: 'window-1',
    listCommands() { return ['document.source.read', 'document.source.restore', 'schematic.component.create', 'schematic.pin.noConnect', 'schematic.netFlag.create', 'schematic.wire.create', 'schematic.wire.read', 'schematic.save', 'schematic.drc'].map((id) => ({ id })); },
    async execute(id, args) {
      if (id === 'project.current') return { id: 'project-1' };
      if (id === 'document.current') return { id: 'document-1', type: 'schematic' };
      if (id === 'schematic.catalog') return { pages: [{ id: 'page-1' }] };
      if (id === 'schematic.components') return { components: source === 'after-source' ? [{ primitiveId: 'P1' }] : [], pins: {} };
      if (id === 'schematic.wires') return [];
      if (id === 'document.source.read') return source;
      if (id === 'schematic.component.create') { source = 'after-source'; return { primitiveId: 'P1' }; }
      if (id === 'schematic.wire.read') return [];
      if (id === 'schematic.save') return true;
      if (id === 'schematic.drc') return [{ rule: 'unconnected' }];
      if (id === 'document.source.restore') { source = args.source; return true; }
      throw new Error(`unexpected ${id}`);
    },
  };
  const manager = new DesignManager({ bridge });
  const context = await manager.context();
  const approval = manager.approve({ plan: completePlan, targetFingerprint: context.targetFingerprint, windowId: 'window-1' });
  const result = await manager.execute({ plan: completePlan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: 'window-1' });
  assert.equal(result.state, 'rolled_back');
  assert.equal(result.error.code, 'DRC_FAILED');
  assert.equal(source, 'before-source');
  assert.equal(result.snapshot.source, undefined);
});

test('pin.noConnect resolves only a component created by the approved plan and verifies pin state', async () => {
  let source = 'before-source';
  const plan = { ...completePlan, operations: [
    completePlan.operations[0],
    { type: 'pin.noConnect', args: { componentOperationIndex: 0, pinNumbers: ['2', '3'] } },
  ] };
  const bridge = {
    selectedWindowId: 'window-1',
    listCommands() { return ['document.source.read', 'document.source.restore', 'schematic.component.create', 'schematic.pin.noConnect', 'schematic.netFlag.create', 'schematic.wire.create', 'schematic.wire.read', 'schematic.save', 'schematic.drc'].map((id) => ({ id })); },
    async execute(id, args) {
      if (id === 'project.current') return { id: 'project-1' };
      if (id === 'document.current') return { id: 'document-1', type: 'schematic' };
      if (id === 'schematic.catalog') return { pages: [{ id: 'page-1' }] };
      if (id === 'schematic.components') return source === 'after-source' ? { components: [{ primitiveId: 'P1' }], pins: { P1: [{ pinNumber: '2', noConnected: true }, { pinNumber: '3', noConnected: true }] } } : { components: [], pins: {} };
      if (id === 'schematic.wires' || id === 'schematic.wire.read') return [];
      if (id === 'document.source.read') return source;
      if (id === 'schematic.component.create') { source = 'after-source'; return { primitiveId: 'P1' }; }
      if (id === 'schematic.pin.noConnect') { assert.equal(args.componentPrimitiveId, 'P1'); return { componentPrimitiveId: 'P1', pinNumbers: ['2', '3'] }; }
      if (id === 'schematic.save') return true;
      if (id === 'schematic.drc') return [];
      throw new Error(`unexpected ${id}`);
    },
  };
  const manager = new DesignManager({ bridge });
  const context = await manager.context();
  const approval = manager.approve({ plan, targetFingerprint: context.targetFingerprint, windowId: 'window-1' });
  const result = await manager.execute({ plan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: 'window-1' });
  assert.equal(result.state, 'completed');
  assert.equal(result.events.find((event) => event.stage === 'readback').detail.verifiedNoConnectPins, 2);
});
