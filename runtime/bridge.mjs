import { BRIDGE_PORTS } from './config.mjs';
import { LAYER_IDS, isEdaCopperLayerCount } from './engineering/layers.mjs';
import { BOARD_OUTLINE_HELP, assertPrimitiveLayerSupports, milToMm, rectPolygonSource, OUTLINE_LINE_WIDTH_MIL } from './engineering/eda-primitives.mjs';
import { EdaJobStore, cancelJobCode, isJobId, listJobsCode, normalizeJobSnapshot, pollJobCode, sessionCode, startJobCode } from './engineering/eda-jobs.mjs';

/**
 * 每条命令的默认传输超时。改造前这里对所有命令一律 8s，导致真实板上的 DRC、
 * 大铺铜、3D/STEP 导出**永远不可能成功**（而 PcbManager 还写着 30s 操作超时，根本够不到）。
 * 现在按命令给预算；超过这个量级的调用应当走 pcb.job.* 后台任务模型，而不是硬等。
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
/**
 * 按命令类型决定传输预算。
 *
 * 为什么需要：真机上 `workspace.create`（建工程 + 建原理图 + 建 PCB + 打开文档）实测 >8s，
 * 旧代码对所有命令一律 8s，结果这条命令**必然**以 "This operation was aborted" 收场——
 * 而这类失败看起来像网络问题，实际是预算写错了。凡是"重活"都必须显式给够预算，
 * 或者改走 pcb.job.* 后台任务模型。
 */
export function commandTimeoutMs(commandId) {
  // 真机教训：60s 曾把工程创建打爆，留下“工程已建、板/原理图/PCB 全空”的半成品。
  // 取传输层上限（超过也会被 MAX_TRANSPORT_TIMEOUT_MS 截断，写更大只是自欺）；
  // 真正的修复是调用顺序（见 workspace.create 的 buildCode）。
  if (commandId === 'workspace.create') return MAX_TRANSPORT_TIMEOUT_MS;
  if (['schematic.open', 'pcb.open', 'pcb.layers.setCount'].includes(commandId)) return 30_000;
  if (commandId.endsWith('.read') || commandId === 'library.device.search') return 20_000;
  return DEFAULT_COMMAND_TIMEOUT_MS;
}
/** 桥接服务端自身有 120s 上限，客户端预算必须留在它以内，否则拿到的是服务端超时而不是真实结果。 */
const MAX_TRANSPORT_TIMEOUT_MS = 110_000;

/**
 * 分片读取导出缓冲的源码生成器：3D 与制造文件（Gerber/BOM/CPL）**共用同一实现**。
 * 这条通道里"半截文件算不算成功"的判断只允许有一处，否则迟早出现"某个格式悄悄丢了尾巴"。
 */
const buildExportChunkCode = ({ exportId, index }) => `return await (async () => {
  const cache = globalThis.__circuitpilotExportCache;
  const entry = cache && cache.entries ? cache.entries[${JSON.stringify(exportId)}] : null;
  if (!entry) return { error: 'EDA_EXPORT_BUFFER_LOST' };
  const chunkSize = 262144;
  const total = Math.ceil(entry.size / chunkSize);
  const i = ${JSON.stringify(index)};
  if (!Number.isInteger(i) || i < 0 || i >= total) return { error: 'EDA_EXPORT_CHUNK_RANGE', total };
  const start = i * chunkSize;
  const buffer = await entry.file.slice(start, Math.min(start + chunkSize, entry.size)).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 8192));
  return { index: i, total, bytes: bytes.length, size: entry.size, base64: btoa(binary) };
})();`;

const COMMANDS = Object.freeze({
  'project.current': {
    permission: 'read',
    description: '读取当前工程详细属性',
    signature: 'DMT_Project.getCurrentProjectInfo(): Promise<IDMT_ProjectItem | undefined>',
    code: 'return await eda.dmt_Project.getCurrentProjectInfo();',
  },
  'document.current': {
    permission: 'read',
    description: '读取最后获得焦点的当前文档属性',
    signature: 'DMT_SelectControl.getCurrentDocumentInfo(): Promise<IDMT_EditorDocumentItem | undefined>',
    code: 'return await eda.dmt_SelectControl.getCurrentDocumentInfo();',
  },
  'workspace.create': {
    permission: 'write-beta', longRunning: 'document-lifecycle',
    description: '创建并打开受控嘉立创EDA工程、原理图和PCB（官方Beta）',
    signature: 'DMT_Project.createProject/openProject + DMT_Board.createBoard + DMT_Schematic.createSchematic/createSchematicPage + DMT_Pcb.createPcb + DMT_EditorControl.openDocument/activateDocument',
    buildCode: ({ friendlyName, projectName, description = '' }) => `const projectUuid=await eda.dmt_Project.createProject(${JSON.stringify(friendlyName)},${JSON.stringify(projectName)},undefined,undefined,${JSON.stringify(description)});if(!projectUuid)throw new Error('PROJECT_CREATE_FAILED');const opened=await eda.dmt_Project.openProject(projectUuid);if(!opened)throw new Error('PROJECT_OPEN_FAILED');const schematicUuid=await eda.dmt_Schematic.createSchematic();if(!schematicUuid)throw new Error('SCHEMATIC_CREATE_FAILED');const schematicPageUuid=await eda.dmt_Schematic.createSchematicPage(schematicUuid);if(!schematicPageUuid)throw new Error('SCHEMATIC_PAGE_CREATE_FAILED');const pcbUuid=await eda.dmt_Pcb.createPcb();if(!pcbUuid)throw new Error('PCB_CREATE_FAILED');const boardName=await eda.dmt_Board.createBoard(schematicUuid,pcbUuid);if(!boardName)throw new Error('BOARD_CREATE_FAILED');const tabId=await eda.dmt_EditorControl.openDocument(pcbUuid);if(!tabId)throw new Error('PCB_OPEN_FAILED');const activated=await eda.dmt_EditorControl.activateDocument(tabId);return {projectUuid,boardName,schematicUuid,schematicPageUuid,pcbUuid,tabId,activated,project:await eda.dmt_Project.getCurrentProjectInfo(),document:await eda.dmt_SelectControl.getCurrentDocumentInfo()};`,
  },
  'schematic.catalog': {
    permission: 'read', description: '读取原理图与页面目录',
    signature: 'DMT_Schematic.getAllSchematicsInfo/getAllSchematicPagesInfo',
    code: 'return { schematics: await eda.dmt_Schematic.getAllSchematicsInfo(), pages: await eda.dmt_Schematic.getAllSchematicPagesInfo() };',
  },
  /**
   * 打开原理图并激活。**真机踩坑**：`openDocument` 要的是**页面 uuid**（p1 的 `d0787ce602b31e26`），
   * 传文档 uuid（schematic1 的 `2aa6c91fb7c063e3`）会返回空 → 网表导出静默拿到 null。
   * 所以这里两种 id 都试，并把"试过什么、哪个成功"一并回传，避免又出现"没报错但什么都没发生"。
   */
  'schematic.open': {
    permission: 'navigate', longRunning: 'document-lifecycle',
    description: '打开指定原理图页面并激活标签页（documentUuid 与 pageUuid 都接受，优先用能成功的那一个）',
    signature: 'DMT_EditorControl.openDocument(pageUuid) + activateDocument(tabId)',
    buildCode: ({ documentUuid = null, pageUuid = null }) => `const candidates=[${JSON.stringify(documentUuid)},${JSON.stringify(pageUuid)}].filter((id)=>typeof id==='string'&&id.length);
const tried=[];
for(const id of candidates){
  let tabId=null;
  try{ tabId=await eda.dmt_EditorControl.openDocument(id); }catch(caught){ tried.push({id,tabId:null,error:String(caught&&caught.message||caught).slice(0,120)}); continue; }
  tried.push({id,tabId:tabId||null});
  if(tabId) return {opened:true,tabId,activated:await eda.dmt_EditorControl.activateDocument(tabId),usedId:id,tried};
}
return {opened:false,tried};`,
  },
  'schematic.components': {
    permission: 'read', description: '读取当前原理图全部元件及引脚',
    signature: 'SCH_PrimitiveComponent.getAll/getAllPinsByPrimitiveId',
    code: 'const components = (await eda.sch_PrimitiveComponent.getAll()) || []; const pins = {}; for (const item of components) { const id = item.primitiveId || item.id; if (id) pins[id] = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)) || []; } return { components, pins };',
  },
  /**
   * 只读"器件"（componentType=part）：R2 同步要比较的是**器件数**，
   * 而 `schematic.components` 还包含网络标识/图框（真机本板 593 个图元里只有 180 个器件），
   * 直接拿图元总数和 PCB 器件数比会永远失败。这里返回数组，让配方用 `schematic.length` 比较。
   */
  'schematic.parts.read': {
    permission: 'read', description: '读取当前原理图器件列表（仅 componentType=part）',
    signature: 'SCH_PrimitiveComponent.getAll().filter(componentType==="part")',
    code: 'return ((await eda.sch_PrimitiveComponent.getAll())||[]).filter((item)=>item&&item.componentType==="part");',
  },
  'schematic.wires': {
    permission: 'read', description: '读取当前原理图全部导线',
    signature: 'SCH_PrimitiveWire.getAll()', code: 'return (await eda.sch_PrimitiveWire.getAll()) || [];',
  },
  'library.device.search': {
    permission: 'read', description: '按关键词或立创C编号搜索嘉立创EDA器件库（官方Beta）',
    signature: 'LIB_Device.search / LIB_Device.getByLcscIds',
    buildCode: ({ query, mode = 'keyword', limit = 20, page = 1 }) => mode === 'lcsc'
      ? `return (await eda.lib_Device.getByLcscIds(${JSON.stringify(query)}))||[];`
      : `return (await eda.lib_Device.search(${JSON.stringify(query)},undefined,undefined,undefined,${JSON.stringify(limit)},${JSON.stringify(page)}))||[];`,
  },
  'schematic.wire.read': {
    permission: 'read', description: '按写入返回的图元 ID 精确回读导线',
    signature: 'SCH_PrimitiveWire.get(primitiveIds)',
    buildCode: ({ primitiveIds }) => `return await eda.sch_PrimitiveWire.get(${JSON.stringify(primitiveIds)});`,
  },
  'document.source.read': {
    permission: 'sensitive-read', description: '读取当前文档源码以建立受保护快照',
    signature: 'SYS_FileManager.getDocumentSource()', code: 'return await eda.sys_FileManager.getDocumentSource();',
  },
  'document.source.restore': {
    timeoutMs: 60_000, longRunning: 'document-lifecycle', permission: 'write', description: '从已批准快照恢复当前文档源码（重建整份文档，含铺铜填充，耗时以十秒计）',
    signature: 'SYS_FileManager.setDocumentSource(source)', buildCode: ({ source }) => `return await eda.sys_FileManager.setDocumentSource(${JSON.stringify(source)});`,
  },
  'schematic.component.create': {
    permission: 'write', description: '放置一个已确认库身份的原理图元件',
    signature: 'SCH_PrimitiveComponent.create(component,x,y,...)',
    buildCode: ({ component, x, y, subPartName = '', rotation = 0, mirror = false, addIntoBom = true, addIntoPcb = true }) => `return await eda.sch_PrimitiveComponent.create(${JSON.stringify(component)},${JSON.stringify(x)},${JSON.stringify(y)},${JSON.stringify(subPartName)},${JSON.stringify(rotation)},${JSON.stringify(mirror)},${JSON.stringify(addIntoBom)},${JSON.stringify(addIntoPcb)});`,
  },
  'schematic.component.designator.set': {
    permission: 'write', timeoutMs: 20_000, description: '把原理图器件位号从占位（C?）改成已标注位号，并回读确认',
    signature: 'SCH_PrimitiveComponent.modify(primitiveId,{designator})',
    buildCode: ({ primitiveId, designator }) => `const target=${JSON.stringify(primitiveId)};try{await eda.sch_PrimitiveComponent.modify(target,{designator:${JSON.stringify(designator)}});}catch(caught){return {ok:false,primitiveId:target,designator:${JSON.stringify(designator)},error:String(caught&&caught.message||caught).slice(0,120)};}const all=(await eda.sch_PrimitiveComponent.getAll())||[];const list=Array.isArray(all)?all:[];const found=list.find((item)=>item&&String(item.primitiveId||'')===String(target))||null;const readDesignator=found?((found.props&&found.props.Designator)||found.designator||null):null;return {ok:Boolean(found)&&String(readDesignator||'')===${JSON.stringify(designator)},primitiveId:target,designator:readDesignator,items:all.length};`,
  },
  'schematic.pin.noConnect': {
    permission: 'write', description: '为本次计划新建器件的明确未使用引脚设置未连接标识',
    signature: 'SCH_PrimitiveComponent.getAllPinsByPrimitiveId + ISCH_PrimitivePin.setState_NoConnected/done',
    buildCode: ({ componentPrimitiveId, pinNumbers }) => `const pins=(await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(${JSON.stringify(componentPrimitiveId)}))||[];const wanted=new Set(${JSON.stringify(pinNumbers)}.map(String));const matched=[];for(const pin of pins){const number=String(pin.pinNumber);if(wanted.has(number)){pin.setState_NoConnected(true);await pin.done();matched.push(number);}}return {componentPrimitiveId:${JSON.stringify(componentPrimitiveId)},pinNumbers:matched};`,
  },
  'schematic.netFlag.create': {
    permission: 'write', description: '创建电源或地网络标识', signature: 'SCH_PrimitiveComponent.createNetFlag(...)',
    buildCode: ({ identification, net, x, y, rotation = 0, mirror = false }) => `return await eda.sch_PrimitiveComponent.createNetFlag(${JSON.stringify(identification)},${JSON.stringify(net)},${JSON.stringify(x)},${JSON.stringify(y)},${JSON.stringify(rotation)},${JSON.stringify(mirror)});`,
  },
  /**
   * 网络端口（连接用标签）：本板原理图的网络名就是靠这种图元承载的
   * （实机读回：60 个 `componentType: 'netport'` 图元，name = SCL/SDA/GND…，且正好落在引脚坐标上）。
   * 有了它，新增元件就能"按网络名挂接"，不必在密集引脚区拉长导线——
   * 长导线穿过引脚列会把不该连的网络短接，是这类自动修复最容易炸的地方。
   *
   * 签名由真机 `createNetPort.toString()` 解码：`createNetPort(portType, net, x, y, rotation, mirror)`。
   */
  'schematic.netPort.create': {
    // 真机：连写多个端口时偶发超过默认 15s 预算（EDA 渲染进程在忙），给到 30s；
    // 即使仍中止，调用方也会先读回核实是否其实已创建，再决定是否重试/回滚。
    timeoutMs: 30_000, longRunning: 'write-with-readback',
    permission: 'write', description: '在指定坐标创建网络端口（按网络名连接）', signature: 'SCH_PrimitiveComponent.createNetPort(portType,net,x,y,rotation,mirror)',
    buildCode: ({ portType, net, x, y, rotation = 0, mirror = false }) => `return await eda.sch_PrimitiveComponent.createNetPort(${JSON.stringify(portType)},${JSON.stringify(net)},${JSON.stringify(x)},${JSON.stringify(y)},${JSON.stringify(rotation)},${JSON.stringify(mirror)});`,
  },
  /**
   * 按图元 ID 精确删除。这是**唯一经真机验证可靠的撤销手段**：
   * 实测 `document.source.restore`（整文档源码重建）返回 false 且没有真的回滚——
   * 原理图里残留了 5 个电阻 + 10 个端口，是靠这个命令逐个删掉才恢复原状（68 图元 / 8 元件）。
   * 所以"自动修复"的兜底必须是它，而不是听起来更彻底的全量恢复。
   */
  'schematic.component.delete': {
    permission: 'write', description: '按图元 ID 精确删除原理图图元（撤销自动写入的可靠手段）', signature: 'SCH_PrimitiveComponent.delete(primitiveIds)',
    buildCode: ({ primitiveIds }) => `return await eda.sch_PrimitiveComponent.delete(${JSON.stringify(primitiveIds)});`,
  },
  'schematic.wire.create': {
    permission: 'write', description: '创建固定坐标原理图导线', signature: 'SCH_PrimitiveWire.create(line,net)',
    buildCode: ({ line, net = '' }) => `return await eda.sch_PrimitiveWire.create(${JSON.stringify(line)},${JSON.stringify(net)});`,
  },
  /**
   * 导出原理图网表（真机实测可用：EasyEDA 类型返回 38KB JSON）。
   *
   * 为什么它是权威"网络读回"：本机实测 `sch_Net.getAllNets()/getAllNetsName()` 在原理图
   * 文档上下文里返回 **0 条**（不可依赖），而导出的网表 JSON 同时含
   * components（Designator/Device/Footprint/Manufacturer/Supplier Part）与 nets，
   * 是"原理图到底画成了什么"的唯一可靠证据，也是与语义计划比对的对象。
   *
   * 小网表内联返回文本；大网表缓存进渲染进程，由分片命令取回（避免单次响应过大）。
   */
  'schematic.netlist.export': {
    timeoutMs: 60_000, permission: 'read',
    description: '导出原理图网表（JSON：元件+网络），小文件内联、大文件分片取回',
    signature: 'SCH_ManufactureData.getNetlistFile(fileName, netlistType)',
    buildCode: ({ fileName = 'circuitpilot-netlist', netlistType = 'EasyEDA', inlineLimit = 262144 } = {}) => `return await (async () => {
  const file = await eda.sch_ManufactureData.getNetlistFile(${JSON.stringify(fileName)}, ${JSON.stringify(netlistType)});
  if (!file) return null;
  const meta = { name: file.name, size: file.size, type: file.type || null, netlistType: ${JSON.stringify(netlistType)} };
  if (file.size <= ${JSON.stringify(inlineLimit)}) return Object.assign({}, meta, { inline: true, text: await file.text() });
  const cache = globalThis.__circuitpilotExportCache || (globalThis.__circuitpilotExportCache = { entries: {}, order: [] });
  const exportId = 'exp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const chunkSize = 262144;
  cache.entries[exportId] = { file, createdAt: Date.now(), name: file.name, size: file.size, chunkSize, text: null };
  cache.order.push(exportId);
  while (cache.order.length > 4) { const oldest = cache.order.shift(); delete cache.entries[oldest]; }
  return Object.assign({}, meta, { inline: false, exportId, chunkSize, chunks: Math.ceil(file.size / chunkSize) });
})();`,
  },
  /**
   * 大网表分片取回。
   *
   * 为什么需要：真实工程（180 个器件）导出的 EasyEDA 网表 432KB，超过内联上限 256KB；
   * 导出命令如实返回 `inline:false + exportId`，但此前**没有取回通道**，导致验收把
   * "网表太大"误报成 "netlist 为空"，R3 的 `.enet` 读回根本做不了。
   * 这里按文本切片分片返回（网表是文本，不做 base64），取回失败必须显式报错而非空串。
   */
  'schematic.netlist.chunk': {
    timeoutMs: 30_000, permission: 'read',
    description: '分片取回大网表文本（导出返回 inline=false 时使用）', signature: 'globalThis.__circuitpilotExportCache[exportId].file.text()',
    buildCode: ({ exportId, index }) => `return await (async () => {
  const cache = globalThis.__circuitpilotExportCache;
  const entry = cache && cache.entries ? cache.entries[${JSON.stringify(exportId)}] : null;
  if (!entry) return { error: 'EDA_EXPORT_BUFFER_LOST' };
  if (typeof entry.text !== 'string') entry.text = await entry.file.text();
  const chunkSize = entry.chunkSize || 262144;
  const total = Math.ceil(entry.text.length / chunkSize);
  const i = ${JSON.stringify(index)};
  if (!Number.isInteger(i) || i < 0 || i >= total) return { error: 'EDA_EXPORT_CHUNK_RANGE', total };
  return { index: i, total, text: entry.text.slice(i * chunkSize, Math.min((i + 1) * chunkSize, entry.text.length)) };
})();`,
  },
  /**
   * 导出 SPICE 仿真网表（官方 Beta，枚举只有一个取值 `Ngspice`）。
   *
   * 真机实测：本工程原理图**没有任何仿真模型绑定**（器件 simulationHint = 0），
   * 三种调用变体（无参 / 只给文件名 / 给文件名+类型）都返回 `undefined`。
   * 所以这里的契约是：**导出不到就如实返回 null**，由运行时表达成
   * `SIMULATION_NETLIST_UNAVAILABLE`，绝不允许像旧 fixture 那样编造一条"仿真证据"。
   */
  'schematic.simulation.netlist.export': {
    timeoutMs: 60_000, permission: 'read',
    description: '导出Ngspice仿真网表（无仿真模型时返回null，不伪造）',
    signature: 'SCH_ManufactureData.getSimulationNetlistFile(fileName, ESCH_SimulationNetlistType.NGSPICE)',
    buildCode: ({ fileName = 'circuitpilot-sim', netlistType = 'Ngspice', inlineLimit = 262144 } = {}) => `return await (async () => {
  const file = await eda.sch_ManufactureData.getSimulationNetlistFile(${JSON.stringify(fileName)}, ${JSON.stringify(netlistType)});
  if (!file) return null;
  const meta = { name: file.name, size: file.size, type: file.type || null, netlistType: ${JSON.stringify(netlistType)} };
  if (file.size <= ${JSON.stringify(inlineLimit)}) return Object.assign({}, meta, { inline: true, text: await file.text() });
  const cache = globalThis.__circuitpilotExportCache || (globalThis.__circuitpilotExportCache = { entries: {}, order: [] });
  const exportId = 'exp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const chunkSize = 262144;
  cache.entries[exportId] = { file, createdAt: Date.now(), name: file.name, size: file.size };
  cache.order.push(exportId);
  while (cache.order.length > 4) { const oldest = cache.order.shift(); delete cache.entries[oldest]; }
  return Object.assign({}, meta, { inline: false, exportId, chunkSize, chunks: Math.ceil(file.size / chunkSize) });
})();`,
  },
  'schematic.save': {
    permission: 'write', description: '保存当前原理图文档', signature: 'SCH_Document.save()', code: 'return await eda.sch_Document.save();',
  },
  'schematic.drc': {
    permission: 'validate', description: '运行官方原理图DRC（ERC等效检查）', signature: 'SCH_Drc.check(true,false,true)', code: 'return await eda.sch_Drc.check(true, false, true);',
  },
  'schematic.drc.ui': {
    permission: 'validate', description: '在嘉立创EDA界面打开官方原理图 DRC 结果面板',
    signature: 'SCH_Drc.check(true,true,true)', code: 'return await eda.sch_Drc.check(true, true, true);',
  },
  'pcb.context': {
    permission: 'read', description: '读取当前PCB文档、层、网络、器件与全部关键图元',
    signature: 'DMT_SelectControl.getCurrentDocumentInfo + PCB_* getAll',
    code: `const reads={
      document:()=>eda.dmt_SelectControl.getCurrentDocumentInfo(),layers:()=>eda.pcb_Layer.getAllLayers(),nets:()=>eda.pcb_Net.getAllNets(),
      components:()=>eda.pcb_PrimitiveComponent.getAll(),lines:()=>eda.pcb_PrimitiveLine.getAll(),vias:()=>eda.pcb_PrimitiveVia.getAll(),
      pours:()=>eda.pcb_PrimitivePour.getAll(),regions:()=>eda.pcb_PrimitiveRegion.getAll(),texts:()=>eda.pcb_PrimitiveString.getAll()
    };const entries=await Promise.all(Object.entries(reads).map(async([name,read])=>{try{return [name,{ok:true,value:await read()}];}catch(error){return [name,{ok:false,error:String(error&&error.message||error||'unknown')}];}}));
      const settled=Object.fromEntries(entries);const readErrors=entries.filter(([,item])=>!item.ok).map(([name,item])=>({name,error:item.error}));
      return {document:settled.document.value||null,layers:settled.layers.value||[],nets:settled.nets.value||[],components:settled.components.value||[],lines:settled.lines.value||[],vias:settled.vias.value||[],pours:settled.pours.value||[],regions:settled.regions.value||[],texts:settled.texts.value||[],readErrors};`,
  },
  'pcb.layers.read': { permission: 'read', description: '读取PCB层列表', signature: 'PCB_Layer.getAllLayers()', code: 'const items=(await eda.pcb_Layer.getAllLayers())||[];return items.map(item=>({id:item.id,name:item.name,type:item.type,color:item.color,locked:item.locked,layerStatus:item.layerStatus,transparency:item.transparency}));' },
  'pcb.layers.copperCount': { permission: 'read', description: '读取PCB铜箔层数', signature: 'PCB_Layer.getTheNumberOfCopperLayers()', code: 'return await eda.pcb_Layer.getTheNumberOfCopperLayers();' },
  'pcb.layers.setCount': { permission: 'write', longRunning: 'document-lifecycle', description: '设置PCB铜箔层数（官方Beta；新建PCB默认2层）', signature: 'PCB_Layer.setTheNumberOfCopperLayers(n)', buildCode: ({ layers }) => `const ok=await eda.pcb_Layer.setTheNumberOfCopperLayers(${JSON.stringify(layers)});if(ok!==true)throw new Error('PCB_LAYER_COUNT_FAILED');return ok;` },
  'pcb.nets.read': { permission: 'read', description: '读取PCB网络列表', signature: 'PCB_Net.getAllNets()', code: 'return await eda.pcb_Net.getAllNets();' },
  'pcb.components.read': { permission: 'read', description: '读取PCB器件图元ID', signature: 'PCB_PrimitiveComponent.getAllPrimitiveId()', code: 'return await eda.pcb_PrimitiveComponent.getAllPrimitiveId();' },
  'pcb.lines.read': { permission: 'read', description: '读取PCB线段图元ID', signature: 'PCB_PrimitiveLine.getAllPrimitiveId()', code: 'return await eda.pcb_PrimitiveLine.getAllPrimitiveId();' },
  'pcb.vias.read': { permission: 'read', description: '读取PCB过孔图元ID', signature: 'PCB_PrimitiveVia.getAllPrimitiveId()', code: 'return await eda.pcb_PrimitiveVia.getAllPrimitiveId();' },
  'pcb.pours.read': { permission: 'read', description: '读取PCB覆铜图元ID', signature: 'PCB_PrimitivePour.getAllPrimitiveId()', code: 'return await eda.pcb_PrimitivePour.getAllPrimitiveId();' },
  // A11：读回覆铜属性（网络/层/名称），用于"新建后读回断言"，不能只看数量。
  'pcb.pours.detail': { permission: 'read', description: '读取PCB覆铜详情（ID/网络/层/名称/优先级）', signature: 'PCB_PrimitivePour.getAll() + getState_*', code: `const pours=(await eda.pcb_PrimitivePour.getAll())||[];return pours.map(p=>({primitiveId:String(p.getState_PrimitiveId?.()||''),net:String(p.getState_Net?.()||''),layer:Number(p.getState_Layer?.()),pourName:String(p.getState_PourName?.()||''),pourPriority:Number(p.getState_PourPriority?.())}));` },
  'pcb.regions.read': { permission: 'read', description: '读取PCB区域图元ID', signature: 'PCB_PrimitiveRegion.getAllPrimitiveId()', code: 'return await eda.pcb_PrimitiveRegion.getAllPrimitiveId();' },
  'pcb.texts.read': { permission: 'read', description: '读取PCB文字图元ID', signature: 'PCB_PrimitiveString.getAllPrimitiveId()', code: 'return await eda.pcb_PrimitiveString.getAllPrimitiveId();' },
  // 真机实测（2026-10-16）：嘉立创EDA 重启后停在首页、不恢复上次工程，
  // 于是 `project.current` 为 null → 运行时读不到 PCB → 所有 PCB 路由都被自己的护栏挡成 409。
  // 旧行为是把这一步推给用户手点，这不符合"AI 自主操作 EDA"。官方 `dmt_Project.openProject(uuid)` 可用。
  'project.open': { timeoutMs: 60_000, longRunning: 'document-lifecycle', permission: 'navigate', description: '按工程UUID打开嘉立创EDA工程并等待其就绪', signature: 'DMT_Project.openProject(uuid)', buildCode: ({ projectUuid }) => `const ok = await eda.dmt_Project.openProject(${JSON.stringify(projectUuid)});return { opened: ok !== false, projectUuid: ${JSON.stringify(projectUuid)} };` },
  'pcb.open': { permission: 'navigate', longRunning: 'document-lifecycle', description: '打开指定PCB文档并激活标签页', signature: 'DMT_EditorControl.openDocument/activateDocument', buildCode: ({ documentUuid }) => `const tabId=await eda.dmt_EditorControl.openDocument(${JSON.stringify(documentUuid)});if(!tabId)return {opened:false};return {opened:true,tabId,activated:await eda.dmt_EditorControl.activateDocument(tabId)};` },
  /**
   * 布局读回：把"器件在哪、多大、哪一面"和"板框长什么样"一次读全（单位统一 mm）。
   *
   * 为什么要专门加：真机上 `pcb_Outline` 命名空间**不存在**（`pcb_BoardOutline.getAll` 也不是函数），
   * 板框只能从 `PCB_PrimitivePolyline` 里按层过滤；而 `pcb.components.read` 只回图元 ID、
   * 没有坐标和尺寸。没有这份读回，任何"按板框布局"都只能靠猜。
   * 原始单位是 **mil**（实测 U1 的 x=393.7008 = 10.0000 mm）。
   */
  'pcb.placement.read': {
    permission: 'read', timeoutMs: 30_000,
    description: '读取器件布局读回（位置/旋转/面/包围盒, mm）与板框多边形（mm）',
    signature: 'PCB_PrimitiveComponent.getAll + PCB_Primitive.getPrimitivesBBox + PCB_PrimitivePolyline.getAll',
    code: `const toMm=(v)=>v*25.4/1000;
const comps=(await eda.pcb_PrimitiveComponent.getAll())||[];
const items=[];
for(const item of comps){
  let box=null;
  try{ const b=await eda.pcb_Primitive.getPrimitivesBBox([item.primitiveId]); if(b) box={xMm:toMm(b.maxX-b.minX),yMm:toMm(b.maxY-b.minY),centerXMm:toMm((b.minX+b.maxX)/2),centerYMm:toMm((b.minY+b.maxY)/2)}; }catch(error){ box=null; }
  items.push({
    primitiveId:item.primitiveId, designator:item.designator||null,
    xMm:toMm(item.x), yMm:toMm(item.y),
    rotationDeg:Number(item.rotation)||0, layer:item.layer, layerSide:item.layer===1?'top':(item.layer===2?'bottom':String(item.layer)),
    bboxMm:box, padCount:(item.pads||[]).length,
    netPads:(item.pads||[]).filter((pad)=>pad&&pad.net).length,
    // 器件挂了哪些网络：布局要有电气意识就必须知道"谁该和谁靠一起"
    nets:[...new Set((item.pads||[]).map((pad)=>pad&&pad.net).filter((net)=>typeof net==='string'&&net.length))],
  });
}
// 板框的点数据**不在** primitive 上：真机实测 item.polygon 是 IPCB_Polygon 类的实例，
// JSON 序列化后点全丢（第一版读回来是 [[ ]]，而我却"读到"了一个看似成功的空板框）。
// 必须调 polygon.getSource() —— 返回 [起点X,起点Y, "L", x1,y1, x2,y2, ...] 这样的命令数组
// （真机板框 = [0,0,"L",2362.2047,0,2362.2047,-1574.8031,0,-1574.8031,0,0]，即 60.0x40.0mm 矩形）。
// discretize() 在真机上是 'Not implemented'，所以解析必须放在运行时里做（可测试）。
const polylines=(await eda.pcb_PrimitivePolyline.getAll())||[];
const outline=polylines.filter((item)=>item.layer===${LAYER_IDS.BOARD_OUTLINE});
const outlineItems=outline.map((item)=>{
  let source=null; let sourceError=null;
  try{ source=(item.polygon&&typeof item.polygon.getSource==='function')?(item.polygon.getSource()||null):null; }catch(error){ sourceError=String(error&&error.message||error).slice(0,120); }
  return { primitiveId:item.primitiveId, lineWidthMil:item.lineWidth, source, sourceError };
});
return { unit:'mm', componentCount:items.length, components:items, outlineCount:outlineItems.length, outline:outlineItems };`,
  },
  'pcb.rules.read': { permission: 'read', description: '读取当前PCB规则配置摘要', signature: 'PCB_Drc.getCurrentRuleConfiguration/getCurrentRuleConfigurationName', code: 'const configuration=await eda.pcb_Drc.getCurrentRuleConfiguration();return {name:await eda.pcb_Drc.getCurrentRuleConfigurationName(),keys:Object.keys(configuration||{})};' },
  'pcb.source.read': { permission: 'sensitive-read', description: '读取当前PCB源码快照', signature: 'SYS_FileManager.getDocumentSource()', code: 'return await eda.sys_FileManager.getDocumentSource();' },
  'pcb.importChanges': { timeoutMs: 30000, longRunning: 'document-lifecycle', permission: 'write', description: '从同一Board关联原理图导入变更', signature: 'PCB_Document.importChanges(uuid?)', buildCode: ({ schematicUuid }) => `return await eda.pcb_Document.importChanges(${schematicUuid ? JSON.stringify(schematicUuid) : ''});` },
  'pcb.save': { timeoutMs: 30000, longRunning: 'persistence', permission: 'write', description: '保存当前PCB文档', signature: 'PCB_Document.save()', code: 'return await eda.pcb_Document.save();' },
  'pcb.component.modify': { permission: 'write-beta', description: '固定坐标修改PCB器件（官方Beta）', signature: 'PCB_PrimitiveComponent.modify(id,property)', buildCode: ({ primitiveId, property }) => `return await eda.pcb_PrimitiveComponent.modify(${JSON.stringify(primitiveId)},${JSON.stringify(property)});` },
  /**
   * 批量写回器件布局（位置/旋转）。**只改 x/y/rotation，不碰网络与封装关联**。
   *
   * 单位：`PCB_PrimitiveComponent.modify` 没有 unit 参数，用的是文档单位（本板实测为 mil，
   * 读回 U1 x=393.7008 = 10.0000mm），所以这里只接受 mil 并在运行时层面做 mm→mil 换算。
   * 万一单位假设错了，**回读校验会立刻发现**（这是我们不做"写完就算成功"的原因）。
   * 逐个回读：每个器件写完立刻 getAll 确认，避免"调用没报错=改成功了"这种自欺。
   */
  'pcb.placement.write': {
    permission: 'write-beta', timeoutMs: 45_000, longRunning: 'batch-write-with-readback',
    description: '批量修改PCB器件位置/旋转（单位 mil），逐个回读确认',
    signature: 'PCB_PrimitiveComponent.modify(id,{x,y,rotation}) + PCB_PrimitiveComponent.getAll',
    buildCode: ({ updates }) => `const list=Array.isArray(${JSON.stringify(updates ?? [])})?${JSON.stringify(updates ?? [])}:[];
const results=[];
for(const update of list){
  const property={};
  if(Number.isFinite(update.xMil)) property.x=update.xMil;
  if(Number.isFinite(update.yMil)) property.y=update.yMil;
  if(Number.isFinite(update.rotationDeg)) property.rotation=update.rotationDeg;
  let ok=false; let error=null;
  try{ const updated=await eda.pcb_PrimitiveComponent.modify(update.primitiveId,property); ok=!!updated; if(!ok) error='modify 返回空'; }catch(caught){ error=String(caught&&caught.message||caught).slice(0,160); }
  results.push({primitiveId:update.primitiveId,designator:update.designator||null,ok,error,property});
}
const confirm=[];
for(const result of results){
  try{
    const items=await eda.pcb_PrimitiveComponent.getAll();
    const found=(items||[]).find((item)=>item.primitiveId===result.primitiveId);
    confirm.push({primitiveId:result.primitiveId,designator:result.designator,found:!!found,xMil:found?found.x:null,yMil:found?found.y:null,rotationDeg:found?Number(found.rotation)||0:null});
  }catch(caught){ confirm.push({primitiveId:result.primitiveId,designator:result.designator,found:false,error:String(caught&&caught.message||caught).slice(0,120)}); }
}
return {requested:list.length,applied:results.filter((item)=>item.ok).length,results,confirm};`,
  },
  /**
   * 在 PCB 上放置库器件（官方 Beta）。
   *
   * 为什么需要它：真机实测 `pcb.importChanges` 返回 `success:true` 却一个器件都没落进 PCB
   * （第 16 轮四组对照：原理图页 uuid / 原理图文档 uuid / 不带参数 / 先打开原理图，全部 8→8）。
   * 所以"把已确认的器件落到 PCB"必须走图元 API 这条路，而不是指望 EDA 的变更导入。
   * 签名不是猜的：来自嘉立创EDA 自带的 `assets/pro-api/0.3.18.0bc12bb0/api-types.d.ts`——
   * `create(component, layer, x, y, rotation?, primitiveLock?)`，坐标与其它 PCB 图元一致，单位 mil。
   */
  'pcb.component.create': { permission: 'write-beta', timeoutMs: 20_000, description: '在PCB上放置库器件（官方Beta），并回读确认', signature: 'PCB_PrimitiveComponent.create(component,layer,x,y,rotation,primitiveLock)', buildCode: ({ component, layer, xMil, yMil, rotationDeg = 0, primitiveLock = false }) => `const created=await eda.pcb_PrimitiveComponent.create(${JSON.stringify(component)},${JSON.stringify(layer)},${JSON.stringify(xMil)},${JSON.stringify(yMil)},${JSON.stringify(rotationDeg)},${JSON.stringify(Boolean(primitiveLock))});
if(!created) return null;
try{
  const all=await eda.pcb_PrimitiveComponent.getAll();
  const found=(all||[]).find((item)=>item.primitiveId===created.primitiveId)||created;
  return {primitiveId:found.primitiveId??null,designator:found.designator??null,layer:found.layer??null,xMil:Number(found.x)||0,yMil:Number(found.y)||0,rotationDeg:Number(found.rotation)||0};
}catch(caught){
  return {primitiveId:created.primitiveId??null,designator:created.designator??null,layer:created.layer??null,xMil:Number(created.x)||0,yMil:Number(created.y)||0,rotationDeg:Number(created.rotation)||0,confirmError:String(caught&&caught.message||caught).slice(0,120)};
}` },
  'pcb.pins.read': {
    permission: 'read',
    description: '读取PCB器件的焊盘（含坐标与所属网络）——布线器必需的"焊盘↔网络↔坐标"映射',
    signature: 'PCB_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId)',
    buildCode: ({ primitiveId }) => `return await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(${JSON.stringify(primitiveId)});`,
  },
  /**
   * 板面铜几何快照：走线 / 过孔 / 焊盘 一次读全（含网络与层）。
   * 合规布线器的输入必须是"同一时刻的一致快照"，逐条命令去读会读到互相错位的状态。
   * 取数同时兼容"属性式"与"getState_* 方法式"两种 EDA 对象形态，避免不同版本读空。
   */
  'pcb.copper.read': {
    permission: 'read',
    timeoutMs: 60_000,
    description: '一次性读取板面铜几何（走线/过孔/焊盘，含网络与层）——布线分析的一致快照',
    signature: 'PCB_PrimitiveLine.getAll() + PCB_PrimitiveVia.getAll() + PCB_PrimitiveComponent.getAllPinsByPrimitiveId',
    code: `const g=(o,name)=>{ if(o==null) return undefined; try{ if(o[name]!==undefined) return o[name]; const method=o['getState_'+name.charAt(0).toUpperCase()+name.slice(1)]; return typeof method==='function'?method.call(o):undefined; }catch(caught){ return undefined; } };
const num=(value)=>{ const number=Number(value); return Number.isFinite(number)?number:0; };
const lines=((await eda.pcb_PrimitiveLine.getAll())||[]).map((item)=>({id:String(g(item,'primitiveId')||''),net:String(g(item,'net')||'').trim(),layer:num(g(item,'layer')),x1:num(g(item,'startX')),y1:num(g(item,'startY')),x2:num(g(item,'endX')),y2:num(g(item,'endY')),width:num(g(item,'lineWidth'))||10}));
const vias=((await eda.pcb_PrimitiveVia.getAll())||[]).map((item)=>({id:String(g(item,'primitiveId')||''),net:String(g(item,'net')||'').trim(),x:num(g(item,'x')),y:num(g(item,'y')),outerDiameter:num(g(item,'diameter'))||24,hole:num(g(item,'holeDiameter'))||12}));
const components=(await eda.pcb_PrimitiveComponent.getAll())||[];
const pads=[];
for(const component of components){
  const id=String(g(component,'primitiveId')||''); const designator=String(g(component,'designator')||''); let pins=[];
  try{ pins=(await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id))||[]; }catch(caught){ pins=[]; }
  for(const pin of pins){
    const shape=g(pin,'pad');
    const sizes=Array.isArray(shape)?shape.slice(1).map(Number).filter((value)=>Number.isFinite(value)):[];
    const radius=sizes.length?Math.max.apply(null,sizes)/2:5;
    const hole=g(pin,'hole');
    const holeSizes=Array.isArray(hole)?hole.slice(1).map(Number).filter((value)=>Number.isFinite(value)&&value>0):[];
    const layer=num(g(pin,'layer'));
    pads.push({designator,pad:String(g(pin,'padNumber')||''),net:String(g(pin,'net')||'').trim(),layer,x:num(g(pin,'x')),y:num(g(pin,'y')),radius,holes:hole?1:0,holeDiameter:holeSizes.length?Math.max.apply(null,holeSizes):0,throughHole:layer===12||Boolean(hole)});
  }
}
return {lines,vias,pads,counts:{lines:lines.length,vias:vias.length,pads:pads.length,components:components.length}};`,
  },
  'pcb.lines.delete': { permission: 'write-beta', timeoutMs: 20_000, description: '删除PCB线段（按图元ID）——写入未通过复核时用于回滚', signature: 'PCB_PrimitiveLine.delete(primitiveIds)', buildCode: ({ primitiveIds }) => `return await eda.pcb_PrimitiveLine.delete(${JSON.stringify(primitiveIds)});` },
  'pcb.vias.delete': { permission: 'write-beta', timeoutMs: 20_000, description: '删除PCB过孔（按图元ID）——写入未通过复核时用于回滚', signature: 'PCB_PrimitiveVia.delete(primitiveIds)', buildCode: ({ primitiveIds }) => `return await eda.pcb_PrimitiveVia.delete(${JSON.stringify(primitiveIds)});` },
  'pcb.line.create': { permission: 'write-beta', timeoutMs: 20_000, description: '创建PCB铜层线段（官方Beta）。**不能画板框**：实测 Line 只接受 SIGNAL 铜层', signature: 'PCB_PrimitiveLine.create(net,layer,x1,y1,x2,y2,width,lock)', buildCode: ({ net = '', layer, startX, startY, endX, endY, lineWidth = 0.2, primitiveLock = false }) => `return await eda.pcb_PrimitiveLine.create(${JSON.stringify(net)},${JSON.stringify(layer)},${JSON.stringify(startX)},${JSON.stringify(startY)},${JSON.stringify(endX)},${JSON.stringify(endY)},${JSON.stringify(lineWidth)},${JSON.stringify(primitiveLock)});` },
  /**
   * 板框创建：**必须**走 Polyline + 坐标开头的多边形编码。
   * 创建后立刻用 getPrimitivesBBox 与期望包围盒比对，几何不符就报错——
   * 板框错一点，后面所有"板内/板外"判断都是错的。
   */
  'pcb.outline.create': { permission: 'write-beta', timeoutMs: 30_000, longRunning: 'blocking-heavy', description: `在板框层(${LAYER_IDS.BOARD_OUTLINE})创建闭合矩形板框并回读校验。${BOARD_OUTLINE_HELP}`, signature: 'PCB_MathPolygon.createPolygon([x0,y0,"L",…]) + PCB_PrimitivePolyline.create("",11,polygon,width) + PCB_Primitive.getPrimitivesBBox', buildCode: ({ originXMm = 0, originYMm = 0, widthMm, heightMm, lineWidth = OUTLINE_LINE_WIDTH_MIL }) => {
    const source = rectPolygonSource({ originXMm, originYMm, widthMm, heightMm });
    // 线宽是 mil，期望包围盒要以 mm 计：这里曾经错写成 mmToMil(lineWidth)*0.0254/2，
    // 结果是 10mil 被当成 10mm，偏差阈值在真机上会误报。
    const halfWidthMm = milToMm(lineWidth) / 2;
    const expected = { minXMm: originXMm - halfWidthMm, minYMm: originYMm - halfWidthMm, maxXMm: originXMm + widthMm + halfWidthMm, maxYMm: originYMm + heightMm + halfWidthMm };
    // 注意最外层的 return：桥接层按“函数体”执行源码，IIFE 不写 return 的话回读校验结果会被丢弃。
    return `return (async()=>{const source=${JSON.stringify(source)};const polygon=eda.pcb_MathPolygon.createPolygon(source);if(!polygon)throw new Error('EDA_POLYGON_REJECTED');const created=await eda.pcb_PrimitivePolyline.create('',${LAYER_IDS.BOARD_OUTLINE},polygon,${JSON.stringify(lineWidth)});if(!created||!created.primitiveId)throw new Error('EDA_OUTLINE_CREATE_FAILED');const bbox=await eda.pcb_Primitive.getPrimitivesBBox([created.primitiveId]);const mm=(value)=>value*25.4/1000;const boundsMm=bbox?{minXMm:mm(bbox.minX),minYMm:mm(bbox.minY),maxXMm:mm(bbox.maxX),maxYMm:mm(bbox.maxY)}:null;const expected=${JSON.stringify(expected)};let deviation=null;if(!boundsMm){deviation='BBox_UNAVAILABLE';}else{const deltas=[boundsMm.minXMm-expected.minXMm,boundsMm.minYMm-expected.minYMm,boundsMm.maxXMm-expected.maxXMm,boundsMm.maxYMm-expected.maxYMm].map(Math.abs);const worst=Math.max(...deltas);if(worst>0.05)deviation='BBox_DEVIATION_'+worst.toFixed(4)+'mm';}const zoom=await eda.pcb_Document.zoomToBoardOutline();return {primitiveId:created.primitiveId,layer:created.layer,lineWidthMil:created.lineWidth,polygon:created.polygon,source,boundsMm,expectedBoundsMm:expected,deviation,zoomToBoardOutline:zoom};})()`;
  } },
  'pcb.outline.read': { permission: 'read', description: '读取板框层的全部轮廓与合并包围盒（板框是否存在、是否闭合的判据）', signature: 'PCB_PrimitivePolyline.getAll() + PCB_Primitive.getPrimitivesBBox + PCB_Document.zoomToBoardOutline', code: `const all=(await eda.pcb_PrimitivePolyline.getAll())||[];const outline=all.filter((item)=>item.layer===${LAYER_IDS.BOARD_OUTLINE});const bbox=outline.length?await eda.pcb_Primitive.getPrimitivesBBox(outline.map((item)=>item.primitiveId)):null;const mm=(value)=>value*25.4/1000;return {count:outline.length,items:outline.map((item)=>({primitiveId:item.primitiveId,lineWidthMil:item.lineWidth,polygon:item.polygon})),boundsMm:bbox?{minXMm:mm(bbox.minX),minYMm:mm(bbox.minY),maxXMm:mm(bbox.maxX),maxYMm:mm(bbox.maxY)}:null,zoomToBoardOutline:await eda.pcb_Document.zoomToBoardOutline()};` },
  'pcb.polylines.read': { permission: 'read', description: '读取PCB全部折线图元（含板框层）', signature: 'PCB_PrimitivePolyline.getAll()', code: 'return (await eda.pcb_PrimitivePolyline.getAll())||[];' },
  'pcb.via.create': { permission: 'write-beta', description: '创建PCB过孔（官方Beta；盲埋孔跨度由设计规则项名指定，null 表示非盲埋孔）', signature: 'PCB_PrimitiveVia.create(net,x,y,hole,diameter,viaType?,designRuleBlindViaName?)', buildCode: ({ net, x, y, holeDiameter, diameter, viaType, designRuleBlindViaName }) => {
    const positional = [JSON.stringify(net), JSON.stringify(x), JSON.stringify(y), JSON.stringify(holeDiameter), JSON.stringify(diameter)];
    // 官方签名为位置参数：designRuleBlindViaName 是第 7 个，必须先填 viaType 才能填它。
    // viaType 的取值编码（官方类型是 0/1/2 枚举，但运行时 JS 已混淆、无法核实）
    // 因此这里保持原样透传，不擅自改动语义。
    if (viaType !== undefined || designRuleBlindViaName !== undefined) positional.push(JSON.stringify(viaType));
    if (designRuleBlindViaName !== undefined) positional.push(JSON.stringify(designRuleBlindViaName));
    return `return await eda.pcb_PrimitiveVia.create(${positional.join(',')});`;
  } },
  /**
   * A11 真机修正（第 23 轮）：官方 create 的 complexPolygon 既不是裸 `{polygon:[...]}` 数组，
   * 也不是任意对象；真机实测有效构造是 `PCB_MathPolygon.createComplexPolygon(flat)`，
   * 其中 flat = [x0,y0,'L', x1,y1, x2,y2, ..., x0,y0]（首点 + 'L' + 其余顶点 + 回环点，原生单位=mil）。
   * 生产计划给的是 `outline: [[x,y],...]`，这里在 EDA 侧换算成 flat 再建 complexPolygon；
   * 调用方也可以直接传实测可用的 complexPolygon 对象。
   */
  'pcb.pour.create': { timeoutMs: 45000, longRunning: 'blocking-heavy', permission: 'write-beta', description: '创建PCB覆铜（官方Beta）', signature: 'PCB_MathPolygon.createComplexPolygon(flat) + PCB_PrimitivePour.create(net,layer,cp,...)', buildCode: ({ net, layer, complexPolygon = null, outline = null, preserveSilos = false, pourName = 'GND', pourPriority = 0, lineWidth = 0.2, primitiveLock = false }) => {
    const tail = `return await eda.pcb_PrimitivePour.create(${JSON.stringify(net)},${JSON.stringify(layer)},cp,undefined,${JSON.stringify(preserveSilos)},${JSON.stringify(pourName)},${JSON.stringify(pourPriority)},${JSON.stringify(lineWidth)},${JSON.stringify(primitiveLock)});`;
    if (complexPolygon) return `const cp=${JSON.stringify(complexPolygon)};` + tail;
    return `const outline=${JSON.stringify(outline)};const flat=[];for(let i=0;i<outline.length;i+=1){flat.push(outline[i][0],outline[i][1]);if(i===0)flat.push('L');}flat.push(outline[0][0],outline[0][1]);const cp=await eda.pcb_MathPolygon.createComplexPolygon(flat);` + tail;
  } },
  // 布线后必做：铜皮不会自动避让新走线，必须重建填充。否则产生成百条
  // "Copper Region(Filled) to Track/Via/Hole" 间距错误（真机实测 760 项里有约 161 项属此类）。
  // A11 回滚：删除本次新建的覆铜（官方 delete(id)）。仍按 write 权限登记，调用方必须带写批准语义。
  'pcb.pour.delete': { timeoutMs: 20000, permission: 'write-beta', description: '删除指定PCB覆铜（回滚新建用）', signature: 'PCB_PrimitivePour.delete(id)', buildCode: ({ primitiveId }) => `const ok=await eda.pcb_PrimitivePour.delete(${JSON.stringify(primitiveId)});return {deleted:ok!==false,primitiveId:${JSON.stringify(primitiveId)}};` },
  'pcb.pour.deleteAdded': { timeoutMs: 30000, longRunning: 'write-with-readback', permission: 'write-beta', description: '半写回滚：按运行前快照删除本次新增的覆铜（差集，不碰既有覆铜）', buildCode: ({ existingIds = [] }) => `const before=new Set(${JSON.stringify((Array.isArray(existingIds)?existingIds:[]).map(String))});const pours=(await eda.pcb_PrimitivePour.getAll())||[];const added=[];for(const pour of pours){const id=String(pour.getState_PrimitiveId?.()||'');if(id&&!before.has(id))added.push(id);}const deleted=[];const failed=[];for(const id of added){try{const ok=await eda.pcb_PrimitivePour.delete(id);if(ok===false)failed.push({id,reason:'delete returned false'});else deleted.push(id);}catch(caught){failed.push({id,reason:String(caught&&caught.message||caught).slice(0,120)});}}return {added,deleted,failed,beforeCount:before.size,afterCount:((await eda.pcb_PrimitivePour.getAll())||[]).length};` },
  'pcb.pour.rebuild': { timeoutMs: 60000, longRunning: 'blocking-heavy', permission: 'write-beta', description: '重建已有PCB覆铜填充（布线后必做）', signature: 'PCB_PrimitivePour.rebuildCopperRegion()', buildCode: ({ primitiveIds = null } = {}) => `const only=${Array.isArray(primitiveIds) && primitiveIds.length ? JSON.stringify(primitiveIds) : 'null'};const pours=(await eda.pcb_PrimitivePour.getAll())||[];const items=[];for(const pour of pours){const id=String(pour.getState_PrimitiveId?.()||"");if(only&&only.indexOf(id)<0)continue;const poured=await pour.rebuildCopperRegion();items.push({primitiveId:id,ok:Boolean(poured)});}return {rebuilt:items.length,items};` },
  // 嘉立创EDA 原生自动布线是渲染进程里的长任务（真机实测 >120s），同步请求必被桥服务端 120s 掐断。
  // 所以这里**不 await**：受理即返回，随后用 pcb.lines.read / DRC 轮询判定是否完成。
  // 注意：产品能力表把 autorouting 标为 user-assisted / production:false（官方禁止生产使用 Beta API），
  // 只允许用于 EVT 候选，且必须强制 DRC 回读（T24/T25）。
  'pcb.autoRoute.start': { timeoutMs: 20000, permission: 'write-beta', description: '启动嘉立创EDA Beta自动布线（异步受理，不等待完成）', signature: 'PCB_Document.autoRouting(props?)', buildCode: ({ nets, ignoreNets, layers } = {}) => {
    const props = {};
    if (Array.isArray(nets) && nets.length) props.RoutingNets = nets;
    if (Array.isArray(ignoreNets)) props.ignoreNets = ignoreNets;
    if (Array.isArray(layers)) props.layers = layers;
    const call = Object.keys(props).length ? `eda.pcb_Document.autoRouting(${JSON.stringify(props)})` : 'eda.pcb_Document.autoRouting()';
    return `const task=${call};if(task&&typeof task.then==="function"){task.then(()=>{}).catch(()=>{});}return {started:true,async:true};`;
  } },
  'pcb.routing.capabilities': { permission: 'read', description: '只读核验当前 EDA 自动布线 API 是否存在', signature: 'PCB_Document.autoRouting', code: 'return {nativeAutoRouting:typeof eda.pcb_Document.autoRouting==="function"};' },
  // 阻塞式 DRC 只适合小板。真实规模（几十个过孔 + 铺铜填充）会跑几分钟，
  // 单次 HTTP 请求装不下，必须用 pcb.drc.job.start + pcb.job.poll。
  'pcb.drc': { permission: 'validate', timeoutMs: MAX_TRANSPORT_TIMEOUT_MS, longRunning: 'blocking-no-job-variant', description: '阻塞式运行官方PCB DRC（仅适合小板；大板请用 pcb.drc.job.start）', signature: 'PCB_Drc.check(true,false,true)', code: 'return await eda.pcb_Drc.check(true,false,true);' },
  'pcb.drc.ui': { permission: 'validate', timeoutMs: MAX_TRANSPORT_TIMEOUT_MS, longRunning: 'blocking-no-job-variant', description: '在嘉立创EDA界面显示PCB DRC（阻塞式，大板请用 pcb.drc.job.start 的 userInterface 变体）', signature: 'PCB_Drc.check(true,true,true)', code: 'return await eda.pcb_Drc.check(true,true,true);' },
  /**
   * DRC 后台任务：立刻返回 jobId，DRC 在 EDA 渲染进程里继续跑，客户端轮询取结果。
   * 这样 DRC 不再受 8s/120s 传输预算约束，也**不会**把超时误判成"0 项问题"。
   */
  'pcb.drc.job.start': { permission: 'validate', timeoutMs: 10_000, description: '在EDA渲染进程后台启动官方PCB DRC任务，立刻返回jobId（推荐用法）', signature: `startJobCode({expression:'PCB_Drc.check(true,false,true)'})`, buildCode: ({ jobId, userInterface = false }) => startJobCode({ jobId, label: userInterface ? '官方PCB DRC（界面显示）' : '官方PCB DRC', expression: `eda.pcb_Drc.check(true,${userInterface ? 'true' : 'false'},true)` }) },
  'pcb.job.poll': { permission: 'read', timeoutMs: 10_000, description: '查询EDA后台任务状态与结果（state: running/done/error/cancelled/unknown）', signature: 'globalThis.__circuitpilotEdaJobs', buildCode: ({ jobId }) => pollJobCode({ jobId }) },
  'pcb.job.list': { permission: 'read', timeoutMs: 10_000, description: '列出EDA后台任务（含已结束）', signature: 'globalThis.__circuitpilotEdaJobs', code: listJobsCode() },
  /**
   * 渲染进程会话/健康探针（最便宜的一道前置门）。
   * 3s 都答不上来 ⇒ 渲染进程不正常，此时**不要**再发 110s 长调用：
   * "118.0s 零方差"那类神秘超时就是这么来的。顺带给出 epoch，用于识别渲染进程是否换了会话。
   */
  'eda.session': { timeoutMs: 3_000, permission: 'read', description: '读取EDA渲染进程会话标识（epoch）与健康状态', signature: 'globalThis.__circuitpilotEdaEpoch', code: sessionCode() },
  /**
   * 只读探针：上报当前嘉立创EDA里到底有哪些图元 API、方法名和 create 的参数个数。
   *
   * 为什么要有这条：`pcb.importChanges` 真机实测返回 `success:true` 却什么都没同步（第 16 轮四组对照），
   * 所以"把原理图器件落进 PCB"必须换路径。换路径前先问清楚 **这台机器上真的存在哪些 API**，
   * 而不是照文档猜一个方法名然后靠 500 报错去试。只读、不改任何东西。
   */
  'eda.api.describe': { timeoutMs: 5_000, permission: 'read', description: '只读探针：列出图元API与方法名（用于确认真实可用的能力边界）', code: [
    'const names = ["pcb_PrimitiveComponent","sch_PrimitiveComponent","pcb_Document","sch_Document","pcb_PrimitiveVia","pcb_PrimitiveLine"];',
    'const out = {};',
    'const edaObject = (typeof eda === "undefined") ? null : eda;',
    'for (const name of names) {',
    '  const api = edaObject ? edaObject[name] : null;',
    '  if (!api) { out[name] = null; continue; }',
    '  const own = Object.keys(api);',
    '  let proto = [];',
    '  try { proto = Object.getOwnPropertyNames(Object.getPrototypeOf(api) || {}); } catch (error) { proto = []; }',
    '  const methods = [...new Set([...own, ...proto])].filter((key) => key !== "constructor" && typeof api[key] === "function");',
    '  out[name] = { methods: methods.sort(), createArity: typeof api.create === "function" ? api.create.length : null };',
    '}',
    'return out;',
  ].join('\n') },
  'pcb.job.cancel': { permission: 'read', timeoutMs: 10_000, description: '标记取消EDA后台任务（尽力而为：EDA侧调用本身不可中断）', signature: 'globalThis.__circuitpilotEdaJobs', buildCode: ({ jobId }) => cancelJobCode({ jobId }) },
  /**
   * 导出**贴装后整机 3D**（板 + 器件模型 + 过孔/丝印/走线），并把它缓存进渲染进程，
   * 供 `pcb.3d.chunk` 分片取回。
   *
   * 两个必须显式传的东西（不传就是"光板"或丢器件）：
   *  - element 必须含 "Component Model"，否则 STEP 里没有器件；
   *  - modelMode 必须为 "Outfit"（整机装配），"Parts" 是分件。
   * 本机实测：显式传参导出 10,921,411 字节，比零参导出更大更全。
   *
   * 为什么不在这里落盘：EDA 的 sys_FileSystem 在本机环境不可用
   * （getDocumentsPath() 返回空串、saveFileToFileSystem 返回 false），
   * 所以落盘交给运行时进程：分片取回后写盘并校验 sha256。
   */
  'pcb.3d.export': {
    timeoutMs: 110_000, longRunning: 'export', permission: 'validate',
    description: '导出贴装后整机3D(STEP)并缓存待分片取回',
    signature: 'PCB_ManufactureData.get3DFile(name,"step",["Component Model",...],"Outfit",true)',
    buildCode: ({ fileName = 'CircuitPilot-Assembled-3D', format = 'step' } = {}) => `return await (async () => {
  const elements = ['Component Model','Via','Silkscreen','Wire In Signal Layer'];
  const file = await eda.pcb_ManufactureData.get3DFile(${JSON.stringify(fileName)}, ${JSON.stringify(format)}, elements, 'Outfit', true);
  if (!file) return null;
  const cache = globalThis.__circuitpilotExportCache || (globalThis.__circuitpilotExportCache = { entries: {}, order: [] });
  const now = Date.now();
  const exportId = 'exp-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const chunkSize = 262144;
  cache.entries[exportId] = { file, createdAt: now, name: file.name, size: file.size };
  cache.order.push(exportId);
  while (cache.order.length > 2) { const oldest = cache.order.shift(); delete cache.entries[oldest]; }
  for (const key of Object.keys(cache.entries)) { if (now - cache.entries[key].createdAt > 600000) delete cache.entries[key]; }
  return { exportId, name: file.name, size: file.size, chunkSize, chunks: Math.ceil(file.size / chunkSize), elements, modelMode: 'Outfit', autoGenerateModels: true, cachedAt: now };
})();`,
  },
  /**
   * 分片取回导出缓冲（base64）。分片存在渲染进程缓存里，渲染进程一重载即失效，
   * 此时返回 `EDA_EXPORT_BUFFER_LOST`——**明确失败，绝不返回半截文件冒充成功**。
   */
  'pcb.3d.chunk': {
    timeoutMs: 30_000, longRunning: 'export-transfer', permission: 'read',
    description: '分片读取已导出的3D文件（base64），由运行时落盘',
    signature: 'File.slice(start,end).arrayBuffer()',
    buildCode: buildExportChunkCode,
  },
  /** 与 `pcb.3d.chunk` 同一实现：分片读取器与文件种类无关，BOM/CPL/Gerber 走这条。 */
  'pcb.export.chunk': {
    timeoutMs: 30_000, longRunning: 'export-transfer', permission: 'read',
    description: '分片读取已导出的制造文件（Gerber/BOM/CPL，base64），由运行时落盘',
    signature: 'File.slice(start,end).arrayBuffer()',
    buildCode: buildExportChunkCode,
  },
  /**
   * 通用制造文件导出（Gerber / BOM / CPL）。
   * 为什么要能取**字节**而不是只看元数据：板厂要的是文件本身，`*.inspect` 系列只回 name/size/type，
   * 拿它当交付物就是自欺欺人。这里走与 3D 同一条"导出缓存 + 分片取回"通道，
   * 落盘、字节数与哈希校验由 runtime/artifacts.mjs 统一负责。
   */
  'pcb.manufacture.export': {
    timeoutMs: 110_000, longRunning: 'export', permission: 'export-beta',
    description: '导出 Gerber/BOM/CPL 并缓存待分片取回',
    signature: 'PCB_ManufactureData.getGerberFile() / getBomFile(name,"csv") / getPickAndPlaceFile(name,"csv")',
    buildCode: ({ kind = 'gerber', fileName = 'CircuitPilot-Export' } = {}) => `return await (async () => {
  const kind = ${JSON.stringify(kind)};
  const name = ${JSON.stringify(fileName)};
  let file = null;
  if (kind === 'gerber') file = await eda.pcb_ManufactureData.getGerberFile(name);
  else if (kind === 'bom') file = await eda.pcb_ManufactureData.getBomFile(name, 'csv');
  else if (kind === 'cpl') file = await eda.pcb_ManufactureData.getPickAndPlaceFile(name, 'csv');
  else return { error: 'EDA_EXPORT_KIND_UNSUPPORTED', kind };
  if (!file) return null;
  const cache = globalThis.__circuitpilotExportCache || (globalThis.__circuitpilotExportCache = { entries: {}, order: [] });
  const now = Date.now();
  const exportId = 'exp-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const chunkSize = 262144;
  cache.entries[exportId] = { file, createdAt: now, name: file.name, size: file.size, kind };
  cache.order.push(exportId);
  while (cache.order.length > 4) { const oldest = cache.order.shift(); delete cache.entries[oldest]; }
  for (const key of Object.keys(cache.entries)) { if (now - cache.entries[key].createdAt > 600000) delete cache.entries[key]; }
  return { exportId, kind, name: file.name, size: file.size, chunkSize, chunks: Math.ceil(file.size / chunkSize), cachedAt: now };
})();`,
  },
  'pcb.3d': { timeoutMs: 110000, longRunning: 'export', permission: 'validate', description: '请求官方PCB 3D文件用于可用性检查', signature: 'PCB_ManufactureData.get3DFile()', code: 'const f=await eda.pcb_ManufactureData.get3DFile();return f?{name:f.name,size:f.size,type:f.type}:null;' },
  'pcb.bom.inspect': { timeoutMs: 60000, longRunning: 'export', permission: 'export-beta', description: '生成BOM并仅返回元数据（官方Beta）', signature: 'PCB_ManufactureData.getBomFile()', code: 'const f=await eda.pcb_ManufactureData.getBomFile("CircuitPilot-BOM","csv");return f?{name:f.name,size:f.size,type:f.type}:null;' },
  'pcb.cpl.inspect': { timeoutMs: 60000, longRunning: 'export', permission: 'export-beta', description: '生成CPL并仅返回元数据（官方Beta）', signature: 'PCB_ManufactureData.getPickAndPlaceFile()', code: 'const f=await eda.pcb_ManufactureData.getPickAndPlaceFile("CircuitPilot-CPL","csv");return f?{name:f.name,size:f.size,type:f.type}:null;' },
  'pcb.gerber.inspect': { timeoutMs: 60000, longRunning: 'export', permission: 'export-beta', description: '生成Gerber并仅返回元数据（官方Beta）', signature: 'PCB_ManufactureData.getGerberFile()', code: 'const f=await eda.pcb_ManufactureData.getGerberFile("CircuitPilot-Gerber");return f?{name:f.name,size:f.size,type:f.type}:null;' },
});

function finiteCoordinate(value) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000; }

// 这些字段会被 buildCode 拼进提交给嘉立创EDA扩展执行的 JavaScript 源码。
// 只要有一个字段没做类型校验，客户端就能用字符串截断语句达成任意代码执行。
function requireFiniteNumber(value, field) {
  if (!finiteCoordinate(value)) throw Object.assign(new Error(`${field}必须是有限数字`), { code: 'EDA_COMMAND_ARGS_INVALID' });
  return value;
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw Object.assign(new Error(`${field}必须是布尔值`), { code: 'EDA_COMMAND_ARGS_INVALID' });
  return value;
}

function validateArgs(commandId, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Object.assign(new Error('命令参数必须是对象'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  if (commandId === 'document.source.restore' && (typeof args.source !== 'string' || !args.source.length)) throw Object.assign(new Error('恢复源码不能为空'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  if (commandId === 'workspace.create') {
    if (typeof args.friendlyName !== 'string' || !args.friendlyName.trim() || args.friendlyName.length > 120) throw Object.assign(new Error('工程名称长度必须为1至120个字符'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (typeof args.projectName !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(args.projectName)) throw Object.assign(new Error('工程内部名称只允许字母、数字和中划线'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (typeof args.description !== 'string' || args.description.length > 500) throw Object.assign(new Error('工程描述过长'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'schematic.open') {
    for (const key of ['documentUuid', 'pageUuid']) {
      const value = args[key];
      if (value !== undefined && value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value))) throw Object.assign(new Error(`${key} 非法`), { code: 'EDA_COMMAND_ARGS_INVALID' });
    }
    if (!args.documentUuid && !args.pageUuid) throw Object.assign(new Error('必须给出 documentUuid 或 pageUuid'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'pcb.placement.write') {
    const updates = args.updates;
    if (!Array.isArray(updates) || updates.length === 0) throw Object.assign(new Error('updates 必须是非空数组'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (updates.length > 200) throw Object.assign(new Error('一次写回最多 200 个器件（大批量请分批，避免渲染进程长时间无响应）'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    updates.forEach((update, index) => {
      const label = `第 ${index + 1} 个器件`;
      if (!update || typeof update !== 'object') throw Object.assign(new Error(`${label} 必须是对象`), { code: 'EDA_COMMAND_ARGS_INVALID' });
      if (typeof update.primitiveId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(update.primitiveId)) throw Object.assign(new Error(`${label} 的 primitiveId 非法（只允许字母数字下划线中划线，长度1-64）`), { code: 'EDA_COMMAND_ARGS_INVALID' });
      if (update.designator !== undefined && update.designator !== null && !/^[A-Za-z0-9_.?-]{1,32}$/.test(String(update.designator))) throw Object.assign(new Error(`${label} 的 designator 非法`), { code: 'EDA_COMMAND_ARGS_INVALID' });
      for (const key of ['xMil', 'yMil', 'rotationDeg']) {
        if (update[key] !== undefined && update[key] !== null && !Number.isFinite(update[key])) throw Object.assign(new Error(`${label} 的 ${key} 必须是有限数值`), { code: 'EDA_COMMAND_ARGS_INVALID' });
      }
      if (!Number.isFinite(update.xMil) && !Number.isFinite(update.yMil)) throw Object.assign(new Error(`${label} 至少要给出 xMil 或 yMil`), { code: 'EDA_COMMAND_ARGS_INVALID' });
    });
  }
  if (commandId === 'library.device.search') {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 120) throw Object.assign(new Error('器件搜索词长度必须为1至120个字符'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (!['keyword','lcsc'].includes(args.mode)) throw Object.assign(new Error('器件搜索模式无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20 || !Number.isInteger(args.page) || args.page < 1 || args.page > 100) throw Object.assign(new Error('器件搜索分页参数无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'schematic.component.create') {
    if (!args.component || typeof args.component.libraryUuid !== 'string' || typeof args.component.uuid !== 'string' || !finiteCoordinate(args.x) || !finiteCoordinate(args.y)) throw Object.assign(new Error('元件库身份或坐标无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (args.subPartName !== undefined && typeof args.subPartName !== 'string') throw Object.assign(new Error('元件子部件名无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    requireFiniteNumber(args.rotation ?? 0, 'rotation');
    requireBoolean(args.mirror ?? false, 'mirror');
    requireBoolean(args.addIntoBom ?? true, 'addIntoBom');
    requireBoolean(args.addIntoPcb ?? true, 'addIntoPcb');
  }
  if (commandId === 'schematic.component.designator.set') {
    if (typeof args.primitiveId !== 'string' || !args.primitiveId || args.primitiveId.length > 64) throw Object.assign(new Error('位号标注需要合法的 primitiveId'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (typeof args.designator !== 'string' || !/^[A-Za-z]{1,5}[0-9]+[A-Za-z]?$/.test(args.designator)) throw Object.assign(new Error('目标位号不合法（只接受字母前缀+数字，如 C12；拒绝 C? 占位）'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'schematic.pin.noConnect') {
    if (typeof args.componentPrimitiveId !== 'string' || !args.componentPrimitiveId.length || !Array.isArray(args.pinNumbers) || !args.pinNumbers.length || !args.pinNumbers.every((number) => typeof number === 'string' && number.length <= 20)) throw Object.assign(new Error('未连接引脚参数无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'schematic.netFlag.create') {
    if (!['Power', 'Ground', 'AnalogGround', 'ProtectGround'].includes(args.identification) || typeof args.net !== 'string' || !args.net.length || !finiteCoordinate(args.x) || !finiteCoordinate(args.y)) throw Object.assign(new Error('网络标识参数无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    requireFiniteNumber(args.rotation ?? 0, 'rotation');
    requireBoolean(args.mirror ?? false, 'mirror');
  }
  if (commandId === 'schematic.netPort.create') {
    if (!['IN', 'OUT', 'BI'].includes(args.portType) || typeof args.net !== 'string' || !args.net.length || !finiteCoordinate(args.x) || !finiteCoordinate(args.y)) throw Object.assign(new Error('网络端口参数无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    requireFiniteNumber(args.rotation ?? 0, 'rotation');
    requireBoolean(args.mirror ?? false, 'mirror');
  }
  if (commandId === 'schematic.component.delete') {
    const ids = Array.isArray(args.primitiveIds) ? args.primitiveIds : [];
    if (!ids.length || ids.length > 200 || ids.some((id) => typeof id !== 'string' || !id.length)) throw Object.assign(new Error('待删除图元 ID 列表无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'schematic.wire.create') {
    const flat = Array.isArray(args.line) ? args.line.flat(Infinity) : [];
    if (flat.length < 4 || flat.length % 2 || !flat.every(finiteCoordinate) || (args.net !== undefined && typeof args.net !== 'string')) throw Object.assign(new Error('导线坐标或网络名无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'schematic.wire.read') {
    if (!Array.isArray(args.primitiveIds) || !args.primitiveIds.length || !args.primitiveIds.every((id) => typeof id === 'string' && id.length)) throw Object.assign(new Error('导线回读图元 ID 无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'pcb.component.create') {
    const component = args.component;
    const looksLikeDevice = component && typeof component === 'object' && typeof component.uuid === 'string' && component.uuid.length
      && (typeof component.libraryUuid === 'string' || typeof component.libraryType === 'string' || typeof component.libraryUuid === 'undefined');
    if (!looksLikeDevice) throw Object.assign(new Error('缺少库器件（component 必须带 uuid）'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (args.layer !== 1 && args.layer !== 2) throw Object.assign(new Error('layer 必须是 1（顶层）或 2（底层）'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (!Number.isFinite(args.xMil) || !Number.isFinite(args.yMil)) throw Object.assign(new Error('xMil/yMil 必须是有限数（单位 mil）'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (args.rotationDeg !== undefined && !Number.isFinite(args.rotationDeg)) throw Object.assign(new Error('rotationDeg 必须是有限数'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'pcb.importChanges' && args.schematicUuid !== undefined && (typeof args.schematicUuid !== 'string' || !args.schematicUuid.length)) throw Object.assign(new Error('原理图UUID无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  if (commandId === 'pcb.open' && (typeof args.documentUuid !== 'string' || !/^[a-f0-9]{16,64}$/i.test(args.documentUuid))) throw Object.assign(new Error('EDA文档UUID无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  // 原理图两种 id 都能用：真机上传文档 uuid 会返回空，传页面 uuid 才能打开（见 schematic.open 注释）。
  if (commandId === 'schematic.open' && !['documentUuid', 'pageUuid'].some((key) => typeof args[key] === 'string' && /^[a-f0-9]{16,64}$/i.test(args[key]))) throw Object.assign(new Error('原理图必须给出合法的 documentUuid 或 pageUuid'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  if (commandId === 'pcb.component.modify') {
    if (typeof args.primitiveId !== 'string' || !args.primitiveId.length || !args.property || typeof args.property !== 'object') throw Object.assign(new Error('PCB器件修改参数无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    for (const key of ['x','y','rotation']) if (args.property[key] !== undefined && !finiteCoordinate(args.property[key])) throw Object.assign(new Error(`PCB器件${key}无效`), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'pcb.line.create') {
    if (typeof args.layer !== 'string' && typeof args.layer !== 'number') throw Object.assign(new Error('PCB线段层无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    // 实测：Line 只接受 SIGNAL 铜层。在客户端就拒绝，避免把"必然失败且报错误导"的调用发出去。
    assertPrimitiveLayerSupports('line', args.layer);
    if (![args.startX,args.startY,args.endX,args.endY,args.lineWidth ?? 0.2].every(finiteCoordinate) || (args.lineWidth ?? 0.2) <= 0) throw Object.assign(new Error('PCB线段几何无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    requireBoolean(args.primitiveLock ?? false, 'primitiveLock');
  }
  if (commandId === 'pcb.via.create') {
    if (typeof args.net !== 'string' || ![args.x,args.y,args.holeDiameter,args.diameter].every(finiteCoordinate) || args.holeDiameter <= 0 || args.diameter <= args.holeDiameter) throw Object.assign(new Error('PCB过孔参数无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (args.viaType !== undefined && typeof args.viaType !== 'string' && typeof args.viaType !== 'number') throw Object.assign(new Error('PCB过孔类型无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (args.designRuleBlindViaName !== undefined) {
      if (typeof args.designRuleBlindViaName !== 'string' || !args.designRuleBlindViaName.trim() || args.designRuleBlindViaName.length > 120) throw Object.assign(new Error('盲埋孔设计规则项名称无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
      // 规则项名“定义过孔的开始层与结束层”，但它在签名里排在 viaType 之后：
      // 不给 viaType 就无从判断这到底是不是盲埋孔，宁可拒绝也不猜。
      if (args.viaType === undefined) throw Object.assign(new Error('指定盲埋孔规则项时必须同时给出 viaType'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    }
  }
  if (commandId === 'pcb.outline.create') {
    if (![args.widthMm, args.heightMm].every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)) throw Object.assign(new Error('板框宽高必须是大于零的有限数字（单位mm）'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    requireFiniteNumber(args.originXMm ?? 0, 'originXMm');
    requireFiniteNumber(args.originYMm ?? 0, 'originYMm');
    const outlineWidth = args.lineWidth ?? OUTLINE_LINE_WIDTH_MIL;
    if (!finiteCoordinate(outlineWidth) || outlineWidth <= 0) throw Object.assign(new Error('板框线宽无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'schematic.simulation.netlist.export') {
    if (args.netlistType !== undefined && args.netlistType !== 'Ngspice') throw Object.assign(new Error('仿真网表类型当前只有 Ngspice'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (args.fileName !== undefined && (typeof args.fileName !== 'string' || !args.fileName.trim() || args.fileName.length > 120)) throw Object.assign(new Error('仿真网表文件名必须是1..120字符'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'schematic.netlist.chunk') {
    if (typeof args.exportId !== 'string' || !args.exportId.length || args.exportId.length > 200 || !Number.isInteger(args.index) || args.index < 0 || args.index > 1000) throw Object.assign(new Error('网表分片参数无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'schematic.netlist.export') {
    const types = ['Allegro', 'PADS', 'JLCEDA', 'EasyEDA', 'Protel2', 'DISA', 'DSNET'];
    if (args.netlistType !== undefined && !types.includes(args.netlistType)) throw Object.assign(new Error(`网表类型必须是 ${types.join('/')} 之一`), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (args.fileName !== undefined && (typeof args.fileName !== 'string' || !args.fileName.trim() || args.fileName.length > 120)) throw Object.assign(new Error('网表文件名必须是1..120字符'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (args.inlineLimit !== undefined && (!Number.isInteger(args.inlineLimit) || args.inlineLimit < 4096 || args.inlineLimit > 1_000_000)) throw Object.assign(new Error('内联上限必须是 4096..1000000 的整数'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'pcb.3d.export' && args.fileName !== undefined && (typeof args.fileName !== 'string' || args.fileName.length < 1 || args.fileName.length > 120)) throw Object.assign(new Error('3D导出文件名必须是1..120字符的字符串'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  if (commandId === 'pcb.manufacture.export') {
    if (!['gerber', 'bom', 'cpl'].includes(args.kind)) throw Object.assign(new Error('制造文件种类必须是 gerber/bom/cpl 之一'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (args.fileName !== undefined && (typeof args.fileName !== 'string' || !args.fileName.trim() || args.fileName.length > 120)) throw Object.assign(new Error('导出文件名必须是1..120字符'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'pcb.3d.export' && args.format !== undefined && !['step', 'glb'].includes(args.format)) {
    // 白名单：先把已验证过的 step 保住，glb 只作为"探测"放行；EDA 不支持时会返回 null，由运行时判失败，不伪造成功。
    throw Object.assign(new Error('3D 导出格式只能是 step 或 glb'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'pcb.3d.chunk' || commandId === 'pcb.export.chunk') {
    if (typeof args.exportId !== 'string' || !/^exp-[a-z0-9-]{6,40}$/.test(args.exportId)) throw Object.assign(new Error('导出缓冲ID非法'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (!Number.isInteger(args.index) || args.index < 0 || args.index > 8191) throw Object.assign(new Error('分片序号必须是 0..8191 的整数'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (['pcb.job.poll', 'pcb.job.cancel', 'pcb.drc.job.start'].includes(commandId) && !isJobId(args.jobId)) throw Object.assign(new Error('EDA后台任务ID必须是UUID'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  if (commandId === 'pcb.drc.job.start' && args.userInterface !== undefined) requireBoolean(args.userInterface, 'userInterface');
  if (commandId === 'pcb.layers.setCount') {
    if (!isEdaCopperLayerCount(args.layers)) throw Object.assign(new Error('铜箔层数必须是 2,4,6,…,32 中的偶数'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'pcb.pour.delete') {
    if (typeof args.primitiveId !== 'string' || !/^[0-9a-zA-Z_-]{1,64}$/.test(args.primitiveId)) throw Object.assign(new Error('覆铜图元ID无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'pcb.pour.create') {
    if (typeof args.net !== 'string' || !args.net.length || (typeof args.layer !== 'string' && typeof args.layer !== 'number')) throw Object.assign(new Error('PCB覆铜参数无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    const outlineOk = Array.isArray(args.outline) && args.outline.length >= 3 && args.outline.every((point) => Array.isArray(point) && point.length === 2 && point.every((value) => typeof value === 'number' && Number.isFinite(value)));
    const complexOk = args.complexPolygon && typeof args.complexPolygon === 'object';
    if (!outlineOk && !complexOk) throw Object.assign(new Error('PCB覆铜需要 outline（至少 3 个 [x,y] 点）或 complexPolygon'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    if (typeof args.pourName !== 'string' || !args.pourName.length || args.pourName.length > 80) throw Object.assign(new Error('覆铜名称无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    requireBoolean(args.preserveSilos ?? false, 'preserveSilos');
    requireFiniteNumber(args.pourPriority ?? 0, 'pourPriority');
    requireFiniteNumber(args.lineWidth ?? 0.2, 'lineWidth');
    requireBoolean(args.primitiveLock ?? false, 'primitiveLock');
  }
  return args;
}

async function fetchJson(url, options = {}, timeoutMs = 900) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      let detail = '';
      let dispatched = false;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || parsed?.message || '';
        dispatched = parsed?.dispatched === true;
      } catch { detail = text; }
      if (dispatched) {
        // 关键区分：超时 ≠ 失败。服务端已把它派发进 EDA，调用**还在跑**，只是这条 HTTP 等不到了。
        // 用独立错误码表达，避免上层把“等不到”读成“DRC 出错了”或更糟的“DRC 没问题”。
        throw Object.assign(new Error(`EDA调用已被派发但未在上限内返回（${timeoutMs}ms），渲染进程里可能仍在执行`), { code: 'EDA_REQUEST_ABANDONED', status: response.status, dispatched: true, timeoutMs });
      }
      const safeDetail = String(detail).replace(/[\r\n\t]+/g, ' ').slice(0, 400);
      throw Object.assign(new Error(`Bridge HTTP ${response.status}${safeDetail ? ` · ${safeDetail}` : ''}`), { code: 'BRIDGE_HTTP_ERROR', status: response.status });
    }
    try { return JSON.parse(text); }
    catch { throw Object.assign(new Error('Bridge返回了非JSON响应'), { code: 'BRIDGE_INVALID_RESPONSE' }); }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 任务清单归一化：兼容 `{epoch,jobs}`（第 2 版）与裸数组（旧版）两种回包。
 */
function normalizeJobList(payload) {
  const value = payload?.result ?? payload?.data ?? payload;
  if (Array.isArray(value)) return { epoch: null, jobs: value };
  if (value && Array.isArray(value.jobs)) return { epoch: value.epoch || null, jobs: value.jobs };
  return { epoch: null, jobs: [] };
}

/** 运行时记录是权威：渲染进程忘了的任务，这里仍然报得出来，且状态不会被“洗白”。 */
function mergeJobLists(stored, fromEda) {
  const byId = new Map();
  for (const job of fromEda) if (job && job.jobId) byId.set(job.jobId, { ...job });
  for (const record of stored) {
    const previous = byId.get(record.jobId) || {};
    byId.set(record.jobId, {
      jobId: record.jobId,
      label: record.label ?? previous.label ?? null,
      state: record.state,
      epoch: record.epoch ?? previous.epoch ?? null,
      startedAt: record.dispatchedAt ?? record.createdAt ?? previous.startedAt ?? null,
      finishedAt: record.finishedAt ?? previous.finishedAt ?? null,
      error: typeof record.error === 'string' ? record.error : (record.error?.message ?? previous.error ?? null),
      count: record.result?.count ?? previous.count ?? 0,
      authority: 'circuitpilot-runtime',
    });
  }
  return [...byId.values()];
}

export class BridgeClient {
  constructor({ ports = BRIDGE_PORTS, fetcher = fetchJson, jobStore = null, logger = console } = {}) {
    this.ports = ports;
    this.fetcher = fetcher;
    this.logger = logger;
    this.port = null;
    this.selectedWindowId = null;
    /**
     * 任务状态的权威存储（可持久化）。放在运行时而非渲染进程：
     * 渲染进程换会话时，这里能把在途任务如实收口为 `interrupted`，而不是丢了了事。
     */
    this.jobs = jobStore || new EdaJobStore();
    /**
     * 单飞队列：同一时刻只允许**一个** `/execute` 在飞。
     *
     * 真机证据：真机 e2e 里三条用例逐条都能过，但从来没有一轮"同时全过"——
     * 失败都是 `Bridge HTTP 500` 或打满预算的 abort，而把同一条命令用独立脚本连着跑 6 次都稳过。
     * 差别在于浏览器里的应用会**并发**发多个桥命令（门禁、布局、验收、修复同时点），
     * 而 EDA 扩展的 JS 执行是单线程的：并发打过去就会有人挨 500。
     * 串行化不改语义，只是把"抢"变成"排队"，并且让在途命令数可解释。
     */
    this._queue = Promise.resolve();
    this._inFlight = 0;
  }

  async discover() {
    const results = await Promise.all(this.ports.map(async (port) => {
      try {
        const health = await this.fetcher(`http://127.0.0.1:${port}/health`);
        return health?.service === 'easyeda-bridge' ? { port, health } : null;
      } catch {
        return null;
      }
    }));
    const match = results.find(Boolean) || null;
    this.port = match?.port ?? null;
    if (!match) this.selectedWindowId = null;
    return match;
  }

  requirePort() {
    if (!this.port) throw Object.assign(new Error('未发现EasyEDA Bridge'), { code: 'BRIDGE_NOT_FOUND' });
    return this.port;
  }

  async windows() {
    const port = this.requirePort();
    const data = await this.fetcher(`http://127.0.0.1:${port}/eda-windows`);
    const windows = Array.isArray(data?.windows) ? data.windows : [];
    if (windows.length === 1) this.selectedWindowId = windows[0].windowId;
    if (windows.length === 0) this.selectedWindowId = null;
    if (windows.length > 1 && !windows.some((item) => item.windowId === this.selectedWindowId)) this.selectedWindowId = null;
    return { ...data, windows, selectedWindowId: this.selectedWindowId, selectionRequired: windows.length > 1 && !this.selectedWindowId };
  }

  async selectWindow(windowId) {
    const port = this.requirePort();
    const data = await this.windows();
    if (!data.windows.some((item) => item.windowId === windowId)) throw Object.assign(new Error('目标EDA窗口不存在'), { code: 'EDA_WINDOW_NOT_FOUND' });
    await this.fetcher(`http://127.0.0.1:${port}/eda-windows/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ windowId }),
    }, 2_000);
    this.selectedWindowId = windowId;
    return { selectedWindowId: windowId };
  }

  listCommands() {
    return Object.entries(COMMANDS).map(([id, command]) => ({ id, permission: command.permission, description: command.description, signature: command.signature }));
  }

  /**
   * 长任务派发前的统一处理：运行时侧先登记 + **同类在途互斥**。
   * 互斥是结构性的防呆：没有它，“超时了就再试一次”会在 EDA 里堆起一串仍在跑的调用
   * （真机实测：客户端放弃 ≠ 服务端取消）。
   */
  _beforeDispatch(commandId, args) {
    const kind = JOB_COMMAND_KINDS[commandId];
    if (!kind) return null;
    const busy = this.jobs.runningOfKind(kind);
    if (busy) {
      throw Object.assign(new Error(`同类后台任务仍在进行（${busy.jobId}）：请等待它结束或先 pcb.job.cancel 收口，不要用重试把它堆进渲染进程`), { code: 'EDA_JOB_BUSY', jobId: busy.jobId, kind });
    }
    this.jobs.create({ jobId: args.jobId, label: COMMANDS[commandId]?.description || commandId, kind });
    return kind;
  }

  /**
   * 长任务回包统一记账：epoch 观察 + 快照印证 + 权威状态回写。
   * 三件事的顺序很重要——先看 epoch 变没变，再让快照印证，最后才可能写 done。
   */
  _trackJobCommand(commandId, args, payload) {
    if (!JOB_COMMAND_KINDS[commandId] && commandId !== 'pcb.job.poll' && commandId !== 'pcb.job.list') return payload;
    if (commandId === 'pcb.drc.job.start') {
      const snapshot = normalizeJobSnapshot(payload);
      const epochInfo = this.jobs.observeEpoch(snapshot.epoch);
      this.jobs.dispatched({ jobId: args.jobId, epoch: snapshot.epoch });
      return { ...payload, result: { ...(payload?.result || {}), epoch: snapshot.epoch, interruptedByEpochChange: epochInfo.interrupted } };
    }
    if (commandId === 'pcb.job.poll') {
      const snapshot = normalizeJobSnapshot(payload);
      const epochInfo = this.jobs.observeEpoch(snapshot.epoch);
      this.jobs.applySnapshot(snapshot);
      const record = this.jobs.get(args.jobId);
      if (record && record.state === 'interrupted') {
        // 渲染进程会说 unknown（它确实忘了），运行时知道那是“结果不可知”，如实回给调用方。
        return { ...payload, result: { ...(payload?.result || {}), jobId: args.jobId, state: 'interrupted', known: false, epoch: snapshot.epoch, error: record.error, interruptedByEpochChange: epochInfo.changed } };
      }
      if (record && snapshot.state === 'done') this.jobs.complete({ jobId: args.jobId, result: snapshot.result });
      if (record && snapshot.state === 'error') this.jobs.fail(args.jobId, { code: 'EDA_JOB_FAILED', message: String(snapshot.error || '未知错误') });
      return payload;
    }
    const list = normalizeJobList(payload);
    if (list.epoch) this.jobs.observeEpoch(list.epoch);
    return { ...payload, result: { epoch: list.epoch ?? this.jobs.epoch, jobs: mergeJobLists(this.jobs.list(), list.jobs) } };
  }

  async execute(commandId, args = {}, { allowWrite = false, allowSensitiveRead = false } = {}) {
    const command = COMMANDS[commandId];
    if (!command) throw Object.assign(new Error('命令未注册，已被策略拒绝'), { code: 'EDA_COMMAND_NOT_ALLOWED' });
    if (['write','write-beta','export-beta'].includes(command.permission) && !allowWrite) throw Object.assign(new Error('写入或导出命令需要受控执行授权'), { code: 'EDA_WRITE_BLOCKED' });
    if (command.permission === 'sensitive-read' && !allowSensitiveRead) throw Object.assign(new Error('敏感读取仅供快照流程使用'), { code: 'EDA_SENSITIVE_READ_BLOCKED' });
    validateArgs(commandId, args);
    // 排进单飞队列：前一条命令结束（无论成功失败）才轮到下一条
    const previous = this._queue;
    let release;
    this._queue = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    this._inFlight += 1;
    try {
      return await this._executeSerial(commandId, command, args, { allowWrite, allowSensitiveRead });
    } finally {
      this._inFlight -= 1;
      release();
    }
  }

  async _executeSerial(commandId, command, args) {
    const kind = this._beforeDispatch(commandId, args);
    try {
      return await this._dispatchSerial(commandId, command, args);
    } catch (error) {
      // 派发前后的任何失败（桥未发现、无 EDA 窗口、参数校验、请求异常）都必须把
      // 互斥登记收口。否则会留下**永远 created 的幽灵任务**，让该类别长任务从此永久
      // EDA_JOB_BUSY（真机实测：一次 BRIDGE_NOT_FOUND 之后 DRC 再也起不来，
      // 连重启 EDA 都无效，只能重启运行时）。
      if (kind) this._failJobQuietly(args?.jobId, error);
      throw error;
    }
  }

  /** 尽力收口：记账失败绝不能掩盖原始错误。 */
  _failJobQuietly(jobId, error) {
    try {
      const record = jobId ? this.jobs.get(jobId) : null;
      if (record && (record.state === 'created' || record.state === 'running')) {
        this.jobs.fail(jobId, { code: error?.code || 'EDA_DISPATCH_FAILED', message: String(error?.message || error).slice(0, 400) });
      }
    } catch { /* 忽略 */ }
  }

  async _dispatchSerial(commandId, command, args) {
    // 惰性发现：运行时重启后第一次调用（尤其是没走 ensureEdaSession 的路由）会直接
    // BRIDGE_NOT_FOUND，而"桥明明活着"。这里补上自动发现，失败才是真失败。
    if (!this.port) await this.discover();
    const port = this.requirePort();
    const windows = await this.windows();
    if (windows.selectionRequired) throw Object.assign(new Error('检测到多个EDA窗口，请先选择目标窗口'), { code: 'EDA_WINDOW_SELECTION_REQUIRED' });
    if (!this.selectedWindowId) throw Object.assign(new Error('没有已连接的EDA窗口'), { code: 'EDA_WINDOW_NOT_CONNECTED' });
    // 逐命令预算：原来这里对所有命令硬编码 8s，长任务（DRC/铺铜/导出）永远拿不到结果。
    // 超过 MAX_TRANSPORT_TIMEOUT_MS 的调用应当改用 pcb.job.* 后台任务模型。
    const timeoutMs = Math.min(command.timeoutMs ?? commandTimeoutMs(commandId), MAX_TRANSPORT_TIMEOUT_MS);
    // 真机实测：桥会**间歇性**对读命令返回 500（浏览器抢走焦点时尤其明显），
    // 而同一条命令用独立脚本直连桥连续 6 次都是 40~90ms 成功。
    // 所以这里只给**读/校验类**命令一次安全重试——写命令绝不能自动重试（可能在 EDA 里产生第二次创建）。
    const dispatch = () => this.fetcher(`http://127.0.0.1:${port}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: command.buildCode ? command.buildCode(args) : command.code, windowId: this.selectedWindowId }),
    }, timeoutMs);
    const retryable = command.permission === 'read' || command.permission === 'validate';
    // 真机实测到的两种瞬时失败都要重试：桥随机 500，以及桥慢到打满命令预算（AbortError，code 20）。
    // 只对读/校验类命令重试；写命令一次也不重试（重试可能造成 EDA 里的第二次创建）。
    const transient = (error) => error?.code === 'BRIDGE_HTTP_ERROR'
      || error?.code === 20 || error?.name === 'AbortError' || error?.name === 'TimeoutError'
      || error?.code === 'EDA_REQUEST_ABANDONED';
    const maxAttempts = retryable ? 3 : 1;
    let payload;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        payload = await dispatch();
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!retryable || !transient(error) || attempt === maxAttempts) break;
        this.logger?.warn?.(`[bridge] 读命令 ${commandId} 第 ${attempt} 次遇到瞬时错误（${error.message}），300ms 后重试`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (lastError) {
      // 派发失败要让运行时记录跟着收口，不能留一个永远 created 的幻影任务。
      if (JOB_COMMAND_KINDS[commandId]) this.jobs.fail(args.jobId, { code: lastError?.code || 'EDA_DISPATCH_FAILED', message: String(lastError?.message || lastError) });
      throw lastError;
    }
    return this._trackJobCommand(commandId, args, payload);
  }
}

/**
 * 哪些命令属于“长任务派发”，以及它们互斥的类别。
 * 新增长任务时必须在这里登记，否则运行时无法为它做在途互斥与状态收口。
 */
const JOB_COMMAND_KINDS = Object.freeze({ 'pcb.drc.job.start': 'pcb.drc' });

export { COMMANDS, JOB_COMMAND_KINDS, validateArgs };
