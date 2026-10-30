/**
 * 功能分区（R3–R6）：把“版面按功能块分章节”的设计意图落成**纯函数**。
 *
 * 会议里 PCB 设计工程师的经验是：
 *   - 按功能块分区：DC-DC、电池管理、特殊芯片/模块、结构/3D、高频各占一块区域；
 *   - 小元件尽量靠主芯片两侧、简单网络就近，复杂/远距离连接单独处理；
 *   - 用户先约定好区域，AI 只在区域内调整，并尽量保持原相对位置。
 *
 * 本模块只负责“把 blocks 声明翻译成布局引擎能吃的约束”，**不改板、不写 EDA**：
 *   - `normalizeFunctionalBlocks`：校验/规范化 blocks（id 唯一、name 非空、refs 不重复、
 *     同一 ref 不能进两个块、region 是有限矩形；给了 board 就裁剪越界并报告）；
 *   - `planFunctionalBlocks`：输出每个成员的区域（`componentRegions`）、保持相对位置的
 *     高权重锚定（`anchors`）和“分区图”（`blockMap`）。
 *
 * 三条不许含糊的边界：
 *   1. “保持相对位置”不是锁定绝对位置：这里只给 `nearX/nearY` + 高权重，最终落位仍要
 *      过板框 / 间距 / 禁布；区域之外的物理约束永远优先。
 *   2. 数据不足**不猜**：成员没有当前坐标就报 finding，不按 (0,0) 编造区域。
 *   3. 输入输出全部 mm；同一输入两次调用输出必须逐字节一致（确定性，便于测试与复核）。
 */

export const FUNCTIONAL_BLOCK_CODES = {
  BLOCKS_INVALID: 'FUNCTIONAL_BLOCKS_INVALID',
  BLOCK_INVALID: 'FUNCTIONAL_BLOCK_INVALID',
  BLOCK_ID_DUPLICATE: 'FUNCTIONAL_BLOCK_ID_DUPLICATE',
  REF_INVALID: 'FUNCTIONAL_BLOCK_REF_INVALID',
  REF_DUPLICATE_IN_BLOCK: 'FUNCTIONAL_BLOCK_REF_DUPLICATE_IN_BLOCK',
  REF_CROSS_BLOCK: 'FUNCTIONAL_BLOCK_REF_CROSS_BLOCK',
  REF_UNKNOWN: 'FUNCTIONAL_BLOCK_REF_UNKNOWN',
  REGION_INVALID: 'FUNCTIONAL_BLOCK_REGION_INVALID',
  REGION_CLAMPED: 'FUNCTIONAL_BLOCK_REGION_CLAMPED',
  REGION_OUTSIDE_BOARD: 'FUNCTIONAL_BLOCK_REGION_OUTSIDE_BOARD',
  REGION_UNDERIVABLE: 'FUNCTIONAL_BLOCK_REGION_UNDERIVABLE',
  BOARD_INVALID: 'FUNCTIONAL_BLOCK_BOARD_INVALID',
};

/** 未显式给 region 时，在成员当前包围盒外扩的默认 margin（mm）。 */
export const DEFAULT_BLOCK_MARGIN_MM = 3;
/** “保持相对位置”的锚定权重：远大于普通网络亲和度（后者是归一化距离，量级 ~1）。 */
export const DEFAULT_RELATIVE_ANCHOR_WEIGHT = 8;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

const finding = (code, severity, field, message) => ({ code, severity, field: field ?? null, message });

/** 板框包围盒：主线用 outline.bounds（minX/minY/maxX/maxY），也接受 Region 的 x*Mm 命名。 */
function toBoardBounds(board) {
  if (!isObject(board)) return null;
  const minX = Number(board.minX ?? board.xMinMm);
  const minY = Number(board.minY ?? board.yMinMm);
  const maxX = Number(board.maxX ?? board.xMaxMm);
  const maxY = Number(board.maxY ?? board.yMaxMm);
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

/** 位号大小写不敏感匹配：返回布局数据里的“实际位号”（用户可能把 u1 写成 U1）。 */
function buildRefLookup(componentRefs = []) {
  const exact = new Map();
  const folded = new Map();
  for (const ref of componentRefs) {
    if (typeof ref !== 'string' || !ref) continue;
    if (!exact.has(ref)) exact.set(ref, ref);
    const key = ref.toLowerCase();
    if (!folded.has(key)) folded.set(key, ref);
  }
  return {
    exact,
    resolve(ref) {
      if (typeof ref !== 'string') return null;
      return exact.get(ref) || folded.get(ref.toLowerCase()) || null;
    },
  };
}

/** region 必须是有限矩形：xMax>xMin、yMax>yMin，否则返回 null（由调用方报 finding）。 */
function normalizeRegionMm(region) {
  if (!isObject(region)) return null;
  const xMinMm = Number(region.xMinMm);
  const yMinMm = Number(region.yMinMm);
  const xMaxMm = Number(region.xMaxMm);
  const yMaxMm = Number(region.yMaxMm);
  if (![xMinMm, yMinMm, xMaxMm, yMaxMm].every(Number.isFinite)) return null;
  if (xMaxMm <= xMinMm || yMaxMm <= yMinMm) return null;
  return { xMinMm: round(xMinMm, 3), yMinMm: round(yMinMm, 3), xMaxMm: round(xMaxMm, 3), yMaxMm: round(yMaxMm, 3) };
}

/** 相对位置参考点：优先用布局读回里的包围盒中心（current 已是中心）。 */
function componentCenter(component) {
  const xMm = Number(component?.current?.xMm);
  const yMm = Number(component?.current?.yMm);
  return Number.isFinite(xMm) && Number.isFinite(yMm) ? { xMm, yMm } : null;
}

function componentSize(component) {
  const widthMm = Number(component?.widthMm);
  const heightMm = Number(component?.heightMm);
  return {
    widthMm: Number.isFinite(widthMm) && widthMm > 0 ? widthMm : 0,
    heightMm: Number.isFinite(heightMm) && heightMm > 0 ? heightMm : 0,
  };
}

/**
 * 规范化 + 校验功能块。
 *
 * @returns {{ok:boolean, blocks:Array<{id:string,name:string,refs:string[],region:object|null,priority:number}>, findings:Array}}
 *   `ok=false` 表示存在 blocking finding（调用方应拒绝，而不是“尽量猜一个分区”）。
 */
export function normalizeFunctionalBlocks({ blocks, componentRefs = [], board = null } = {}) {
  const findings = [];
  if (blocks === undefined || blocks === null) return { ok: true, blocks: [], findings };
  if (!Array.isArray(blocks)) {
    findings.push(finding(FUNCTIONAL_BLOCK_CODES.BLOCKS_INVALID, 'blocking', 'blocks', 'blocks 必须是数组'));
    return { ok: false, blocks: [], findings };
  }
  const bounds = toBoardBounds(board);
  const refLookup = buildRefLookup(componentRefs);
  const seenIds = new Set();
  const refOwner = new Map(); // 小写位号 → 已占用它的块 id
  const normalized = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const raw = blocks[index];
    const field = `blocks[${index}]`;
    if (!isObject(raw)) { findings.push(finding(FUNCTIONAL_BLOCK_CODES.BLOCK_INVALID, 'blocking', field, `${field} 必须是对象`)); continue; }

    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
    if (!id) { findings.push(finding(FUNCTIONAL_BLOCK_CODES.BLOCK_INVALID, 'blocking', `${field}.id`, `${field}.id 必须是非空字符串（分区图需要稳定标识）`)); continue; }
    if (seenIds.has(id)) { findings.push(finding(FUNCTIONAL_BLOCK_CODES.BLOCK_ID_DUPLICATE, 'blocking', `${field}.id`, `功能块 id ${id} 重复；分区图不允许同名章节`)); continue; }
    seenIds.add(id);

    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
    if (!name) { findings.push(finding(FUNCTIONAL_BLOCK_CODES.BLOCK_INVALID, 'blocking', `${field}.name`, `${field}.name 必须是非空字符串`)); continue; }

    if (!Array.isArray(raw.refs) || raw.refs.length === 0) {
      findings.push(finding(FUNCTIONAL_BLOCK_CODES.BLOCK_INVALID, 'blocking', `${field}.refs`, `${field}.refs 必须是非空位号数组`));
      continue;
    }

    const refs = [];
    const localRefs = new Set();
    let refsUsable = true;
    raw.refs.forEach((ref, refIndex) => {
      if (typeof ref !== 'string' || !ref.trim()) {
        refsUsable = false;
        findings.push(finding(FUNCTIONAL_BLOCK_CODES.REF_INVALID, 'blocking', `${field}.refs[${refIndex}]`, `${field}.refs[${refIndex}] 必须是非空位号字符串`));
        return;
      }
      const canonical = refLookup.resolve(ref.trim());
      const resolved = canonical || ref.trim();
      const folded = resolved.toLowerCase();
      if (localRefs.has(folded)) {
        findings.push(finding(FUNCTIONAL_BLOCK_CODES.REF_DUPLICATE_IN_BLOCK, 'warning', `${field}.refs`, `功能块 ${id} 里位号 ${resolved} 重复，已去重`));
        return;
      }
      localRefs.add(folded);
      const owner = refOwner.get(folded);
      if (owner) {
        findings.push(finding(FUNCTIONAL_BLOCK_CODES.REF_CROSS_BLOCK, 'blocking', `${field}.refs`, `位号 ${resolved} 已属于功能块 ${owner}，同一个位号不能同时进两个分区`));
        return;
      }
      refOwner.set(folded, id);
      // 未知位号只报告、不崩：可能位号写错，也可能是还没读回的器件；声明照实保留，但不会拿到区域。
      if (!canonical) findings.push(finding(FUNCTIONAL_BLOCK_CODES.REF_UNKNOWN, 'warning', `${field}.refs`, `位号 ${resolved} 不在当前 PCB 布局数据里：会保留这条分区声明，但不会为它生成区域/锚定`));
      refs.push(resolved);
    });
    if (!refsUsable || refs.length === 0) {
      findings.push(finding(FUNCTIONAL_BLOCK_CODES.BLOCK_INVALID, 'blocking', `${field}.refs`, `功能块 ${id} 去掉非法/重复/跨块位号后没有可用成员`));
      continue;
    }

    let region = null;
    if (raw.region !== undefined && raw.region !== null) {
      region = normalizeRegionMm(raw.region);
      if (!region) {
        findings.push(finding(FUNCTIONAL_BLOCK_CODES.REGION_INVALID, 'blocking', `${field}.region`, `${field}.region 必须是 {xMinMm,yMinMm,xMaxMm,yMaxMm} 的有限矩形，且 xMax>xMin、yMax>yMin`));
      } else if (bounds) {
        region = clampRegionToBoard(region, bounds, id, findings);
      }
    }

    normalized.push({
      id,
      name,
      refs,
      region,
      priority: isFiniteNumber(raw.priority) ? raw.priority : 0,
      regionDerived: false,
    });
  }

  return { ok: findings.every((item) => item.severity !== 'blocking'), blocks: normalized, findings };
}

/** 给 board 时把 region 裁到板内：部分越界 → 裁剪并 warning；完全在板外 → 丢弃该 region（由成员位置推导兜底）。 */
function clampRegionToBoard(region, bounds, blockId, findings) {
  const clamped = {
    xMinMm: Math.max(region.xMinMm, bounds.minX),
    yMinMm: Math.max(region.yMinMm, bounds.minY),
    xMaxMm: Math.min(region.xMaxMm, bounds.maxX),
    yMaxMm: Math.min(region.yMaxMm, bounds.maxY),
  };
  const unchanged = clamped.xMinMm === region.xMinMm && clamped.yMinMm === region.yMinMm
    && clamped.xMaxMm === region.xMaxMm && clamped.yMaxMm === region.yMaxMm;
  if (unchanged) return region;
  const rounded = {
    xMinMm: round(clamped.xMinMm, 3), yMinMm: round(clamped.yMinMm, 3),
    xMaxMm: round(clamped.xMaxMm, 3), yMaxMm: round(clamped.yMaxMm, 3),
  };
  if (rounded.xMaxMm <= rounded.xMinMm || rounded.yMaxMm <= rounded.yMinMm) {
    findings.push(finding(FUNCTIONAL_BLOCK_CODES.REGION_OUTSIDE_BOARD, 'warning', `blocks.${blockId}.region`, `功能块 ${blockId} 的 region 完全落在板框外，已改为按成员当前位置推导区域`));
    return null;
  }
  findings.push(finding(FUNCTIONAL_BLOCK_CODES.REGION_CLAMPED, 'warning', `blocks.${blockId}.region`, `功能块 ${blockId} 的 region 越出板框（原 ${JSON.stringify(region)} → 裁剪为 ${JSON.stringify(rounded)}）`));
  return rounded;
}

/** 由成员的“当前包围盒 + margin”推导区域；没有任何成员坐标时返回 null（不猜）。 */
function deriveRegionFromMembers(members, marginMm, bounds) {
  const rects = [];
  for (const member of members) {
    const center = member.center || null;
    if (!center) continue;
    const widthMm = Number(member.widthMm) > 0 ? Number(member.widthMm) : 0;
    const heightMm = Number(member.heightMm) > 0 ? Number(member.heightMm) : 0;
    rects.push({
      minX: center.xMm - widthMm / 2,
      maxX: center.xMm + widthMm / 2,
      minY: center.yMm - heightMm / 2,
      maxY: center.yMm + heightMm / 2,
    });
  }
  if (!rects.length) return null;
  let region = {
    xMinMm: Math.min(...rects.map((rect) => rect.minX)) - marginMm,
    yMinMm: Math.min(...rects.map((rect) => rect.minY)) - marginMm,
    xMaxMm: Math.max(...rects.map((rect) => rect.maxX)) + marginMm,
    yMaxMm: Math.max(...rects.map((rect) => rect.maxY)) + marginMm,
  };
  if (bounds) {
    // 推导区域越出板框不算错误（成员本来就贴边）：直接裁到板内，避免把“不可能的区域”传给布局。
    region = {
      xMinMm: Math.max(region.xMinMm, bounds.minX),
      yMinMm: Math.max(region.yMinMm, bounds.minY),
      xMaxMm: Math.min(region.xMaxMm, bounds.maxX),
      yMaxMm: Math.min(region.yMaxMm, bounds.maxY),
    };
  }
  if (region.xMaxMm <= region.xMinMm || region.yMaxMm <= region.yMinMm) return null;
  return {
    xMinMm: round(region.xMinMm, 3), yMinMm: round(region.yMinMm, 3),
    xMaxMm: round(region.xMaxMm, 3), yMaxMm: round(region.yMaxMm, 3),
  };
}

/**
 * 把功能块落到可执行的布局约束 + 分区图。
 *
 * @param {object} args
 * @param {Array} args.blocks 设计意图里的 blocks（可来自 layoutIntent.blocks）
 * @param {object|null} args.board 板框包围盒 `{minX,minY,maxX,maxY}`（服务端取 outline.bounds）
 * @param {Array} args.components `readComponentGeometry` 读回的器件（ref/widthMm/heightMm/current）
 * @param {number} [args.marginMm] 未给 region 时按成员包围盒外扩的 margin
 * @param {number} [args.anchorWeightNear] “保持相对位置”的锚定权重
 * @returns {{ok:boolean, componentRegions:Record<string,object>, anchors:Record<string,object>, blockMap:Array, findings:Array}}
 *   - `componentRegions`：位号 → 区域（布局引擎按它做“只在区域内调整”的硬约束）
 *   - `anchors`：位号 → `{nearX,nearY,weightNear}`（表达“尽量保持原相对位置”，不承诺锁定绝对值）
 *   - `blockMap`：分区图（块 → 区域 → 成员 + 面积/利用率），无 blocks 时为空数组
 */
export function planFunctionalBlocks({
  blocks,
  board = null,
  components = [],
  componentRefs = null,
  marginMm = DEFAULT_BLOCK_MARGIN_MM,
  anchorWeightNear = DEFAULT_RELATIVE_ANCHOR_WEIGHT,
} = {}) {
  const refs = Array.isArray(componentRefs) && componentRefs.length
    ? componentRefs
    : components.map((component) => component?.ref).filter((ref) => typeof ref === 'string' && ref);
  const normalized = normalizeFunctionalBlocks({ blocks, componentRefs: refs, board });
  const findings = [...normalized.findings];
  const bounds = toBoardBounds(board);
  if (board !== null && board !== undefined && !bounds) {
    findings.push(finding(FUNCTIONAL_BLOCK_CODES.BOARD_INVALID, 'warning', 'board', 'board 不是可用的 mm 板框包围盒 {minX,minY,maxX,maxY}：本次不做板内裁剪'));
  }
  const margin = Number.isFinite(Number(marginMm)) && Number(marginMm) >= 0 ? Number(marginMm) : DEFAULT_BLOCK_MARGIN_MM;
  const weight = Number.isFinite(Number(anchorWeightNear)) && Number(anchorWeightNear) > 0 ? Number(anchorWeightNear) : DEFAULT_RELATIVE_ANCHOR_WEIGHT;

  // 位号 → 实际器件（大小写不敏感；输出键统一用布局数据里的实际位号）。
  const geometry = new Map();
  for (const component of components) {
    const ref = component?.ref;
    if (typeof ref !== 'string' || !ref) continue;
    const entry = { ref, center: componentCenter(component), ...componentSize(component) };
    if (!geometry.has(ref)) geometry.set(ref, entry);
    const folded = ref.toLowerCase();
    if (!geometry.has(folded)) geometry.set(folded, entry);
  }

  const componentRegions = {};
  const anchors = {};
  const blockMap = [];

  for (const block of normalized.blocks) {
    const members = block.refs.map((ref) => geometry.get(ref)).filter(Boolean);
    // 同一个实际器件被大小写重复解析时只保留一次，保证面积/锚定不重复计算。
    const knownMembers = [...new Map(members.map((member) => [member.ref, member])).values()];
    let region = block.region;
    let regionDerived = false;
    if (!region) {
      region = deriveRegionFromMembers(knownMembers, margin, bounds);
      regionDerived = Boolean(region);
      if (!region) {
        findings.push(finding(FUNCTIONAL_BLOCK_CODES.REGION_UNDERIVABLE, 'warning', `blocks.${block.id}.region`, `功能块 ${block.id} 没有 region，且成员缺少当前坐标/尺寸，无法推导区域（不按 (0,0) 瞎猜）；布局会把它当普通器件处理`));
      }
    }
    if (region) for (const member of knownMembers) componentRegions[member.ref] = { ...region };
    for (const member of knownMembers) {
      if (!member.center) continue;
      anchors[member.ref] = { nearX: round(member.center.xMm, 4), nearY: round(member.center.yMm, 4), weightNear: weight };
    }
    const componentAreaMm2 = knownMembers.reduce((sum, member) => sum + member.widthMm * member.heightMm, 0);
    const areaMm2 = region ? round((region.xMaxMm - region.xMinMm) * (region.yMaxMm - region.yMinMm), 3) : null;
    blockMap.push({
      id: block.id,
      name: block.name,
      refs: [...block.refs],
      priority: block.priority,
      region: region ? { ...region } : null,
      regionDerived,
      areaMm2,
      componentAreaMm2: round(componentAreaMm2, 3),
      utilization: areaMm2 !== null && areaMm2 > 0 ? round(componentAreaMm2 / areaMm2, 4) : null,
      memberCount: block.refs.length,
      knownMemberCount: knownMembers.length,
      /** 成员里没有当前坐标的数量：>0 表示这块的“保持相对位置”不完整，需人工确认。 */
      unpositionedMemberCount: block.refs.length - knownMembers.filter((member) => member.center).length,
    });
  }

  return {
    ok: normalized.ok,
    componentRegions,
    anchors,
    blockMap,
    findings,
  };
}
