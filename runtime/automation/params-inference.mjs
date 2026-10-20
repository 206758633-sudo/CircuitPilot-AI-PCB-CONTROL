/**
 * E10.2：配方参数推断（带证据、fail-closed）。
 *
 * 问题：E10 编排计划里节点的 `params` 一直是空对象，实际运行时还得人工猜
 * （expectedComponentCount、existingPourIds、outline 这些不是"选填"，猜错会写错板）。
 *
 * 本模块只做**确定性推断**：参数值要么来自调用方给的只读证据（EDA 读回/板框/现有铺铜），
 * 要么来自显式声明的默认值；证据不足时把参数列进 `missing` 并 `ok:false`，
 * 不给"大概值"，也不让编排计划看起来可执行。这里不读 EDA、不执行配方。
 */
export const PARAMS_CODES = Object.freeze({ EVIDENCE_MISSING: 'E10_PARAMS_EVIDENCE_MISSING' });

const text = (value) => String(value ?? '').trim();
const arr = (value) => (Array.isArray(value) ? value : []);

function pointList(outline) {
  const points = arr(outline).map((point) => (Array.isArray(point) ? point.map(Number) : [Number(point?.x), Number(point?.y)])).filter((point) => point.length >= 2 && point.every((value) => Number.isFinite(value)));
  return points.length >= 3 ? points : null;
}

/**
 * @param {object} input
 * @param {string} input.recipeId
 * @param {{project?:{uuid?:string},document?:{uuid?:string,type?:number},schematic?:{uuid?:string,parts?:unknown[]},pours?:{pours?:Array<{id?:string,net?:string,layer?:number}>},board?:{outline?:unknown},nets?:Array<{name?:string}>,pourRequest?:{net?:string,layer?:number}}} [input.evidence]
 */
export function inferRecipeParams({ recipeId, evidence = null } = {}) {
  const params = {};
  const sources = {};
  const missing = [];
  const notes = [];
  const set = (name, value, source) => { params[name] = value; sources[name] = source; };
  const ev = evidence && typeof evidence === 'object' ? evidence : null;

  if (recipeId === 'pcb-create-pour') {
    const pours = arr(ev?.pours?.pours);
    if (!ev) missing.push('pours', 'board', 'nets');
    else {
      if (!arr(ev.pours?.pours).length && !Array.isArray(ev?.pours?.pours)) missing.push('pours');
      else { set('expectedPourCount', pours.length + 1, 'existing pours + 1'); set('existingPourIds', pours.map((item) => text(item?.id)).filter(Boolean), 'existing pours ids'); }
      const outline = pointList(ev.board?.outline);
      if (!outline) missing.push('board.outline'); else set('outline', outline, 'board outline vertices (mil)');
      const requestedNet = text(ev.pourRequest?.net);
      const gnd = arr(ev.nets).map((net) => text(net?.name ?? net)).find((name) => /^GND/i.test(name)) || null;
      if (requestedNet) set('net', requestedNet, 'caller pourRequest.net');
      else if (gnd) { set('net', gnd, 'detected GND net'); notes.push(`未指定网络，按读回网络表选用 ${gnd}`); }
      else missing.push('net');
      if (Number.isFinite(Number(ev.pourRequest?.layer))) set('layer', Number(ev.pourRequest.layer), 'caller pourRequest.layer');
      else { set('layer', 1, 'default top layer (1)'); notes.push('未指定层，默认顶层 1；如需内层必须显式传 pourRequest.layer'); }
      if (params.net) set('pourName', params.net, 'derived from net');
    }
  } else if (recipeId === 'pcb-sync-from-schematic') {
    if (!ev) missing.push('schematic');
    else {
      const expected = Number(ev.schematic?.expectedComponentCount ?? arr(ev.schematic?.parts).length);
      if (!Number.isFinite(expected) || expected <= 0) missing.push('schematic.parts');
      else set('expectedComponentCount', expected, 'schematic parts readback');
      const schematicUuid = text(ev.schematic?.uuid);
      if (schematicUuid) set('schematicUuid', schematicUuid, 'schematic document uuid');
      else notes.push('未提供原理图 UUID：importChanges 使用当前原理图文档（运行时会读回校验）');
    }
  } else if (recipeId === 'pcb-rebuild-pours') {
    notes.push('该配方无必填参数；铺铜数量以运行后读回断言为准');
  } else {
    notes.push('该配方未声明参数推断规则；不生成任何猜测值');
  }

  const ok = missing.length === 0;
  return {
    ok,
    recipeId,
    params,
    sources,
    missing: [...new Set(missing)],
    notes,
    code: ok ? null : PARAMS_CODES.EVIDENCE_MISSING,
    message: ok ? null : `参数证据不足（${[...new Set(missing)].join('、')}）：请先只读采集对应证据，不猜参数`,
  };
}
