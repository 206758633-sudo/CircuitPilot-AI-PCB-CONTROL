/**
 * 自动化配方（确定性操作序列）。
 *
 * 配方 = 一段**确定性**的桌面/接口操作序列。AI 的职责是"选配方 + 填参数 + 读失败诊断"，
 * 而不是自由点鼠标。这样坐标漂移、弹窗顺序、语言差异都被收敛在配方内部，
 * 配方又必须通过校验、每步带读回断言，才能被执行器接受。
 *
 * Phase 0：只读配方（证明引擎是活的）。
 * Phase 1：三条写入配方（R1 打开工程 / R2 原理图同步到 PCB / R6 重建铺铜），
 *         统一按"API 优先、GUI 兜底、每次动作后读回断言"编写，并要求 write 批准。
 *
 * 结构：
 *   {
 *     id, title, version, summary,
 *     params: { projectUuid: { required: false, description: '...' } },   // 运行参数声明
 *     steps: [{
 *       id, title,
 *       action: { kind:'api', command:'project.open', params:{projectUuid:{$param:'projectUuid'}}, allowWrite?:false },
 *       expect: { readback: {kind:'api',command:'document.current'}, assertions:[...] },
 *       fallback: { actions: [{kind:'gui',action:'clickText',params:{text:'设计'}}] },  // API 失败/读回不符时兜底
 *       onFail: { retries: 0, recover: ['focus'], then: 'abort' },
 *       approval: 'write',
 *     }],
 *     rollback: [{ kind:'api', command:'document.source.restore', params:{} }],
 *   }
 *
 * 校验是 fail-closed 的：任何非人工步骤没有 expect 都直接拒绝；eval 不得写进配方；
 * `{$param:'name'}` 引用未声明的参数也直接拒绝（否则运行到一半才发现参数缺失）。
 */
import { APPROVAL_SCOPES, SAFE_GUI_ACTIONS } from './safety.mjs';
import { ASSERTION_OPS } from './verify.mjs';

export const RECIPE_SCHEMA_VERSION = 1;
export const STEP_KINDS = Object.freeze(['api', 'gui', 'human']);
export const FAIL_POLICIES = Object.freeze(['abort', 'rollback', 'human']);
export const RECIPE_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const PARAM_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

const fail = (message, extra = {}) => Object.assign(new Error(message), { code: 'AUTOMATION_RECIPE_INVALID', ...extra });

/** 收集参数引用 `{$param:'name'}`，用于校验"引用必须已声明"。 */
export function collectParamRefs(value, refs = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectParamRefs(item, refs);
  } else if (value && typeof value === 'object') {
    if (typeof value.$param === 'string') refs.add(value.$param);
    else for (const item of Object.values(value)) collectParamRefs(item, refs);
  }
  return refs;
}

function validateParamsSchema(params, { recipeId }) {
  if (params === undefined) return {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw fail(`${recipeId} 的 params 必须是对象`);
  const normalized = {};
  for (const [name, spec] of Object.entries(params)) {
    if (!PARAM_NAME_PATTERN.test(name)) throw fail(`${recipeId} 的参数名不合法：${name}`);
    if (!spec || typeof spec !== 'object') throw fail(`${recipeId} 的参数 ${name} 必须是对象`);
    const required = spec.required === undefined ? false : Boolean(spec.required);
    normalized[name] = {
      required,
      description: typeof spec.description === 'string' ? spec.description : '',
      pattern: typeof spec.pattern === 'string' ? spec.pattern : null,
      example: spec.example === undefined ? null : spec.example,
    };
  }
  return normalized;
}

function validateAction(action, { where, allowHuman = true }) {
  if (!action || typeof action !== 'object') throw fail(`${where} 缺少 action`);
  const kind = String(action.kind || '');
  if (!STEP_KINDS.includes(kind)) throw fail(`${where} 的 action.kind 必须是 ${STEP_KINDS.join('/')}，收到 ${kind}`);
  if (kind === 'human' && !allowHuman) throw fail(`${where} 不允许人工动作（兜底动作只能 api/gui）`);
  if (kind === 'api') {
    if (!action.command || typeof action.command !== 'string') throw fail(`${where} 的 api action 需要 command（bridge 命令 id）`);
    if (action.params !== undefined && (typeof action.params !== 'object' || action.params === null || Array.isArray(action.params))) throw fail(`${where} 的 api params 必须是对象`);
    if (action.allowWrite !== undefined && typeof action.allowWrite !== 'boolean') throw fail(`${where} 的 api allowWrite 必须是布尔`);
  }
  if (kind === 'gui') {
    if (!SAFE_GUI_ACTIONS.includes(action.action)) throw fail(`${where} 的 gui action 不在安全白名单内：${action.action}（eval 不允许写进配方）`);
    if (action.params !== undefined && (typeof action.params !== 'object' || action.params === null || Array.isArray(action.params))) throw fail(`${where} 的 gui params 必须是对象`);
  }
  if (kind === 'human') {
    if (!action.action || typeof action.action !== 'string') throw fail(`${where} 的 human action 需要 action 名称（例如 upload-dfm）`);
    if (!action.instructions || typeof action.instructions !== 'string') throw fail(`${where} 的 human action 需要 instructions（要人做什么）`);
  }
  return { ...action, kind };
}

function validateReadback(readback, { where, allowCompose = true }) {
  if (!readback || typeof readback !== 'object') throw fail(`${where} 的 readback 缺失`);
  if (readback.kind === 'compose') {
    if (!allowCompose) throw fail(`${where} 的 compose readback 不能嵌套`);
    if (!readback.reads || typeof readback.reads !== 'object' || Array.isArray(readback.reads) || Object.keys(readback.reads).length === 0) {
      throw fail(`${where} 的 compose readback 需要非空 reads`);
    }
    const reads = {};
    for (const [name, read] of Object.entries(readback.reads)) {
      if (!PARAM_NAME_PATTERN.test(name)) throw fail(`${where} 的 compose 读回名不合法：${name}`);
      reads[name] = validateReadback(read, { where: `${where}（${name}）`, allowCompose: false });
    }
    return { kind: 'compose', reads };
  }
  if (readback.kind !== 'api' && readback.kind !== 'gui') throw fail(`${where} 的 readback.kind 必须是 api / gui / compose`);
  if (readback.kind === 'api' && !readback.command) throw fail(`${where} 的 api readback 需要 command`);
  if (readback.kind === 'gui' && !SAFE_GUI_ACTIONS.includes(readback.action)) throw fail(`${where} 的 gui readback 不在白名单内：${readback.action}`);
  return { ...readback };
}

function validateExpect(expect, { where, kind }) {
  if (kind === 'human') {
    if (expect !== undefined && expect !== null) throw fail(`${where} 是人工步骤，不需要 expect`);
    return null;
  }
  if (!expect || typeof expect !== 'object') throw fail(`${where} 缺少 expect：没有读回断言的步骤等于假通过`);
  const readback = validateReadback(expect.readback, { where });
  if (!Array.isArray(expect.assertions) || expect.assertions.length === 0) throw fail(`${where} 的 expect.assertions 不能为空`);
  for (const assertion of expect.assertions) {
    if (!assertion || typeof assertion !== 'object') throw fail(`${where} 的断言必须是对象`);
    if (typeof assertion.path !== 'string') throw fail(`${where} 的断言缺少 path`);
    const op = assertion.op || 'equals';
    if (!ASSERTION_OPS.includes(op)) throw fail(`${where} 的断言 op 不支持：${op}`);
    if (['matches'].includes(op)) {
      try { new RegExp(String(assertion.value), 'i'); } catch { throw fail(`${where} 的 matches 正则无效：${assertion.value}`); }
    }
    if (['equalsPath', 'atLeastPath', 'atMostPath'].includes(op) && typeof assertion.value !== 'string') throw fail(`${where} 的 ${op} 需要 value 为另一个读回路径`);
  }
  // 读回重试次数与"动作重试"分开：写动作绝不重放，但读回遇到桥的瞬时 500 可以只重读。
  const readRetries = expect.readRetries === undefined ? null : Number(expect.readRetries);
  if (readRetries !== null && (!Number.isInteger(readRetries) || readRetries < 0 || readRetries > 3)) throw fail(`${where} 的 expect.readRetries 必须是 0-3 的整数`);
  return { readback, assertions: expect.assertions, readRetries };
}

function validateFallback(fallback, { where, recipeParams }) {
  if (fallback === undefined || fallback === null) return null;
  if (!Array.isArray(fallback.actions) || fallback.actions.length === 0) throw fail(`${where} 的 fallback 需要非空 actions 数组`);
  const actions = fallback.actions.map((action, index) => validateAction(action, { where: `${where} 的 fallback #${index + 1}`, allowHuman: false }));
  for (const action of actions) {
    for (const ref of collectParamRefs(action.params || {})) {
      if (!recipeParams[ref]) throw fail(`${where} 的 fallback 引用了未声明参数：${ref}`);
    }
  }
  return { actions };
}

function validateOnFail(onFail, { where }) {
  if (onFail === undefined || onFail === null) return { retries: 0, recover: [], then: 'abort' };
  if (typeof onFail !== 'object') throw fail(`${where} 的 onFail 必须是对象`);
  const retries = onFail.retries === undefined ? 0 : Number(onFail.retries);
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw fail(`${where} 的 onFail.retries 必须是 0-5 的整数`);
  const recover = onFail.recover === undefined ? [] : onFail.recover;
  if (!Array.isArray(recover) || recover.some((item) => item !== 'focus')) throw fail(`${where} 的 onFail.recover 目前只支持 ['focus']`);
  const then = onFail.then || 'abort';
  if (!FAIL_POLICIES.includes(then)) throw fail(`${where} 的 onFail.then 必须是 ${FAIL_POLICIES.join('/')}`);
  return { retries, recover, then };
}

/** 校验并规范化配方；任何不合规都抛 AUTOMATION_RECIPE_INVALID。 */
/**
 * 配方变更记录（E6）：版本号不是摆设——升级必须写清"改了什么、为什么"，回放/回归可追溯。
 * 真机教训：R2 的 GUI 兜底菜单文案随 EDA 版本变化（3.2.186 找不到“更新/转换原理图到 PCB”），
 * 所以文案定位失败会给出 attemptedTexts + 能力探测提示，而不是无限重试。
 */
export const RECIPE_CHANGELOG = Object.freeze({
  'eda-read-state': { 1: { at: '2026-10-19', note: '初始只读状态读取，读回断言 URL/标题。' } },
  'eda-read-project': { 1: { at: '2026-10-19', note: '初始只读工程读取。' } },
  'eda-read-document': { 1: { at: '2026-10-19', note: '初始只读文档读取。' } },
  'eda-screenshot-evidence': { 1: { at: '2026-10-19', note: '只读取证截图，不写入设计。' } },
  'eda-open-project': { 1: { at: '2026-10-19', note: '打开工程并读回确认（写作用域：打开文档视为写入需 write 批准）。' } },
  'pcb-sync-from-schematic': {
    1: { at: '2026-10-19', note: '首版：importChanges 后读回 PCB 器件数；GUI 兜底菜单文案随版本漂移。' },
    2: { at: '2026-10-19', note: '读回改为 PCB 上下文 pcb.placement.read + expectedComponentCount；新增 readRetries（只重读不重放）；clickText 增加文案 alternatives 与漂移诊断。' },
  },
  'pcb-rebuild-pours': {
    1: { at: '2026-10-19', note: '铺铜重建 + 读回铺铜数/器件数/网络数；GUI 兜底菜单文案定位。' },
  },
  'pcb-create-pour': {
    1: { at: '2026-10-19', note: '新增：A11 新建覆铜（createComplexPolygon + PrimitivePour.create），读回 detail 断言数量/属性，不重放创建动作。' },
    2: { at: '2026-10-19', note: 'E8 半写收敛：新增 required 参数 existingPourIds（运行前快照），onFail.then=rollback，回退用 pcb.pour.deleteAdded 差集删除本次新增覆铜；读回不符不再留在板上。' },
  },
});

/** 收集回退动作里的 `{$result:'stepId...'}` 引用。 */
function collectResultRefs(value, refs = []) {
  if (Array.isArray(value)) { for (const item of value) collectResultRefs(item, refs); return refs; }
  if (value && typeof value === 'object') {
    if (typeof value.$result === 'string') refs.push(value.$result.split('.')[0]);
    else for (const item of Object.values(value)) collectResultRefs(item, refs);
  }
  return refs;
}

export function validateRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') throw fail('配方必须是对象');
  if (!RECIPE_ID_PATTERN.test(String(recipe.id || ''))) throw fail(`配方 id 必须匹配 ${RECIPE_ID_PATTERN}，收到 ${recipe.id}`);
  if (!recipe.title || typeof recipe.title !== 'string') throw fail(`${recipe.id} 缺少 title`);
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) throw fail(`${recipe.id} 的 steps 不能为空`);
  const version = recipe.version === undefined ? 1 : Number(recipe.version);
  if (!Number.isInteger(version) || version < 1) throw fail(`${recipe.id} 的 version 必须是正整数`);
  const params = validateParamsSchema(recipe.params, { recipeId: recipe.id });
  const stepIds = new Set();
  const steps = recipe.steps.map((step, index) => {
    if (!step || typeof step !== 'object') throw fail(`${recipe.id} 第 ${index + 1} 步不是对象`);
    const where = `${recipe.id} 步骤 ${step.id || `#${index + 1}`}`;
    if (!step.id || typeof step.id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(step.id)) throw fail(`${where} 的 id 不合法`);
    if (stepIds.has(step.id)) throw fail(`${recipe.id} 步骤 id 重复：${step.id}`);
    stepIds.add(step.id);
    const action = validateAction(step.action, { where });
    const expect = validateExpect(step.expect, { where, kind: action.kind });
    const onFail = validateOnFail(step.onFail, { where });
    const fallback = validateFallback(step.fallback, { where, recipeParams: params });
    let approval = step.approval;
    if (approval !== undefined && approval !== null && !APPROVAL_SCOPES.includes(approval)) throw fail(`${where} 的 approval 必须是 ${APPROVAL_SCOPES.join('/')}`);
    // E11：evidence 是行为契约的一部分（before/after 截图），校验后必须**保留**在规范化步骤里；
    // 之前这里只返回值里没有 evidence，导致配方声明了截图证据但 runner 永远读不到（静默丢失证据）。
    let evidence = null;
    if (step.evidence !== undefined && step.evidence !== null) {
      if (typeof step.evidence !== 'object' || Array.isArray(step.evidence)) throw fail(`${where} 的 evidence 必须是对象`);
      for (const key of Object.keys(step.evidence)) if (key !== 'screenshot') throw fail(`${where} 的 evidence 含未知字段：${key}`);
      if (step.evidence.screenshot !== undefined && typeof step.evidence.screenshot !== 'boolean') throw fail(`${where} 的 evidence.screenshot 必须是布尔值`);
      evidence = { screenshot: step.evidence.screenshot === true };
    }
    const guiWrite = action.kind === 'gui' && !['state', 'targets', 'screenshot', 'focus', 'waitText', 'move'].includes(action.action);
    const apiWrite = action.kind === 'api' && action.allowWrite === true;
    if ((guiWrite || apiWrite || fallback) && approval === undefined && approval !== null) approval = 'write';
    // 参数引用必须已声明（参数只出现在 action/readback params 与断言 value 里）
    const refs = collectParamRefs(action.params || {});
    if (expect) collectParamRefs(expect.assertions, refs);
    if (expect) collectParamRefs(expect.readback, refs);
    for (const ref of refs) if (!params[ref]) throw fail(`${where} 引用了未声明参数：${ref}`);
    return { id: step.id, title: step.title || step.id, action, expect, fallback, onFail, approval: approval ?? null, evidence };
  });
  const requiredApprovals = new Set(Array.isArray(recipe.requiredApprovals) ? recipe.requiredApprovals : []);
  for (const scope of requiredApprovals) if (!APPROVAL_SCOPES.includes(scope)) throw fail(`${recipe.id} 的 requiredApprovals 含未知作用域：${scope}`);
  for (const step of steps) if (step.approval) requiredApprovals.add(step.approval);
  const rollback = recipe.rollback === undefined ? [] : recipe.rollback;
  if (!Array.isArray(rollback)) throw fail(`${recipe.id} 的 rollback 必须是数组`);
  const normalizedRollback = rollback.map((step, index) => validateAction(step, { where: `${recipe.id} rollback #${index + 1}` }));
  for (const step of normalizedRollback) {
    for (const ref of collectResultRefs(step.params || {})) {
      if (!stepIds.has(ref)) throw fail(`${recipe.id} 的回退动作引用了不存在的步骤结果：${ref}`);
    }
  }
  return {
    schemaVersion: RECIPE_SCHEMA_VERSION,
    id: recipe.id,
    title: recipe.title,
    version,
    summary: recipe.summary || '',
    params,
    requiredApprovals: [...requiredApprovals],
    steps,
    rollback: normalizedRollback,
  };
}

/** 配方注册表：启动时全量校验，重复 id 直接拒绝。 */
export function createRecipeRegistry(definitions = []) {
  const map = new Map();
  for (const definition of definitions) {
    const recipe = validateRecipe(definition);
    if (map.has(recipe.id)) throw fail(`配方 id 重复注册：${recipe.id}`);
    map.set(recipe.id, recipe);
  }
  return {
    get: (id) => map.get(String(id || '')) || null,
    list: () => [...map.values()],
    summaries: () => [...map.values()].map((recipe) => ({
      id: recipe.id,
      title: recipe.title,
      version: recipe.version,
      summary: recipe.summary,
      stepCount: recipe.steps.length,
      requiredApprovals: recipe.requiredApprovals,
      params: recipe.params,
      steps: recipe.steps.map((step) => ({
        id: step.id,
        title: step.title,
        kind: step.action.kind,
        action: step.action.kind === 'api' ? step.action.command : step.action.action,
        approval: step.approval,
        policy: step.onFail.then,
        fallback: step.fallback ? step.fallback.actions.length : 0,
      })),
    })),
  };
}

// —— 内置配方 ——————————————————————————————————————————————

const GUI_READBACK_STATE = { kind: 'gui', action: 'state' };
const GUI_STATE_EXPECT = {
  readback: GUI_READBACK_STATE,
  assertions: [
    { path: 'url', op: 'matches', value: 'easyeda|lceda', label: '页面 URL 属于 EDA' },
    { path: 'text', op: 'nonEmpty', label: '页面有可读文本' },
  ],
};

export const BUILTIN_RECIPE_DEFINITIONS = Object.freeze([
  // —— 只读 ——
  {
    id: 'eda-read-state',
    title: '读取嘉立创EDA 当前页面状态',
    version: 1,
    summary: '通过 GUI 通道读取 url/在线状态/标签页文本，并断言目标确实是 EDA 页面。',
    steps: [{
      id: 'read-page-state',
      title: '读取页面状态',
      action: { kind: 'gui', action: 'state' },
      expect: GUI_STATE_EXPECT,
      onFail: { retries: 2, recover: ['focus'], then: 'abort' },
    }],
  },
  {
    id: 'eda-read-project',
    title: '读取 EDA 当前工程',
    version: 1,
    summary: '通过 bridge 只读命令读取当前工程，并断言工程数据非空。',
    steps: [{
      id: 'read-project',
      title: '读取当前工程',
      action: { kind: 'api', command: 'project.current', params: {} },
      expect: {
        readback: { kind: 'api', command: 'project.current', params: {} },
        assertions: [{ path: 'data', op: 'nonEmpty', label: '工程数据非空' }],
      },
      onFail: { retries: 1, recover: [], then: 'abort' },
    }],
  },
  {
    id: 'eda-read-document',
    title: '读取 EDA 当前文档标识',
    version: 1,
    summary: '通过 bridge 读取当前文档，断言拿到 uuid（后续配方用它绑定目标）。',
    steps: [{
      id: 'read-document',
      title: '读取当前文档',
      action: { kind: 'api', command: 'document.current', params: {} },
      expect: {
        readback: { kind: 'api', command: 'document.current', params: {} },
        assertions: [{ path: 'uuid', op: 'nonEmpty', label: '文档 uuid 非空' }],
      },
      onFail: { retries: 1, recover: [], then: 'abort' },
    }],
  },
  {
    id: 'eda-screenshot-evidence',
    title: '采集 EDA 页面截图证据',
    version: 1,
    summary: '对 EDA 页面截图并记录 sha256，作为自动化操作的视觉证据。',
    steps: [{
      id: 'capture',
      title: '截图',
      action: { kind: 'gui', action: 'screenshot' },
      expect: {
        readback: { kind: 'gui', action: 'screenshot' },
        assertions: [{ path: 'bytes', op: 'atLeast', value: 1024, label: '截图字节数' }],
      },
      onFail: { retries: 1, recover: ['focus'], then: 'abort' },
      evidence: { screenshot: true },
    }],
  },
  // —— 写入（Phase 1）：API 优先 / GUI 兜底 / 读回断言 ————————————
  {
    id: 'eda-open-project',
    title: '打开 EDA 工程（API 优先，工程树双击兜底）',
    version: 1,
    summary: '先用官方 project.open(uuid)；失败时通过受信任双击在工程树里打开，最后用只读读回断言工程/文档已就绪。',
    params: {
      projectUuid: { required: false, description: '工程 UUID（project.current 里的 id/uuid；不填则走 GUI 兜底）' },
      projectText: { required: true, description: '工程名（左侧工程树里显示的名称，用于兜底双击）' },
      documentText: { required: false, description: '要打开的文档名（默认 PCB1）', example: 'PCB1' },
    },
    requiredApprovals: ['write'],
    steps: [{
      id: 'open-project',
      title: '打开工程并等待文档就绪',
      action: { kind: 'api', command: 'project.open', params: { projectUuid: { $param: 'projectUuid' } } },
      expect: {
        readback: {
          kind: 'compose',
          reads: {
            project: { kind: 'api', command: 'project.current' },
            document: { kind: 'api', command: 'document.current' },
          },
        },
        assertions: [
          { path: 'project.data', op: 'nonEmpty', label: '工程数据非空' },
          { path: 'document.uuid', op: 'nonEmpty', label: '当前文档 uuid 非空' },
        ],
      },
      fallback: {
        actions: [
          { kind: 'gui', action: 'focus', params: {} },
          { kind: 'gui', action: 'dblclick', params: { text: { $param: 'projectText' }, exact: false } },
          { kind: 'gui', action: 'dblclick', params: { text: { $param: 'documentText' }, exact: false } },
        ],
      },
      // 打开工程是文档生命周期命令：真机上 EDA 需要一点时间才恢复 currentProject/currentDocument，
      // 所以允许有限读回重试（只重读，不重放打开动作）。
      onFail: { retries: 3, recover: ['focus'], then: 'abort' },
    }],
  },
  {
    id: 'pcb-sync-from-schematic',
    title: '原理图变更同步到 PCB（API 优先，菜单兜底）',
    version: 2,
    summary: '先走 pcb_Document.importChanges；若读回不符，则通过"设计 → 更新/转换原理图到 PCB"菜单兜底（带 menu-text alternatives），并用只读读回比较两侧数量。',
    params: {
      schematicUuid: { required: false, description: '原理图文档 UUID（importChanges 的参数，可空）' },
      expectedComponentCount: { required: true, description: '原理图器件数（调用方先只读读回后传入，用于判定 PCB 同步后器件数不减少）' },
    },
    requiredApprovals: ['write'],
    steps: [{
      id: 'import-changes',
      title: '导入原理图变更并回读两侧器件数',
      action: { kind: 'api', command: 'pcb.importChanges', params: { schematicUuid: { $param: 'schematicUuid' } }, allowWrite: true },
      expect: {
        // 只在 PCB 文档上下文读回：`schematic.*` 命令在 PCB 是活动文档时真机必 500（实测），
        // 所以原理图器件数由调用方先只读拿到，通过 expectedComponentCount 传入比较。
        readback: { kind: 'api', command: 'pcb.placement.read' },
        assertions: [
          { path: 'components', op: 'nonEmpty', label: 'PCB 器件非空' },
          { path: 'componentCount', op: 'atLeast', value: { $param: 'expectedComponentCount' }, label: 'PCB 器件数 ≥ 原理图器件数' },
        ],
        // 桥对读命令偶发 HTTP 500（渲染进程抢焦点时尤其明显）：只重读，不重放 importChanges。
        readRetries: 2,
      },
      fallback: {
        actions: [
          { kind: 'gui', action: 'clickText', params: { text: '设计' } },
          { kind: 'gui', action: 'clickText', params: { text: '更新/转换原理图到 PCB', exact: false, alternatives: ['更新PCB', '更新原理图到 PCB', 'Update PCB', '更新/转换原理图到PCB'] } },
          { kind: 'gui', action: 'clickText', params: { text: '应用', exact: false } },
        ],
      },
      onFail: { retries: 0, recover: ['focus'], then: 'abort' },
    }],
  },
  {
    id: 'pcb-rebuild-pours',
    title: '重建 PCB 铺铜填充（API 优先，铺铜管理器兜底）',
    version: 1,
    summary: '先用 pcb_PrimitivePour.rebuildCopperRegion；读回不到铺铜图元时用"工具 → 铺铜管理器 → 重建所有"GUI 兜底，最后断言铺铜图元存在。',
    requiredApprovals: ['write'],
    steps: [{
      id: 'rebuild-pours',
      title: '重建铺铜并回读铺铜图元',
      action: { kind: 'api', command: 'pcb.pour.rebuild', params: {}, allowWrite: true },
      expect: {
        readback: { kind: 'api', command: 'pcb.pours.read' },
        assertions: [{ path: '', op: 'nonEmpty', label: '铺铜图元非空' }],
      },
      fallback: {
        actions: [
          { kind: 'gui', action: 'focus', params: {} },
          { kind: 'gui', action: 'clickText', params: { text: '工具' } },
          { kind: 'gui', action: 'clickText', params: { text: '铺铜管理器', exact: false } },
          { kind: 'gui', action: 'clickText', params: { text: '重建所有', exact: false } },
          { kind: 'gui', action: 'clickText', params: { text: '确认', exact: false } },
        ],
      },
      onFail: { retries: 0, recover: ['focus'], then: 'abort' },
      evidence: { screenshot: true },
    }],
  },
  {
    // A11：R6 只有"重建"，没有"新建"。新建走真机验证过的
    // PCB_MathPolygon.createComplexPolygon + PCB_PrimitivePour.create(net,layer,cp,...)；
    // outline 为原生单位（mil）的 [[x,y],...]，由调用方从板框内缩/规划得到。
    id: 'pcb-create-pour',
    title: '新建 PCB 覆铜（API 优先，读回断言数量与属性）',
    version: 2,
    summary: '按 net/layer/outline 新建覆铜；读回 pcb.pours.detail 断言数量增加且属性可读。写入必须消费 write 批准，失败不重放创建动作。',
    requiredApprovals: ['write'],
    params: {
      net: { required: true, description: '覆铜网络名（如 GND）' },
      layer: { required: true, description: '覆铜铜层编号（1=顶层）' },
      outline: { required: true, description: '覆铜多边形顶点数组 [[x,y],...]，原生单位 mil' },
      pourName: { required: false, description: '覆铜名称（默认取 net）' },
      expectedPourCount: { required: true, description: '创建后应达到的覆铜图元总数（调用方先只读现有数量 +1）' },
      existingPourIds: { required: true, description: '运行前覆铜图元 id 快照（半写回滚用它做差集，只删本次新增；调用方先只读 pcb.pours.detail）' },
    },
    rollback: [
      { kind: 'api', command: 'pcb.pour.deleteAdded', params: { existingIds: { $param: 'existingPourIds' } }, allowWrite: true },
    ],
    steps: [{
      id: 'create-pour',
      title: '新建覆铜并读回',
      action: { kind: 'api', command: 'pcb.pour.create', params: { net: { $param: 'net' }, layer: { $param: 'layer' }, outline: { $param: 'outline' }, pourName: { $param: 'pourName' } }, allowWrite: true },
      expect: {
        readback: { kind: 'compose', reads: { pours: { kind: 'api', command: 'pcb.pours.detail' } } },
        assertions: [
          { path: 'pours', op: 'nonEmpty', label: '覆铜图元非空' },
          { path: 'pours.length', op: 'atLeast', value: { $param: 'expectedPourCount' }, label: '覆铜数量达到预期' },
        ],
        readRetries: 2,
      },
      onFail: { retries: 0, recover: ['focus'], then: 'rollback' },
      evidence: { screenshot: true },
    }],
  },
]);

export function createDefaultRecipeRegistry() {
  return createRecipeRegistry(BUILTIN_RECIPE_DEFINITIONS);
}

export { ASSERTION_OPS };
