import { BRIDGE_PORTS } from './config.mjs';
import { isEdaCopperLayerCount } from './engineering/layers.mjs';

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
    permission: 'write-beta',
    description: '创建并打开受控嘉立创EDA工程、原理图和PCB（官方Beta）',
    signature: 'DMT_Project.createProject/openProject + DMT_Board.createBoard + DMT_Schematic.createSchematic/createSchematicPage + DMT_Pcb.createPcb + DMT_EditorControl.openDocument/activateDocument',
    buildCode: ({ friendlyName, projectName, description = '' }) => `const projectUuid=await eda.dmt_Project.createProject(${JSON.stringify(friendlyName)},${JSON.stringify(projectName)},undefined,undefined,${JSON.stringify(description)});if(!projectUuid)throw new Error('PROJECT_CREATE_FAILED');const opened=await eda.dmt_Project.openProject(projectUuid);if(!opened)throw new Error('PROJECT_OPEN_FAILED');const boardName=await eda.dmt_Board.createBoard();if(!boardName)throw new Error('BOARD_CREATE_FAILED');const schematicUuid=await eda.dmt_Schematic.createSchematic(boardName);if(!schematicUuid)throw new Error('SCHEMATIC_CREATE_FAILED');const schematicPageUuid=await eda.dmt_Schematic.createSchematicPage(schematicUuid);if(!schematicPageUuid)throw new Error('SCHEMATIC_PAGE_CREATE_FAILED');const pcbUuid=await eda.dmt_Pcb.createPcb(boardName);if(!pcbUuid)throw new Error('PCB_CREATE_FAILED');const tabId=await eda.dmt_EditorControl.openDocument(pcbUuid);if(!tabId)throw new Error('PCB_OPEN_FAILED');const activated=await eda.dmt_EditorControl.activateDocument(tabId);return {projectUuid,boardName,schematicUuid,schematicPageUuid,pcbUuid,tabId,activated,project:await eda.dmt_Project.getCurrentProjectInfo(),document:await eda.dmt_SelectControl.getCurrentDocumentInfo()};`,
  },
  'schematic.catalog': {
    permission: 'read', description: '读取原理图与页面目录',
    signature: 'DMT_Schematic.getAllSchematicsInfo/getAllSchematicPagesInfo',
    code: 'return { schematics: await eda.dmt_Schematic.getAllSchematicsInfo(), pages: await eda.dmt_Schematic.getAllSchematicPagesInfo() };',
  },
  'schematic.open': { permission: 'navigate', description: '打开指定原理图页面并激活标签页', signature: 'DMT_EditorControl.openDocument/activateDocument', buildCode: ({ documentUuid }) => `const tabId=await eda.dmt_EditorControl.openDocument(${JSON.stringify(documentUuid)});if(!tabId)return {opened:false};return {opened:true,tabId,activated:await eda.dmt_EditorControl.activateDocument(tabId)};` },
  'schematic.components': {
    permission: 'read', description: '读取当前原理图全部元件及引脚',
    signature: 'SCH_PrimitiveComponent.getAll/getAllPinsByPrimitiveId',
    code: 'const components = (await eda.sch_PrimitiveComponent.getAll()) || []; const pins = {}; for (const item of components) { const id = item.primitiveId || item.id; if (id) pins[id] = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)) || []; } return { components, pins };',
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
    permission: 'write', description: '从已批准快照恢复当前文档源码',
    signature: 'SYS_FileManager.setDocumentSource(source)', buildCode: ({ source }) => `return await eda.sys_FileManager.setDocumentSource(${JSON.stringify(source)});`,
  },
  'schematic.component.create': {
    permission: 'write', description: '放置一个已确认库身份的原理图元件',
    signature: 'SCH_PrimitiveComponent.create(component,x,y,...)',
    buildCode: ({ component, x, y, subPartName = '', rotation = 0, mirror = false, addIntoBom = true, addIntoPcb = true }) => `return await eda.sch_PrimitiveComponent.create(${JSON.stringify(component)},${JSON.stringify(x)},${JSON.stringify(y)},${JSON.stringify(subPartName)},${JSON.stringify(rotation)},${JSON.stringify(mirror)},${JSON.stringify(addIntoBom)},${JSON.stringify(addIntoPcb)});`,
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
  'schematic.wire.create': {
    permission: 'write', description: '创建固定坐标原理图导线', signature: 'SCH_PrimitiveWire.create(line,net)',
    buildCode: ({ line, net = '' }) => `return await eda.sch_PrimitiveWire.create(${JSON.stringify(line)},${JSON.stringify(net)});`,
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
  'pcb.layers.setCount': { permission: 'write', description: '设置PCB铜箔层数（官方Beta；新建PCB默认2层）', signature: 'PCB_Layer.setTheNumberOfCopperLayers(n)', buildCode: ({ layers }) => `const ok=await eda.pcb_Layer.setTheNumberOfCopperLayers(${JSON.stringify(layers)});if(ok!==true)throw new Error('PCB_LAYER_COUNT_FAILED');return ok;` },
  'pcb.nets.read': { permission: 'read', description: '读取PCB网络列表', signature: 'PCB_Net.getAllNets()', code: 'return await eda.pcb_Net.getAllNets();' },
  'pcb.components.read': { permission: 'read', description: '读取PCB器件图元ID', signature: 'PCB_PrimitiveComponent.getAllPrimitiveId()', code: 'return await eda.pcb_PrimitiveComponent.getAllPrimitiveId();' },
  'pcb.lines.read': { permission: 'read', description: '读取PCB线段图元ID', signature: 'PCB_PrimitiveLine.getAllPrimitiveId()', code: 'return await eda.pcb_PrimitiveLine.getAllPrimitiveId();' },
  'pcb.vias.read': { permission: 'read', description: '读取PCB过孔图元ID', signature: 'PCB_PrimitiveVia.getAllPrimitiveId()', code: 'return await eda.pcb_PrimitiveVia.getAllPrimitiveId();' },
  'pcb.pours.read': { permission: 'read', description: '读取PCB覆铜图元ID', signature: 'PCB_PrimitivePour.getAllPrimitiveId()', code: 'return await eda.pcb_PrimitivePour.getAllPrimitiveId();' },
  'pcb.regions.read': { permission: 'read', description: '读取PCB区域图元ID', signature: 'PCB_PrimitiveRegion.getAllPrimitiveId()', code: 'return await eda.pcb_PrimitiveRegion.getAllPrimitiveId();' },
  'pcb.texts.read': { permission: 'read', description: '读取PCB文字图元ID', signature: 'PCB_PrimitiveString.getAllPrimitiveId()', code: 'return await eda.pcb_PrimitiveString.getAllPrimitiveId();' },
  'pcb.open': { permission: 'navigate', description: '打开指定PCB文档并激活标签页', signature: 'DMT_EditorControl.openDocument/activateDocument', buildCode: ({ documentUuid }) => `const tabId=await eda.dmt_EditorControl.openDocument(${JSON.stringify(documentUuid)});if(!tabId)return {opened:false};return {opened:true,tabId,activated:await eda.dmt_EditorControl.activateDocument(tabId)};` },
  'pcb.rules.read': { permission: 'read', description: '读取当前PCB规则配置摘要', signature: 'PCB_Drc.getCurrentRuleConfiguration/getCurrentRuleConfigurationName', code: 'const configuration=await eda.pcb_Drc.getCurrentRuleConfiguration();return {name:await eda.pcb_Drc.getCurrentRuleConfigurationName(),keys:Object.keys(configuration||{})};' },
  'pcb.source.read': { permission: 'sensitive-read', description: '读取当前PCB源码快照', signature: 'SYS_FileManager.getDocumentSource()', code: 'return await eda.sys_FileManager.getDocumentSource();' },
  'pcb.importChanges': { permission: 'write', description: '从同一Board关联原理图导入变更', signature: 'PCB_Document.importChanges(uuid?)', buildCode: ({ schematicUuid }) => `return await eda.pcb_Document.importChanges(${schematicUuid ? JSON.stringify(schematicUuid) : ''});` },
  'pcb.save': { permission: 'write', description: '保存当前PCB文档', signature: 'PCB_Document.save()', code: 'return await eda.pcb_Document.save();' },
  'pcb.component.modify': { permission: 'write-beta', description: '固定坐标修改PCB器件（官方Beta）', signature: 'PCB_PrimitiveComponent.modify(id,property)', buildCode: ({ primitiveId, property }) => `return await eda.pcb_PrimitiveComponent.modify(${JSON.stringify(primitiveId)},${JSON.stringify(property)});` },
  'pcb.line.create': { permission: 'write-beta', description: '创建PCB线段/板框线（官方Beta）', signature: 'PCB_PrimitiveLine.create(net,layer,x1,y1,x2,y2,width,lock)', buildCode: ({ net = '', layer, startX, startY, endX, endY, lineWidth = 0.2, primitiveLock = false }) => `return await eda.pcb_PrimitiveLine.create(${JSON.stringify(net)},${JSON.stringify(layer)},${JSON.stringify(startX)},${JSON.stringify(startY)},${JSON.stringify(endX)},${JSON.stringify(endY)},${JSON.stringify(lineWidth)},${JSON.stringify(primitiveLock)});` },
  'pcb.via.create': { permission: 'write-beta', description: '创建PCB过孔（官方Beta；盲埋孔跨度由设计规则项名指定，null 表示非盲埋孔）', signature: 'PCB_PrimitiveVia.create(net,x,y,hole,diameter,viaType?,designRuleBlindViaName?)', buildCode: ({ net, x, y, holeDiameter, diameter, viaType, designRuleBlindViaName }) => {
    const positional = [JSON.stringify(net), JSON.stringify(x), JSON.stringify(y), JSON.stringify(holeDiameter), JSON.stringify(diameter)];
    // 官方签名为位置参数：designRuleBlindViaName 是第 7 个，必须先填 viaType 才能填它。
    // viaType 的取值编码（官方类型是 0/1/2 枚举，但运行时 JS 已混淆、无法核实）
    // 因此这里保持原样透传，不擅自改动语义。
    if (viaType !== undefined || designRuleBlindViaName !== undefined) positional.push(JSON.stringify(viaType));
    if (designRuleBlindViaName !== undefined) positional.push(JSON.stringify(designRuleBlindViaName));
    return `return await eda.pcb_PrimitiveVia.create(${positional.join(',')});`;
  } },
  'pcb.pour.create': { permission: 'write-beta', description: '创建PCB覆铜（官方Beta）', signature: 'PCB_PrimitivePour.create(net,layer,polygon,...)', buildCode: ({ net, layer, complexPolygon, preserveSilos = false, pourName = 'GND', pourPriority = 0, lineWidth = 0.2, primitiveLock = false }) => `return await eda.pcb_PrimitivePour.create(${JSON.stringify(net)},${JSON.stringify(layer)},${JSON.stringify(complexPolygon)},undefined,${JSON.stringify(preserveSilos)},${JSON.stringify(pourName)},${JSON.stringify(pourPriority)},${JSON.stringify(lineWidth)},${JSON.stringify(primitiveLock)});` },
  'pcb.drc': { permission: 'validate', description: '运行官方PCB DRC并返回详细结果', signature: 'PCB_Drc.check(true,false,true)', code: 'return await eda.pcb_Drc.check(true,false,true);' },
  'pcb.drc.ui': { permission: 'validate', description: '在嘉立创EDA界面显示PCB DRC', signature: 'PCB_Drc.check(true,true,true)', code: 'return await eda.pcb_Drc.check(true,true,true);' },
  'pcb.3d': { permission: 'validate', description: '请求官方PCB 3D文件用于可用性检查', signature: 'PCB_ManufactureData.get3DFile()', code: 'const f=await eda.pcb_ManufactureData.get3DFile();return f?{name:f.name,size:f.size,type:f.type}:null;' },
  'pcb.bom.inspect': { permission: 'export-beta', description: '生成BOM并仅返回元数据（官方Beta）', signature: 'PCB_ManufactureData.getBomFile()', code: 'const f=await eda.pcb_ManufactureData.getBomFile("CircuitPilot-BOM","csv");return f?{name:f.name,size:f.size,type:f.type}:null;' },
  'pcb.cpl.inspect': { permission: 'export-beta', description: '生成CPL并仅返回元数据（官方Beta）', signature: 'PCB_ManufactureData.getPickAndPlaceFile()', code: 'const f=await eda.pcb_ManufactureData.getPickAndPlaceFile("CircuitPilot-CPL","csv");return f?{name:f.name,size:f.size,type:f.type}:null;' },
  'pcb.gerber.inspect': { permission: 'export-beta', description: '生成Gerber并仅返回元数据（官方Beta）', signature: 'PCB_ManufactureData.getGerberFile()', code: 'const f=await eda.pcb_ManufactureData.getGerberFile("CircuitPilot-Gerber");return f?{name:f.name,size:f.size,type:f.type}:null;' },
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
  if (commandId === 'schematic.pin.noConnect') {
    if (typeof args.componentPrimitiveId !== 'string' || !args.componentPrimitiveId.length || !Array.isArray(args.pinNumbers) || !args.pinNumbers.length || !args.pinNumbers.every((number) => typeof number === 'string' && number.length <= 20)) throw Object.assign(new Error('未连接引脚参数无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'schematic.netFlag.create') {
    if (!['Power', 'Ground', 'AnalogGround', 'ProtectGround'].includes(args.identification) || typeof args.net !== 'string' || !args.net.length || !finiteCoordinate(args.x) || !finiteCoordinate(args.y)) throw Object.assign(new Error('网络标识参数无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    requireFiniteNumber(args.rotation ?? 0, 'rotation');
    requireBoolean(args.mirror ?? false, 'mirror');
  }
  if (commandId === 'schematic.wire.create') {
    const flat = Array.isArray(args.line) ? args.line.flat(Infinity) : [];
    if (flat.length < 4 || flat.length % 2 || !flat.every(finiteCoordinate) || (args.net !== undefined && typeof args.net !== 'string')) throw Object.assign(new Error('导线坐标或网络名无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'schematic.wire.read') {
    if (!Array.isArray(args.primitiveIds) || !args.primitiveIds.length || !args.primitiveIds.every((id) => typeof id === 'string' && id.length)) throw Object.assign(new Error('导线回读图元 ID 无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'pcb.importChanges' && args.schematicUuid !== undefined && (typeof args.schematicUuid !== 'string' || !args.schematicUuid.length)) throw Object.assign(new Error('原理图UUID无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  if (['pcb.open','schematic.open'].includes(commandId) && (typeof args.documentUuid !== 'string' || !/^[a-f0-9]{16,64}$/i.test(args.documentUuid))) throw Object.assign(new Error('EDA文档UUID无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  if (commandId === 'pcb.component.modify') {
    if (typeof args.primitiveId !== 'string' || !args.primitiveId.length || !args.property || typeof args.property !== 'object') throw Object.assign(new Error('PCB器件修改参数无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
    for (const key of ['x','y','rotation']) if (args.property[key] !== undefined && !finiteCoordinate(args.property[key])) throw Object.assign(new Error(`PCB器件${key}无效`), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'pcb.line.create') {
    if (typeof args.layer !== 'string' && typeof args.layer !== 'number') throw Object.assign(new Error('PCB线段层无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
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
  if (commandId === 'pcb.layers.setCount') {
    if (!isEdaCopperLayerCount(args.layers)) throw Object.assign(new Error('铜箔层数必须是 2,4,6,…,32 中的偶数'), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  if (commandId === 'pcb.pour.create') {
    if (typeof args.net !== 'string' || !args.net.length || (typeof args.layer !== 'string' && typeof args.layer !== 'number') || !args.complexPolygon || typeof args.complexPolygon !== 'object') throw Object.assign(new Error('PCB覆铜参数无效'), { code: 'EDA_COMMAND_ARGS_INVALID' });
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
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || parsed?.message || '';
      } catch { detail = text; }
      const safeDetail = String(detail).replace(/[\r\n\t]+/g, ' ').slice(0, 400);
      throw Object.assign(new Error(`Bridge HTTP ${response.status}${safeDetail ? ` · ${safeDetail}` : ''}`), { code: 'BRIDGE_HTTP_ERROR', status: response.status });
    }
    try { return JSON.parse(text); }
    catch { throw Object.assign(new Error('Bridge返回了非JSON响应'), { code: 'BRIDGE_INVALID_RESPONSE' }); }
  } finally {
    clearTimeout(timer);
  }
}

export class BridgeClient {
  constructor({ ports = BRIDGE_PORTS, fetcher = fetchJson } = {}) {
    this.ports = ports;
    this.fetcher = fetcher;
    this.port = null;
    this.selectedWindowId = null;
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

  async execute(commandId, args = {}, { allowWrite = false, allowSensitiveRead = false } = {}) {
    const command = COMMANDS[commandId];
    if (!command) throw Object.assign(new Error('命令未注册，已被策略拒绝'), { code: 'EDA_COMMAND_NOT_ALLOWED' });
    if (['write','write-beta','export-beta'].includes(command.permission) && !allowWrite) throw Object.assign(new Error('写入或导出命令需要受控执行授权'), { code: 'EDA_WRITE_BLOCKED' });
    if (command.permission === 'sensitive-read' && !allowSensitiveRead) throw Object.assign(new Error('敏感读取仅供快照流程使用'), { code: 'EDA_SENSITIVE_READ_BLOCKED' });
    validateArgs(commandId, args);
    const port = this.requirePort();
    const windows = await this.windows();
    if (windows.selectionRequired) throw Object.assign(new Error('检测到多个EDA窗口，请先选择目标窗口'), { code: 'EDA_WINDOW_SELECTION_REQUIRED' });
    if (!this.selectedWindowId) throw Object.assign(new Error('没有已连接的EDA窗口'), { code: 'EDA_WINDOW_NOT_CONNECTED' });
    return this.fetcher(`http://127.0.0.1:${port}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: command.buildCode ? command.buildCode(args) : command.code, windowId: this.selectedWindowId }),
    }, 8_000);
  }
}

export { COMMANDS, validateArgs };
