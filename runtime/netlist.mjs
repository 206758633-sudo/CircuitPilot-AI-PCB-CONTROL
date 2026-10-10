import { digest } from './design.mjs';

const str = (v, n = 160) => String(v ?? '').trim().slice(0, n);
const list = (v, n) => Array.isArray(v) ? v.slice(0, n) : [];

export function normalizeReviewedNetlist(input = {}) {
  const components = list(input.components, 250).map((item) => ({
    ref: str(item.ref, 80).toUpperCase(), value: str(item.value, 120),
    libraryUuid: str(item.libraryUuid), uuid: str(item.uuid),
  }));
  const nets = list(input.nets, 500).map((item) => ({
    name: str(item.name, 120), endpoints: list(item.endpoints, 64).map((endpoint) => ({ ref: str(endpoint.ref, 80).toUpperCase(), pin: str(endpoint.pin, 30) })),
  }));
  const normalized = { kind: 'reviewed-netlist', title: str(input.title, 200) || '已审核项目网络表', components, nets, assumptions: list(input.assumptions, 30).map((v) => str(v, 400)) };
  const missing = [];
  const refs = new Set();
  components.forEach((item, index) => {
    if (!item.ref || refs.has(item.ref)) missing.push(`components.${index}:位号缺失或重复`);
    refs.add(item.ref);
    if (!item.libraryUuid || !item.uuid) missing.push(`${item.ref || index}:嘉立创EDA器件身份`);
  });
  nets.forEach((net, index) => {
    if (!net.name || net.endpoints.length < 2) missing.push(`nets.${index}:至少两个端点`);
    net.endpoints.forEach((endpoint) => {
      if (!refs.has(endpoint.ref)) missing.push(`${net.name}:未知位号${endpoint.ref}`);
      if (!endpoint.pin) missing.push(`${net.name}:${endpoint.ref}缺少引脚号`);
    });
  });
  if (!components.length) missing.push('components');
  if (!nets.length) missing.push('nets');
  return { netlist: normalized, missing: [...new Set(missing)], ready: missing.length === 0, netlistHash: digest(normalized) };
}

export function compileReviewedNetlist(input = {}) {
  const checked = normalizeReviewedNetlist(input);
  if (!checked.ready) return { ...checked, plan: null, planHash: null };
  const operationIndex = new Map();
  const operations = [];
  checked.netlist.components.forEach((item, index) => {
    const column = index % 4; const row = Math.floor(index / 4);
    operationIndex.set(item.ref, operations.length);
    operations.push({ type: 'component.create', args: { component: { libraryUuid: item.libraryUuid, uuid: item.uuid }, x: 120 + column * 220, y: 120 + row * 170, addIntoBom: true, addIntoPcb: true } });
  });
  checked.netlist.nets.forEach((net) => operations.push({ type: 'net.connect', args: { net: net.name, endpoints: net.endpoints.map((endpoint) => ({ componentOperationIndex: operationIndex.get(endpoint.ref), pinNumber: endpoint.pin })) } }));
  const plan = { apiVersion: 1, kind: 'reviewed-netlist', title: checked.netlist.title, nets: checked.netlist.nets.map((item) => item.name), operations, assumptions: checked.netlist.assumptions };
  return { ...checked, plan, planHash: digest(plan) };
}
