import { createHash } from 'node:crypto';

/**
 * 统一失败诊断入口（D4）。
 *
 * 目标：任何失败（执行/验证门禁/自动化/EDA 桥/持久化）都收敛成同一条 issue 记录，
 * 带**证据**（错误码、details、运行 ID、证据路径、步骤）和**修复入口**（页面 + 动作），
 * 而不是散落在各个 catch 里的一段 notify 文本。
 *
 * 边界：本模块只做"把已发生的失败翻译成可定位的问题"，不重试、不修复、不猜原因；
 * 未知错误码按 error 处理并给人工排查建议（fail-closed：不把未知失败降级成 info）。
 */

export const FAILURE_SOURCES = Object.freeze(['ai', 'eda', 'validation', 'runtime', 'persistence', 'provider']);

const SEVERITY = new Set(['info', 'warning', 'error', 'critical']);

/** 已知错误码 → 严重级 + 建议 + 修复入口（页面 id 与 src/types.ts PageId 对齐）。 */
const CATALOG = {
  EDA_OFFLINE: { severity: 'error', summary: '嘉立创EDA 不可达', suggestion: '确认 EDA 已打开并允许远程调试（CDP 9222），再点"重新检测"；不要用离线演示数据当真实结果。', repair: { page: 'settings', label: '去连接 EDA' } },
  EDA_BRIDGE_UNAVAILABLE: { severity: 'error', summary: 'EDA Bridge 不可用', suggestion: '在设置页启动/重启 Bridge，确认端口可访问后重试。', repair: { page: 'settings', label: '去启动 Bridge' } },
  BRIDGE_COMMAND_FAILED: { severity: 'error', summary: 'EDA 命令执行失败', suggestion: '查看 details 中的命令与返回；确认当前窗口/工程/文档未被切换后重试。', repair: { page: 'eda', label: '去 EDA 页复查' } },
  AUTOMATION_APPROVAL_REQUIRED: { severity: 'error', summary: '真实写入缺少人工批准', suggestion: '在自动化页按 scope 签发对应批准（写板批准必须人工点击），再重跑；AI 不能代签。', repair: { page: 'automation', label: '去签发批准' } },
  AUTOMATION_APPROVAL_INVALID: { severity: 'error', summary: '批准无效或已过期', suggestion: '批准与窗口/工程/文档指纹绑定且一次性；重新对当前 EDA 状态签发批准后再执行。', repair: { page: 'automation', label: '重新签发批准' } },
  AUTOMATION_APPROVAL_REQUIRED_FOR_RELEASE: { severity: 'error', summary: '放行缺少人工批准', suggestion: '放行批准只能由人签发；AI 不能自行放行。', repair: { page: 'automation', label: '去签发放行批准' } },
  DESIGN_PLAN_INCOMPLETE: { severity: 'warning', summary: '设计计划缺少必要步骤', suggestion: '补齐需求/选型后重新生成计划；缺步骤时执行会被拒绝而不是"部分执行"。', repair: { page: 'design', label: '去设计页补计划' } },
  PRODUCTION_GATE_BLOCKED: { severity: 'error', summary: '放行闸门阻断', suggestion: '按闸门列出的缺失证据逐项补齐（DRC/ERC/DFM/签核/供应链），不要跳过。', repair: { page: 'validation', label: '去验证页补证据' } },
  DRC_NOT_RUN: { severity: 'error', summary: '没有 DRC 证据', suggestion: '在验证页真机运行 PCB DRC 并落盘；没有 DRC 证据闸门必须阻断。', repair: { page: 'validation', label: '去运行 DRC' } },
  DFM_EVIDENCE_INVALID: { severity: 'error', summary: 'DFM 证据不合法', suggestion: '在线 DFM 只能人工做；回填时必须显式给出 passed 与结论。', repair: { page: 'validation', label: '去登记 DFM' } },
  SIGNOFF_INVALID: { severity: 'error', summary: '终审签核不完整', suggestion: '三方角色、结论与物料清单哈希必须齐全；签核不能被客户端伪造。', repair: { page: 'validation', label: '去完成签核' } },
  STORE_CORRUPT: { severity: 'critical', summary: '持久化状态损坏', suggestion: '保留现场文件，从备份恢复；不要直接覆盖，否则丢失失败证据。', repair: { page: 'settings', label: '去设置页处理' } },
  STORE_SCHEMA_MISMATCH: { severity: 'error', summary: '状态 schema 版本不兼容', suggestion: '升级 runtime 或用对应版本读取；不要手工改 schemaVersion。', repair: { page: 'settings', label: '去设置页处理' } },
  PROVIDER_AUTH_FAILED: { severity: 'error', summary: '模型 Provider 鉴权失败', suggestion: '在设置页检查 API Key/Base URL 是否有效；Key 不会进入问题记录。', repair: { page: 'settings', label: '去检查 Provider' } },
  // —— 真机实测高频项（第 22–23 轮补齐；以下每条都有真实样本，不是补全枚举）——
  BRIDGE_HTTP_ERROR: { severity: 'error', summary: 'EDA Bridge 返回 HTTP 错误（多为渲染进程瞬时 500）', suggestion: '读命令可重试；写命令先读回确认是否其实已落板，再决定重试（禁止盲目重放）。连续失败检查 EDA 版本/窗口状态，见 G5 版本适配。', repair: { page: 'eda', label: '去 EDA 页复查' } },
  EDA_REQUEST_ABANDONED: { severity: 'warning', summary: 'EDA 命令已派发但未在超时内返回', suggestion: '渲染进程可能仍在执行：先读回核实结果，未落板才重试；写命令重试前必须确认（防止重复写）。“没等到返回”既不是成功也不是失败。', repair: { page: 'eda', label: '去 EDA 页读回' } },
  EDA_JOB_BUSY: { severity: 'warning', summary: '同类 EDA 长任务仍在进行', suggestion: '等待任务结束或调用 pcb.job.cancel 收口；不要用重试把任务堆进渲染进程。', repair: { page: 'eda', label: '去 EDA 页查看任务' } },
  EDA_COMMAND_ARGS_INVALID: { severity: 'error', summary: 'EDA 命令参数校验失败', suggestion: '按错误 details 修正参数；参数校验在派发前失败，没有写入 EDA。', repair: { page: 'eda', label: '去 EDA 页修正' } },
  EDA_GUI_ELEMENT_NOT_FOUND: { severity: 'error', summary: 'GUI 兜底找不到目标元素（菜单/文案漂移）', suggestion: 'EDA 版本升级常改菜单文案：先查能力探测结果，再用 clickText/waitText 断言定位；连续失败不要盲试备选动作。', repair: { page: 'automation', label: '去自动化页查配方' } },
  EDA_GUI_ACTION_NOT_ALLOWED: { severity: 'error', summary: 'GUI 动作不在安全白名单内', suggestion: '动作被安全层拒绝，没有点击 EDA；需要新动作时必须登记白名单并补测试，不能由 AI 自由点击。', repair: { page: 'automation', label: '去自动化页查动作' } },
  EDA_GUI_CDP_UNAVAILABLE: { severity: 'error', summary: 'EDA 未开启调试端口（GUI 通道不可用）', suggestion: '在 EDA 设置中启用远程调试（CDP 9222）；GUI 兜底不可用时只能用 API 通道并如实报告。', repair: { page: 'settings', label: '去设置页启用' } },
  EDA_DOCUMENT_REQUIRED: { severity: 'error', summary: '当前活动文档不是所需类型', suggestion: '先打开目标工程/PCB/原理图页面，或传 pcbUuid/documentUuid 让运行时替你打开并等就绪。', repair: { page: 'eda', label: '去 EDA 页打开文档' } },
  EDA_CAPABILITY_PROBE_FAILED: { severity: 'error', summary: 'EDA 写入前能力探测未通过', suggestion: '按 missing 命令列表检查 EDA 版本与 API 可用性；缺能力时拒绝执行，不降级成假成功。', repair: { page: 'settings', label: '去设置页看能力' } },
  EDA_EXPORT_BUFFER_LOST: { severity: 'error', summary: '导出缓冲丢失/已过期', suggestion: '重新执行导出（exportId 已失效）；分片读取失败不能把半截文件当完整结果。', repair: { page: 'eda', label: '去重新导出' } },
  TARGET_DRIFT: { severity: 'error', summary: '批准后 EDA 目标（窗口/工程/文档）发生变化', suggestion: '回到当前 EDA 状态重新签发批准再执行；旧批准作废（这是防错设计，不是 bug）。', repair: { page: 'automation', label: '重新签发批准' } },
  EXECUTION_BUSY: { severity: 'warning', summary: '已有写任务正在执行', suggestion: '等待当前任务结束；不要并发写同一 EDA 文档。', repair: { page: 'eda', label: '去 EDA 页等待' } },
  SAVE_FAILED: { severity: 'error', summary: 'EDA 未确认保存成功', suggestion: '核对 EDA 是否弹窗/断连；保存未确认时不能声称已落盘，按半写状态处理（E8）。', repair: { page: 'eda', label: '去 EDA 页复查' } },
  READBACK_UNCHANGED: { severity: 'error', summary: '写入后设计内容未发生预期变化', suggestion: '动作可能空转：先读回确认，再决定是否重试或换通道；绝不把“调用没报错”当成功。', repair: { page: 'eda', label: '去 EDA 页读回' } },
  READBACK_PRIMITIVE_MISSING: { severity: 'error', summary: '回读缺少新建图元', suggestion: '按错误里的图元 ID 读回确认；缺失项需要重写或整体回滚，不能补记录当成功。', repair: { page: 'eda', label: '去 EDA 页读回' } },
  READBACK_NO_CONNECT_MISSING: { severity: 'error', summary: '回读缺少未连接标识', suggestion: '重新应用未连接标识并逐引脚读回；标记丢失会导致 ERC 假阴性。', repair: { page: 'eda', label: '去 EDA 页复查' } },
  READBACK_WIRE_GEOMETRY_MISSING: { severity: 'error', summary: '回读缺少导线几何', suggestion: '导线写入可能被合并/丢弃；按几何与 ID 双判据读回，缺失时回滚重来。', repair: { page: 'eda', label: '去 EDA 页读回' } },
  NET_CONNECT_CONNECTIONS_INVALID: { severity: 'error', summary: '网表连线计划不合法', suggestion: '按 findings 修正网络名/引脚/目标网；计划不合法时拒绝执行，未写任何图元。', repair: { page: 'eda', label: '去 EDA 页改计划' } },
  NET_CONNECT_WRITE_FAILED: { severity: 'error', summary: '网络端口写入失败', suggestion: '先读回确认是否已创建（中止场景）；未创建再重试，已创建走回滚/核对，不重复写。', repair: { page: 'eda', label: '去 EDA 页复查' } },
  NET_CONNECT_VERIFY_FAILED: { severity: 'error', summary: '网表读回与目标不一致', suggestion: '按 verification 的 missing/unexpected 逐引脚核对；不一致必须回滚，不能保留部分连线。', repair: { page: 'eda', label: '去 EDA 页复查' } },
  NET_CONNECT_ROLLBACK_INCOMPLETE: { severity: 'critical', summary: '网表连线回滚未完全确认', suggestion: '按 primitiveIds 读回图元并二次清理；残留图元会让板子处于半写状态（E8），必须人工复核。', repair: { page: 'eda', label: '去 EDA 页处理残留' } },
  PLACEMENT_WRITE_VERIFY_BLOCKED: { severity: 'error', summary: '布局写回后几何复核不通过', suggestion: '写回已按原坐标回滚；先修规则/间距/板框再重试，不要绕过复核。', repair: { page: 'placement', label: '去布局页修规则' } },
  PLACEMENT_WRITE_READBACK_MISMATCH: { severity: 'error', summary: '布局写回回读位置不符', suggestion: '坐标级回滚已执行；核对器件是否被 EDA 吸附/锁定，再重试。', repair: { page: 'placement', label: '去布局页复查' } },
  PLACEMENT_WRITE_ROLLBACK_FAILED: { severity: 'critical', summary: '布局回滚未能完全还原', suggestion: '按 manualCoordinates（mil）手工改回，或从源码快照恢复；这是半写状态，必须人工处理。', repair: { page: 'placement', label: '去布局页处理' } },
  ROUTING_PLAN_REJECTED: { severity: 'error', summary: '布线计划未通过独立复核', suggestion: '按 violations/connectivity 修计划；未复核通过的计划拒绝写入（本次未写铜）。', repair: { page: 'placement', label: '去布线计划页' } },
  ROUTING_READBACK_MISMATCH: { severity: 'error', summary: '布线写入后回读比对失败', suggestion: '已自动回滚；按 missing/residual 读回确认铜几何，残留必须在 DRC 前清理。', repair: { page: 'placement', label: '去布线页复查' } },
  PRODUCTION_OUTPUT_BLOCKED: { severity: 'error', summary: '正式产出被闸门阻断', suggestion: '按 releaseDecision.blockedBy 逐项补证据；未 ready 只能出 DRAFT 命名草稿。', repair: { page: 'validation', label: '去验证页补证据' } },
  RELEASE_DECISION_BLOCKED: { severity: 'error', summary: '统一放行裁决为 blocked', suggestion: '按 blockedBy 的 source/原因补齐证据（DRC/ERC/DFM/签核/供应链），不要用其他页面的“通过”覆盖。', repair: { page: 'validation', label: '去验证页处理' } },
  PRODUCTION_EXPORT_VERIFY_FAILED: { severity: 'error', summary: '生产文件导出后复核失败', suggestion: '这些文件不能当交付物：按 verification.blockingCount 修设计后重新导出。', repair: { page: 'validation', label: '去验证页复查' } },
  AUTOMATION_RECIPE_INVALID: { severity: 'error', summary: '自动化配方不合法', suggestion: '按错误信息补 expect/参数/动作白名单；没有读回断言的步骤不允许执行。', repair: { page: 'automation', label: '去自动化页修配方' } },
  RELEASE_CONSTRAINT_FAILED: { severity: 'error', summary: '需求硬约束未满足', suggestion: '按放行报告里 constraints 子门的逐条结论修设计（板框/电流预算/GPIO/接口/温度）；改计划或改需求都必须走批准，不能绕门禁。', repair: { page: 'validation', label: '去验证页看约束' } },
  RELEASE_CONSTRAINT_FACT_UNKNOWN: { severity: 'error', summary: '约束缺设计事实，无法验证', suggestion: '补设计事实（板框实测、电流估算、GPIO/接口清单）后再跑；拿不到事实时闸门按阻断处理，不能默认通过。', repair: { page: 'validation', label: '去验证页补事实' } },
  ORDER_CONFIRMATION_INPUT_INVALID: { severity: 'error', summary: '下单确认缺少必要信息', suggestion: '确认人必填，并显式声明下单/支付由人完成；参数卡需先用本机生成。', repair: { page: 'validation', label: '去验证页补全' } },
  ORDER_CONFIRMATION_BLOCKED: { severity: 'error', summary: '参数卡还不可下单，不能人工确认', suggestion: '先按参数卡的阻断/未确认项修好（层数/尺寸/DRC/文件/价格来源），卡片 readyToOrder=true 后再确认。', repair: { page: 'validation', label: '去验证页生成参数卡' } },
  PIN_EVIDENCE_EMPTY: { severity: 'error', summary: '没有读到任何引脚/焊盘证据', suggestion: '先打开对应 PCB 文档并确认 EDA 会话正常；空证据不能当通过（A4）。', repair: { page: 'validation', label: '去验证页采集' } },
  PIN_NET_UNKNOWN: { severity: 'error', summary: '焊盘没有网络且没有显式 assumption', suggestion: '在引脚证据请求里给该 位号.脚号 补 reason（如 NC/未用脚），或先在原理图/PCB 把网络连好；缺证据会阻断网表/执行计划。', repair: { page: 'validation', label: '去验证页补证据' } },
  PIN_EVIDENCE_REQUIRED: { severity: 'error', summary: '本次网表生成要求引脚证据但请求没带', suggestion: '先采集引脚证据并随请求传入，再生成网表；不能凭"没证据"生成可执行网表。', repair: { page: 'eda', label: '去 EDA 页重试' } },
  PIN_EVIDENCE_BLOCKED: { severity: 'error', summary: '引脚证据审计未通过，网表生成被阻断', suggestion: '按审计 blockers 修正（未知网络加 assumption/补连网络/去掉重复焊盘）后重试。', repair: { page: 'validation', label: '去验证页查看阻断项' } },
  SIMULATION_NETLIST_REQUIRED: { severity: 'error', summary: '没有可用的 SPICE 仿真网表', suggestion: '在嘉立创EDA 原理图里绑定仿真模型并保存后重试，或在请求里显式提供 netlistText。没有网表 ≠ 仿真通过。', repair: { page: 'validation', label: '去验证页查看' } },
  SIMULATION_SOLVER_MISSING: { severity: 'error', summary: '本机没有 SPICE 求解器', suggestion: '安装 ngspice（如 brew install ngspice）后重试；仿真证据必须由真实求解器产出，系统不会返回伪造结论。', repair: { page: 'validation', label: '去验证页重试' } },
  SIMULATION_EVIDENCE_INVALID: { severity: 'error', summary: '仿真证据未通过校验', suggestion: '证据绑定的网表指纹/产物哈希与当前原理图不一致时旧结论自动失效；重新跑仿真，不要复用旧证据。', repair: { page: 'validation', label: '去验证页重跑' } },
  PROJECT_STATE_INVALID: { severity: 'error', summary: '项目状态不合法，未落盘', suggestion: '检查 projects/requirements 是否为数组、id 是否重复、activeProjectId 是否指向存在的项目；修正后重试（Runtime 不会静默修正后保存）。', repair: { page: 'settings', label: '去设置检查' } },
  PCB_POUR_CREATE_FAILED: { severity: 'error', summary: '新建覆铜失败', suggestion: '先确认活动文档是 PCB 且层号/网络/多边形合法；EDA 报"参数不正确"时用真机验证过的 outline（[[x,y],...] 原生单位 mil）重试。写入失败不要保存。', repair: { page: 'pcb', label: '去 PCB 页检查' } },
  PCB_POUR_VERIFY_FAILED: { severity: 'error', summary: '新建覆铜后读回不符', suggestion: '按 verification 里的网络/层/新增数量定位；不一致时系统已自动删除本次新建图元，不要保存或声称成功。', repair: { page: 'pcb', label: '去 PCB 页读回' } },
  PCB_POUR_ROLLBACK_INCOMPLETE: { severity: 'critical', summary: '覆铜验证模式清理失败', suggestion: '新建图元可能仍在板上且未保存：先读回确认并手工删除，再重试；清理不干净不能当验证通过。', repair: { page: 'pcb', label: '去 PCB 页清理' } },
  PLACEMENT_RULES_BLOCKED: { severity: 'error', summary: '布局计划未通过 128 条规则审计', suggestion: '按 audit.blocking 里的 ruleId 定位（如 MECH-05 板边器件）修坐标/占位，再预演一次；审计不过绝不写回。', repair: { page: 'pcb', label: '去布局页修计划' } },
  DESIGNATOR_UNANNOTATED: { severity: 'error', summary: '计划含未标注位号（C?/R?）', suggestion: '先在 EDA 完成位号标注（设计→标注位号），或用「位号标注」接口把 C? 改成 C36 等，再重跑；带 ? 的计划不进入任何写入。', repair: { page: 'eda', label: '去 EDA 标注位号' } },
  DESIGNATOR_INVALID: { severity: 'error', summary: '目标位号不合法', suggestion: '目标位号必须是字母前缀+数字（如 C36）；不能把 C? 当目标值，也不能用纯数字。', repair: { page: 'eda', label: '去 EDA 修正位号' } },
  DESIGNATOR_READBACK_MISMATCH: { severity: 'error', summary: '位号标注后读回不一致', suggestion: '先确认 EDA 是否弹窗/断连；未保存的位号改动不能算完成，按读回差异逐件重标。', repair: { page: 'eda', label: '去 EDA 页读回' } },
  SCHEMATIC_BATCH_ITEMS_INVALID: { severity: 'error', summary: '批量落件项不合法', suggestion: '检查每项的库身份（libraryUuid/uuid）与坐标；单批最多 300 项，重复身份+坐标会被拒绝。', repair: { page: 'eda', label: '去修正批量项' } },
  SCHEMATIC_BATCH_STATE_MISMATCH: { severity: 'error', summary: '续跑状态与计划不匹配', suggestion: '换一份计划就换一个状态文件；不要用旧进度续跑新计划（会漏件或重复件）。', repair: { page: 'eda', label: '去 EDA 页检查' } },
  SCHEMATIC_BATCH_STATE_CORRUPT: { severity: 'critical', summary: '批量落件进度文件损坏', suggestion: '保留现场文件人工核对已完成图元；损坏的状态不能当"已完成"继续跑。', repair: { page: 'settings', label: '去设置页处理' } },
  SCHEMATIC_BATCH_CREATE_FAILED: { severity: 'error', summary: '批量落件中途创建失败', suggestion: '失败即停，已创建项有进度记录；修复 EDA/桥后按同一计划续跑，只补剩余项。', repair: { page: 'eda', label: '去 EDA 页续跑' } },
  SCHEMATIC_BATCH_SAVE_FAILED: { severity: 'error', summary: '批量落件后保存未确认', suggestion: '保存未返回 true 不能声称已落盘；按半写状态核对图元，再决定重存。', repair: { page: 'eda', label: '去 EDA 页复查' } },
  SCHEMATIC_BATCH_VERIFY_FAILED: { severity: 'error', summary: '批量落件读回不一致', suggestion: '按 verification.findings 逐项核对缺失项；缺件 / 重复件必须先收敛，不能当完成。', repair: { page: 'eda', label: '去 EDA 页读回' } },
  SCHEMATIC_BATCH_READBACK_INVALID: { severity: 'error', summary: '读不到原理图器件现状', suggestion: '先打开原理图页面并确认是活动文档；看不到现状时拒绝批量落件。', repair: { page: 'eda', label: '去 EDA 打开原理图' } },
  FAILURE_DIAGNOSIS_INVALID: { severity: 'error', summary: '失败诊断输入不完整', suggestion: '诊断需要 error.code；缺证据时按未分类失败人工排查，不能降级成通过。', repair: { page: 'settings', label: '去设置页检查' } },
};

/** 只保留可安全展示的上下文字段；令牌/密钥一律丢弃（宁可少信息，不泄漏）。 */
const FORBIDDEN_KEY = /token|secret|password|passwd|api[-_]?key|authorization|cookie|session/i;
const CONTEXT_KEYS = new Set(['runId', 'jobId', 'recipeId', 'step', 'operation', 'requestId', 'journalEntryId', 'evidencePath', 'documentUuid', 'pcbUuid', 'windowId', 'projectUuid', 'route', 'approvalIds', 'phase']);

export function sanitizeFailureContext(context = {}) {
  const out = {};
  if (!context || typeof context !== 'object') return out;
  for (const [key, value] of Object.entries(context)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    if (!CONTEXT_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      const shown = value.filter((item) => ['string', 'number', 'boolean'].includes(typeof item)).slice(0, 8).map((item) => String(item).slice(0, 80));
      if (shown.length) out[key] = shown.join(', ');
    } else if (['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = String(value).slice(0, 200);
    }
  }
  return out;
}

const text = (value, limit = 400) => String(value ?? '').trim().slice(0, limit);

/**
 * @param {{source?:string, error?:{code?:string,message?:string,details?:unknown}, context?:object}} input
 * @returns {{source:string, severity:string, code:string, summary:string, detail:string, fingerprint:string, context:Record<string,string>, suggestedAction:string, repair:{page:string,label:string}|null, known:boolean}}
 */
export function diagnoseFailure({ source = 'runtime', error = {}, context = {} } = {}) {
  const resolvedSource = FAILURE_SOURCES.includes(source) ? source : 'runtime';
  const code = text(error?.code, 80).toUpperCase().replace(/[^A-Z0-9_.-]/g, '_') || 'UNKNOWN_RUNTIME_FAILURE';
  const entry = CATALOG[code] || null;
  const message = text(error?.message, 300) || '失败但未提供错误信息';
  const safeContext = sanitizeFailureContext(context);
  const details = error?.details && typeof error.details === 'object' ? error.details : null;
  // details 可能很大：只保留可读 JSON 摘要，且不包含任何令牌类字段（外层 context 已白名单）。
  let detailText = message;
  if (details) {
    try { detailText += ` · details=${JSON.stringify(details).slice(0, 600)}`; } catch { /* 循环引用等极端情况忽略 details */ }
  }
  const fingerprint = createHash('sha256').update(`${resolvedSource}:${code}:${safeContext.operation || ''}:${safeContext.recipeId || ''}`).digest('hex').slice(0, 16);
  const severity = SEVERITY.has(entry?.severity) ? entry.severity : 'error';
  return {
    source: resolvedSource,
    severity,
    code,
    summary: entry?.summary || `未分类失败（${code}）`,
    detail: detailText,
    fingerprint,
    context: safeContext,
    suggestedAction: entry?.suggestion || '这是未登记的错误码：保留证据/日志（runId、证据路径）后人工排查；系统不会把未知失败当成通过。',
    repair: entry?.repair || null,
    known: Boolean(entry),
  };
}

/** 把诊断结果转成前端 IssueRecord 的公共字段（id/时间/次数由前端 reducer 补）。 */
export function toIssueRecord(diagnosis, now = () => new Date().toISOString()) {
  if (!diagnosis || typeof diagnosis !== 'object' || !diagnosis.code) throw Object.assign(new Error('诊断结果不完整'), { code: 'FAILURE_DIAGNOSIS_INVALID' });
  const timestamp = now();
  return {
    fingerprint: diagnosis.fingerprint,
    source: diagnosis.source,
    severity: diagnosis.severity,
    status: 'open',
    code: diagnosis.code,
    summary: diagnosis.summary,
    detail: diagnosis.detail,
    firstOccurredAt: timestamp,
    lastOccurredAt: timestamp,
    occurrences: 1,
    context: { ...diagnosis.context, ...(diagnosis.repair ? { repairPage: diagnosis.repair.page, repairLabel: diagnosis.repair.label } : {}) },
    suggestedAction: diagnosis.suggestedAction,
    handling: [],
  };
}
