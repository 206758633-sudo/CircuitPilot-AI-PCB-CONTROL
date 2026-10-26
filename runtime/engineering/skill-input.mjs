/**
 * Skill 规则的“桥接适配器”：把桥命令的原始读回（mil/mm 混用、bbox 中心表示）
 * 归一成 `skill-rules.mjs` 的输入。纯函数，不直接连桥，方便单测与真机复用。
 *
 * 桥侧形状（真机 2026-10-23 核对）：
 * - `pcb.placement.read` → {unit:'mm', components:[{designator,xMm,yMm,rotationDeg,layer,layerSide,bboxMm:{xMm,yMm,centerXMm,centerYMm}}]}
 * - `pcb.regions.detail`  → {count, regions:[{primitiveId,layer,rules,regionName,lineWidthMil,boundsMm:{minXMm,...}}]}
 * - `pcb.texts.detail`    → {count, texts:[{primitiveId,layer,text,mirror,reverse,rotationDeg,fontSizeMil,lineWidthMil,xMm,yMm}]}
 * - `pcb.pours.detail`    → [{primitiveId,net,layer,pourName,pourPriority,boundsMm}]
 * - `pcb.outline.read`    → {count, items:[{primitiveId,lineWidthMil,polygon:{polygon:[x,y,'L',x,y,...]}}]}，坐标是 mil
 * - `pcb.copper.read`     → {lines:[{id,net,layer,x1,y1,x2,y2,width}]}，坐标/线宽是 mil
 */
const MIL_TO_MM = 25.4 / 1000;
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const unwrap = (value) => (value && typeof value === 'object' && 'result' in value ? value.result : value);
const mm = (mil) => (num(mil) === null ? null : mil * MIL_TO_MM);
const round = (value, digits = 4) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : value);

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const minXMm = num(bounds.minXMm); const minYMm = num(bounds.minYMm);
  const maxXMm = num(bounds.maxXMm); const maxYMm = num(bounds.maxYMm);
  if ([minXMm, minYMm, maxXMm, maxYMm].some((value) => value === null)) return null;
  return { minXMm, minYMm, maxXMm, maxYMm };
}

/** `pcb.placement.read` → skill placements（bboxMm 归一成 min/max）。 */
export function adaptPlacements(read) {
  const data = unwrap(read);
  const components = Array.isArray(data?.components) ? data.components : [];
  const placements = [];
  for (const component of components) {
    const ref = String(component?.designator || '').trim();
    if (!ref) continue;
    const bbox = component?.bboxMm || {};
    const widthMm = num(bbox.xMm) ?? num(component.widthMm);
    const heightMm = num(bbox.yMm) ?? num(component.heightMm);
    const centerXMm = num(bbox.centerXMm) ?? num(component.centerXMm) ?? num(component.xMm);
    const centerYMm = num(bbox.centerYMm) ?? num(component.centerYMm) ?? num(component.yMm);
    const boundsMm = widthMm > 0 && heightMm > 0 && centerXMm !== null && centerYMm !== null
      ? { minXMm: round(centerXMm - widthMm / 2), minYMm: round(centerYMm - heightMm / 2), maxXMm: round(centerXMm + widthMm / 2), maxYMm: round(centerYMm + heightMm / 2) }
      : null;
    placements.push({
      ref,
      layer: num(component.layer),
      layerSide: component.layerSide ?? null,
      rotationDeg: num(component.rotationDeg) ?? 0,
      widthMm: widthMm === null ? null : round(widthMm),
      heightMm: heightMm === null ? null : round(heightMm),
      centerXMm: centerXMm === null ? null : round(centerXMm),
      centerYMm: centerYMm === null ? null : round(centerYMm),
      boundsMm,
      nets: Array.isArray(component.nets) ? component.nets : [],
    });
  }
  return placements.sort((left, right) => left.ref.localeCompare(right.ref, 'en', { numeric: true }));
}

/** `pcb.regions.detail` → skill regions（保留 ruleTypes 原值）。 */
export function adaptRegions(read) {
  const data = unwrap(read);
  const regions = Array.isArray(data) ? data : Array.isArray(data?.regions) ? data.regions : [];
  return regions.map((region) => ({
    id: region.primitiveId || region.id || 'region',
    primitiveId: region.primitiveId || null,
    layer: num(region.layer),
    rules: Array.isArray(region.rules) ? region.rules.map(Number) : [],
    regionName: region.regionName ?? null,
    lineWidth: num(region.lineWidthMil) ?? num(region.lineWidth),
    boundsMm: normalizeBounds(region.boundsMm),
    polygon: region.polygon ?? null,
  })).sort((left, right) => String(left.id).localeCompare(String(right.id), 'en', { numeric: true }));
}

/** `pcb.pours.detail` → skill pours（带包围盒）。 */
export function adaptPours(read) {
  const data = unwrap(read);
  const pours = Array.isArray(data) ? data : Array.isArray(data?.pours) ? data.pours : [];
  return pours.map((pour) => ({
    id: pour.primitiveId || pour.id || 'pour',
    primitiveId: pour.primitiveId || null,
    net: pour.net ?? null,
    layer: num(pour.layer),
    pourName: pour.pourName ?? null,
    boundsMm: normalizeBounds(pour.boundsMm),
  })).sort((left, right) => String(left.id).localeCompare(String(right.id), 'en', { numeric: true }));
}

/** `pcb.texts.detail` + placements → 丝印文字；位号用 ref 精确匹配回器件所在面，保留字高/线宽/包围盒。 */
export function adaptTexts(read, placements = []) {
  const data = unwrap(read);
  const texts = Array.isArray(data) ? data : Array.isArray(data?.texts) ? data.texts : [];
  const byRef = new Map(placements.map((placement) => [placement.ref, placement]));
  return texts.map((text) => {
    const content = String(text.text || '');
    const matched = byRef.get(content.trim());
    return {
      id: text.primitiveId || text.id || 'text',
      text: content,
      layer: num(text.layer),
      kind: matched ? 'designator' : 'text',
      componentLayer: matched?.layerSide ?? null,
      componentRef: matched?.ref ?? null,
      mirror: typeof text.mirror === 'boolean' ? text.mirror : null,
      reverse: typeof text.reverse === 'boolean' ? text.reverse : null,
      rotationDeg: num(text.rotationDeg) ?? 0,
      fontSizeMil: num(text.fontSizeMil),
      fontSizeMm: mm(text.fontSizeMil),
      lineWidthMil: num(text.lineWidthMil),
      lineWidthMm: mm(text.lineWidthMil),
      xMm: num(text.xMm),
      yMm: num(text.yMm),
      boundsMm: normalizeBounds(text.boundsMm),
    };
  }).sort((left, right) => String(left.id).localeCompare(String(right.id), 'en', { numeric: true }));
}

/** `pcb.outline.read` → board bounds（polygon 是 mil，取数值对的最小/最大）。 */
export function adaptBoard(read) {
  const data = unwrap(read);
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  for (const item of items) {
    const polygon = item?.polygon?.polygon;
    if (!Array.isArray(polygon)) continue;
    const numbers = polygon.filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (numbers.length < 6 || numbers.length % 2 !== 0) continue;
    const xs = []; const ys = [];
    for (let index = 0; index + 1 < numbers.length; index += 2) { xs.push(numbers[index]); ys.push(numbers[index + 1]); }
    const boundsMm = {
      minXMm: round(mm(Math.min(...xs))), minYMm: round(mm(Math.min(...ys))),
      maxXMm: round(mm(Math.max(...xs))), maxYMm: round(mm(Math.max(...ys))),
    };
    return { boundsMm, widthMm: round(boundsMm.maxXMm - boundsMm.minXMm), heightMm: round(boundsMm.maxYMm - boundsMm.minYMm), originXMm: boundsMm.minXMm, originYMm: boundsMm.minYMm };
  }
  return null;
}

/** `pcb.copper.read` 的线段 → {net,widthMm}，按 net+线宽去重（net-class 只关心实测值）。 */
export function adaptTracks(read) {
  const data = unwrap(read);
  const lines = Array.isArray(data?.lines) ? data.lines : [];
  const seen = new Set(); const tracks = [];
  for (const line of lines) {
    const net = String(line?.net || '').trim();
    const widthMm = mm(line?.width);
    if (!net || widthMm === null || !(widthMm > 0)) continue;
    const key = `${net}|${round(widthMm)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({ net, widthMm: round(widthMm), layer: num(line.layer) });
  }
  return tracks.sort((left, right) => left.net.localeCompare(right.net, 'en', { numeric: true }) || left.widthMm - right.widthMm);
}

/**
 * 把桥读回 + 设计意图（zones/assembly/selfCheck/diffPairs/netClasses…）合成审计输入。
 * EDA 几何以后者为准；设计意图字段原样透传。
 */
export function buildSkillInput({ placement = null, regions = null, texts = null, pours = null, outline = null, copper = null, design = {} } = {}) {
  const intent = design && typeof design === 'object' ? design : {};
  const placements = adaptPlacements(placement);
  const board = adaptBoard(outline) || intent.board || null;
  const input = {
    ...intent,
    board,
    placements,
    regions: adaptRegions(regions),
    pours: adaptPours(pours),
    silkTexts: adaptTexts(texts, placements),
  };
  if (Array.isArray(intent.tracks) && intent.tracks.length) input.tracks = intent.tracks;
  else if (copper) input.tracks = adaptTracks(copper);
  return input;
}
