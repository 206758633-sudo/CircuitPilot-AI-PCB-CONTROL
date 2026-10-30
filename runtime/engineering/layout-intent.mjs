/**
 * 布局设计意图 JSON 的校验/归一化。
 *
 * 规则引擎能判的只是“有数据的部分”；连接器开口方向、天线端朝向、去耦配对、
 * 测试点/按键空间这些事实无法从 2D 包围盒推出来，必须由设计意图显式声明。
 * 本模块把“声明”与“实测几何”分开：声明缺失 → 规则 REVIEW；声明了但非法 → 直接拒绝，
 * 避免把一条写错方向的 conn 当成已检查。
 */
const DIRECTIONS = new Set(['+x', '-x', '+y', '-y']);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

export function validateLayoutIntent(input) {
  const issues = [];
  if (!isObject(input)) return { ok: false, issues: ['设计意图必须是对象'] };
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) issues.push('schemaVersion 只支持 1');
  if (input.pcbUuid !== undefined && typeof input.pcbUuid !== 'string') issues.push('pcbUuid 必须是字符串');
  if (input.board !== undefined && !isObject(input.board)) issues.push('board 必须是对象');
  if (input.components !== undefined && !isObject(input.components)) issues.push('components 必须是 {位号: 补丁} 对象');
  for (const [ref, patch] of Object.entries(input.components || {})) {
    if (!/^[A-Za-z]+\d+/i.test(ref)) issues.push(`components.${ref}：位号不合法`);
    if (!isObject(patch)) { issues.push(`components.${ref} 必须是对象`); continue; }
    if (patch.courtyardMm !== undefined && (!isFiniteNumber(patch.courtyardMm) || patch.courtyardMm < 0)) issues.push(`components.${ref}.courtyardMm 必须是非负数`);
    if (patch.heightMm3d !== undefined && (!isFiniteNumber(patch.heightMm3d) || patch.heightMm3d <= 0)) issues.push(`components.${ref}.heightMm3d 必须是正数`);
    if (patch.side !== undefined && !['top', 'bottom'].includes(patch.side)) issues.push(`components.${ref}.side 只能是 top/bottom`);
    if (patch.packageClass !== undefined && typeof patch.packageClass !== 'string') issues.push(`components.${ref}.packageClass 必须是字符串`);
    if (patch.conn !== undefined) {
      if (!isObject(patch.conn)) issues.push(`components.${ref}.conn 必须是对象`);
      else {
        if (patch.conn.openingDir !== undefined && !DIRECTIONS.has(patch.conn.openingDir)) issues.push(`components.${ref}.conn.openingDir 只能是 +x/-x/+y/-y`);
        if (patch.conn.openingNormalityDeg !== undefined && (!isFiniteNumber(patch.conn.openingNormalityDeg) || patch.conn.openingNormalityDeg < 0 || patch.conn.openingNormalityDeg > 180)) issues.push(`components.${ref}.conn.openingNormalityDeg 必须在 0..180`);
        for (const key of ['plugClearanceMm', 'overhangMm', 'massG', 'pressClearanceMm']) if (patch.conn[key] !== undefined && (!isFiniteNumber(patch.conn[key]) || patch.conn[key] < 0)) issues.push(`components.${ref}.conn.${key} 必须是非负数`);
        for (const key of ['cableKeepout', 'reinforced', 'pin1Marked']) if (patch.conn[key] !== undefined && typeof patch.conn[key] !== 'boolean') issues.push(`components.${ref}.conn.${key} 必须是布尔值`);
      }
    }
    if (patch.antenna !== undefined) {
      if (!isObject(patch.antenna)) issues.push(`components.${ref}.antenna 必须是对象`);
      else if (patch.antenna.endDir !== undefined && !DIRECTIONS.has(patch.antenna.endDir)) issues.push(`components.${ref}.antenna.endDir 只能是 +x/-x/+y/-y`);
    }
  }
  if (input.power !== undefined) {
    if (!isObject(input.power)) issues.push('power 必须是对象');
    else if (input.power.decoupling !== undefined) {
      if (!Array.isArray(input.power.decoupling)) issues.push('power.decoupling 必须是数组');
      else input.power.decoupling.forEach((entry, index) => {
        if (!isObject(entry)) { issues.push(`power.decoupling[${index}] 必须是对象`); return; }
        if (typeof entry.capRef !== 'string' || !entry.capRef) issues.push(`power.decoupling[${index}].capRef 缺失`);
        if (typeof entry.icRef !== 'string' || !entry.icRef) issues.push(`power.decoupling[${index}].icRef 缺失`);
        if (!isFiniteNumber(entry.distanceMm)) issues.push(`power.decoupling[${index}].distanceMm 必须是数字`);
        if (entry.icClass !== undefined && typeof entry.icClass !== 'string') issues.push(`power.decoupling[${index}].icClass 必须是字符串`);
      });
    }
  }
  if (input.rf !== undefined) {
    if (!isObject(input.rf)) issues.push('rf 必须是对象');
    else {
      if (input.rf.componentRef !== undefined && typeof input.rf.componentRef !== 'string') issues.push('rf.componentRef 必须是字符串');
      if (input.rf.keepout !== undefined) {
        if (!isObject(input.rf.keepout) || !['x0', 'y0', 'x1', 'y1'].every((key) => isFiniteNumber(input.rf.keepout[key]))) issues.push('rf.keepout 必须是 {x0,y0,x1,y1} 数字');
        else if (input.rf.keepout.x1 <= input.rf.keepout.x0 || input.rf.keepout.y1 <= input.rf.keepout.y0) issues.push('rf.keepout 的 x1/y1 必须大于 x0/y0');
      }
    }
  }
  // R3/R5：功能分区（blocks）是可选声明：块 → 成员位号 → 约定区域。
  // 这里只做“声明本身是否合法”的校验；区域推导/越界裁剪在 functional-blocks.mjs 里做。
  if (input.blocks !== undefined) {
    if (!Array.isArray(input.blocks)) issues.push('blocks 必须是数组');
    else {
      const blockIds = new Set();
      const refOwner = new Map();
      input.blocks.forEach((block, index) => {
        if (!isObject(block)) { issues.push(`blocks[${index}] 必须是对象`); return; }
        const blockId = typeof block.id === 'string' && block.id.trim() ? block.id.trim() : null;
        if (!blockId) issues.push(`blocks[${index}].id 必须是非空字符串`);
        else if (blockIds.has(blockId)) issues.push(`blocks 的 id 重复：${blockId}`);
        else blockIds.add(blockId);
        if (typeof block.name !== 'string' || !block.name.trim()) issues.push(`blocks[${index}].name 必须是非空字符串`);
        if (!Array.isArray(block.refs) || block.refs.length === 0) issues.push(`blocks[${index}].refs 必须是非空位号数组`);
        else {
          const localRefs = new Set();
          block.refs.forEach((ref, refIndex) => {
            if (typeof ref !== 'string' || !ref.trim()) { issues.push(`blocks[${index}].refs[${refIndex}] 必须是非空位号字符串`); return; }
            const key = ref.trim().toLowerCase();
            if (localRefs.has(key)) issues.push(`blocks[${index}].refs 里位号 ${ref.trim()} 重复`);
            else localRefs.add(key);
            const owner = blockId || `blocks[${index}]`;
            if (refOwner.has(key) && refOwner.get(key) !== owner) issues.push(`位号 ${ref.trim()} 同时属于功能块 ${refOwner.get(key)} 与 ${owner}：同一个位号不能进两个分区`);
            else refOwner.set(key, owner);
          });
        }
        if (block.region !== undefined) {
          if (!isObject(block.region) || !['xMinMm', 'yMinMm', 'xMaxMm', 'yMaxMm'].every((key) => isFiniteNumber(block.region[key]))) issues.push(`blocks[${index}].region 必须是 {xMinMm,yMinMm,xMaxMm,yMaxMm} 数字`);
          else if (block.region.xMaxMm <= block.region.xMinMm || block.region.yMaxMm <= block.region.yMinMm) issues.push(`blocks[${index}].region 的 xMaxMm/yMaxMm 必须大于 xMinMm/yMinMm`);
        }
        if (block.priority !== undefined && !isFiniteNumber(block.priority)) issues.push(`blocks[${index}].priority 必须是数字`);
      });
    }
  }
  if (input.requiredNets !== undefined) {
    if (!Array.isArray(input.requiredNets) || input.requiredNets.some((net) => typeof net !== 'string' || !net)) issues.push('requiredNets 必须是非空字符串数组');
  }
  for (const key of ['testPoints', 'switches']) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key])) { issues.push(`${key} 必须是数组`); continue; }
    input[key].forEach((entry, index) => {
      if (!isObject(entry)) issues.push(`${key}[${index}] 必须是对象`);
      else if (key === 'testPoints' && (typeof entry.ref !== 'string' || !isFiniteNumber(entry.diaMm))) issues.push(`testPoints[${index}] 需要 ref/diaMm`);
      else if (key === 'switches' && (typeof entry.ref !== 'string' || !isFiniteNumber(entry.clearanceMm))) issues.push(`switches[${index}] 需要 ref/clearanceMm`);
    });
  }
  if (input.esd !== undefined) {
    if (!isObject(input.esd)) issues.push('esd 必须是对象');
    else if (input.esd.devices !== undefined) {
      if (!Array.isArray(input.esd.devices)) issues.push('esd.devices 必须是数组');
      else input.esd.devices.forEach((entry, index) => {
        if (!isObject(entry)) { issues.push(`esd.devices[${index}] 必须是对象`); return; }
        if (typeof entry.ref !== 'string' || !entry.ref) issues.push(`esd.devices[${index}].ref 缺失`);
        for (const key of ['distanceMm', 'gndViaDistanceMm']) if (entry[key] !== undefined && (!isFiniteNumber(entry[key]) || entry[key] < 0)) issues.push(`esd.devices[${index}].${key} 必须是非负数`);
        if (entry.orderBeforeBranch !== undefined && typeof entry.orderBeforeBranch !== 'boolean') issues.push(`esd.devices[${index}].orderBeforeBranch 必须是布尔值`);
      });
    }
  }
  if (input.thermal !== undefined) {
    if (!isObject(input.thermal)) issues.push('thermal 必须是对象');
    else if (input.thermal.components !== undefined) {
      if (!Array.isArray(input.thermal.components)) issues.push('thermal.components 必须是数组');
      else input.thermal.components.forEach((entry, index) => {
        if (!isObject(entry)) { issues.push(`thermal.components[${index}] 必须是对象`); return; }
        if (typeof entry.ref !== 'string' || !entry.ref) issues.push(`thermal.components[${index}].ref 缺失`);
        if (!isFiniteNumber(entry.powerW) || entry.powerW < 0) issues.push(`thermal.components[${index}].powerW 必须是非负数`);
        for (const key of ['copperAreaMm2', 'viaCount', 'viaPitchMm', 'viaHoleMm']) if (entry[key] !== undefined && (!isFiniteNumber(entry[key]) || entry[key] < 0)) issues.push(`thermal.components[${index}].${key} 必须是非负数`);
      });
    }
  }
  if (input.pdn !== undefined) {
    if (!isObject(input.pdn)) issues.push('pdn 必须是对象');
    else if (input.pdn.rails !== undefined) {
      if (!Array.isArray(input.pdn.rails)) issues.push('pdn.rails 必须是数组');
      else input.pdn.rails.forEach((entry, index) => {
        if (!isObject(entry) || typeof entry.net !== 'string') { issues.push(`pdn.rails[${index}] 需要 net`); return; }
        for (const key of ['dropV', 'maxDropV', 'currentA', 'resistanceOhm']) if (entry[key] !== undefined && (!isFiniteNumber(entry[key]) || entry[key] < 0)) issues.push(`pdn.rails[${index}].${key} 必须是非负数`);
      });
    }
  }
  if (input.highSpeed !== undefined) {
    if (!isObject(input.highSpeed)) issues.push('highSpeed 必须是对象');
    else if (input.highSpeed.groups !== undefined) {
      if (!Array.isArray(input.highSpeed.groups)) issues.push('highSpeed.groups 必须是数组');
      else input.highSpeed.groups.forEach((entry, index) => {
        if (!isObject(entry) || typeof entry.name !== 'string' || !entry.name) { issues.push(`highSpeed.groups[${index}] 需要 name`); return; }
        if (!Array.isArray(entry.members) || entry.members.length < 2) issues.push(`highSpeed.groups[${index}].members 至少 2 个`);
        else entry.members.forEach((member, memberIndex) => {
          if (!isObject(member) || typeof member.net !== 'string') issues.push(`highSpeed.groups[${index}].members[${memberIndex}] 需要 net`);
          else if (member.lengthMm !== undefined && (!isFiniteNumber(member.lengthMm) || member.lengthMm < 0)) issues.push(`highSpeed.groups[${index}].members[${memberIndex}].lengthMm 必须是非负数`);
          else if (member.impedanceOhm !== undefined && (!isFiniteNumber(member.impedanceOhm) || member.impedanceOhm < 0)) issues.push(`highSpeed.groups[${index}].members[${memberIndex}].impedanceOhm 必须是非负数`);
        });
        if (entry.standard !== undefined && !['USB2', 'USB3', 'USB4'].includes(entry.standard)) issues.push(`highSpeed.groups[${index}].standard 只能是 USB2/USB3/USB4`);
        for (const key of ['maxSkewMm', 'targetImpedanceOhm', 'intraPairSkewMm', 'pairGapMm', 'planeEdgeClearanceMm', 'stubMm']) if (entry[key] !== undefined && (!isFiniteNumber(entry[key]) || entry[key] < 0)) issues.push(`highSpeed.groups[${index}].${key} 必须是非负数`);
      });
    }
  }
  if (input.creepage !== undefined) {
    if (!isObject(input.creepage)) issues.push('creepage 必须是对象');
    else if (input.creepage.pairs !== undefined) {
      if (!Array.isArray(input.creepage.pairs)) issues.push('creepage.pairs 必须是数组');
      else input.creepage.pairs.forEach((entry, index) => {
        if (!isObject(entry) || typeof entry.netA !== 'string' || typeof entry.netB !== 'string') { issues.push(`creepage.pairs[${index}] 需要 netA/netB`); return; }
        for (const key of ['requiredMm', 'actualMm', 'workingVoltageV']) if (entry[key] !== undefined && (!isFiniteNumber(entry[key]) || entry[key] < 0)) issues.push(`creepage.pairs[${index}].${key} 必须是非负数`);
      });
    }
  }
  if (input.clearance !== undefined) {
    if (!isObject(input.clearance)) issues.push('clearance 必须是对象');
    else if (input.clearance.pairs !== undefined) {
      if (!Array.isArray(input.clearance.pairs)) issues.push('clearance.pairs 必须是数组');
      else input.clearance.pairs.forEach((entry, index) => {
        if (!isObject(entry) || typeof entry.netA !== 'string' || typeof entry.netB !== 'string') { issues.push(`clearance.pairs[${index}] 需要 netA/netB`); return; }
        if (entry.layer !== undefined && !['internal', 'external'].includes(entry.layer)) issues.push(`clearance.pairs[${index}].layer 只能是 internal/external`);
        if (entry.coating !== undefined && !['uncoated', 'coated'].includes(entry.coating)) issues.push(`clearance.pairs[${index}].coating 只能是 uncoated/coated`);
        for (const key of ['requiredMm', 'actualMm', 'workingVoltageV', 'altitudeM']) if (entry[key] !== undefined && (!isFiniteNumber(entry[key]) || entry[key] < 0)) issues.push(`clearance.pairs[${index}].${key} 必须是非负数`);
      });
    }
  }
  if (input.enclosure !== undefined) {
    if (!isObject(input.enclosure)) issues.push('enclosure 必须是对象');
    else for (const key of ['requiredClearanceMm', 'actualClearanceMm', 'internalHeightMm', 'maxComponentHeightMm']) if (input.enclosure[key] !== undefined && (!isFiniteNumber(input.enclosure[key]) || input.enclosure[key] < 0)) issues.push(`enclosure.${key} 必须是非负数`);
  }
  if (input.emc !== undefined) {
    if (!isObject(input.emc)) issues.push('emc 必须是对象');
    else if (input.emc.pairs !== undefined) {
      if (!Array.isArray(input.emc.pairs)) issues.push('emc.pairs 必须是数组');
      else input.emc.pairs.forEach((entry, index) => {
        if (!isObject(entry) || typeof entry.from !== 'string' || typeof entry.to !== 'string') { issues.push(`emc.pairs[${index}] 需要 from/to`); return; }
        for (const key of ['minMm', 'actualMm']) if (entry[key] !== undefined && (!isFiniteNumber(entry[key]) || entry[key] < 0)) issues.push(`emc.pairs[${index}].${key} 必须是非负数`);
      });
    }
  }
  if (input.evidence !== undefined && !isObject(input.evidence)) issues.push('evidence 必须是对象');
  if (input.silk !== undefined && !isObject(input.silk)) issues.push('silk 必须是对象');
  if (input.dfm !== undefined && !isObject(input.dfm)) issues.push('dfm 必须是对象');
  return { ok: issues.length === 0, issues };
}

/** 校验后原样返回；不补默认值、不猜缺失字段。 */
export function normalizeLayoutIntent(input) {
  const checked = validateLayoutIntent(input);
  if (!checked.ok) throw Object.assign(new Error(`布局设计意图不合法：${checked.issues.join('；')}`), { code: 'LAYOUT_INTENT_INVALID', details: { issues: checked.issues } });
  return input;
}
