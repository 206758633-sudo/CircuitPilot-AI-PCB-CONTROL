import test from 'node:test';
import assert from 'node:assert/strict';
import { compileReviewedNetlist, normalizeReviewedNetlist } from '../netlist.mjs';

const fixture = {
  title: 'AI测试板',
  components: [
    { ref: 'U1', value: 'CH32V003', libraryUuid: 'lib-u1', uuid: 'dev-u1' },
    { ref: 'R1', value: '1k', libraryUuid: 'lib-r1', uuid: 'dev-r1' },
  ],
  nets: [{ name: 'LED', endpoints: [{ ref: 'U1', pin: '1' }, { ref: 'R1', pin: '1' }] }],
};

test('reviewed netlist compiles deterministically to allowlisted schematic operations', () => {
  const first = compileReviewedNetlist(fixture);
  const second = compileReviewedNetlist(fixture);
  assert.equal(first.ready, true);
  assert.equal(first.planHash, second.planHash);
  assert.deepEqual(first.plan.operations.map((item) => item.type), ['component.create', 'component.create', 'net.connect']);
  assert.deepEqual(first.plan.operations[2].args.endpoints, [{ componentOperationIndex: 0, pinNumber: '1' }, { componentOperationIndex: 1, pinNumber: '1' }]);
});

test('reviewed netlist blocks unknown references and missing exact library identities', () => {
  const result = normalizeReviewedNetlist({ components: [{ ref: 'U1' }], nets: [{ name: 'VCC', endpoints: [{ ref: 'U1', pin: '1' }, { ref: 'X1', pin: '' }] }] });
  assert.equal(result.ready, false);
  assert.ok(result.missing.some((item) => item.includes('嘉立创EDA器件身份')));
  assert.ok(result.missing.some((item) => item.includes('未知位号X1')));
  assert.ok(result.missing.some((item) => item.includes('缺少引脚号')));
});
