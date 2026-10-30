import { useMemo, useRef, useState } from 'react';
import { Check, Download, FileCheck2, FileText, Link2, PackageCheck, RefreshCw, Search, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useApp } from '../state/AppContext';
import type { ComponentItem, EasyEdaDeviceSearchItem, FileAsset, ProductionInspection, ProductionReadiness, SemanticPlanResult } from '../types';
import { downloadDemoFile } from '../services/demoAdapter';
import { Badge, Button, Field, Panel, SegmentedTabs, Stat, TableFrame, Toggle } from '../components/ui';
import { ConfirmDialog, Drawer, Modal } from '../components/overlays';
import { runtimeClient, RuntimeApiError } from '../services/runtimeClient';
import { readSemanticPlanDraft } from '../services/draftStore';
import { pickReadinessPcbExecution, saveReadinessInputs } from '../services/releaseBindingStore';

export function AssetsPage() {
  const { state, dispatch, notify, addAudit } = useApp();
  const [tab, setTab] = useState<'assets' | 'bom'>('assets');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [assetDetail, setAssetDetail] = useState<FileAsset | null>(null);
  const [componentDetail, setComponentDetail] = useState<ComponentItem | null>(null);
  const [removeTarget, setRemoveTarget] = useState<FileAsset | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [productionInspection, setProductionInspection] = useState<ProductionInspection | null>(null);
  // 生产放行 readiness：本地门禁 + 落盘人工证据（DFM/终审）的服务端统一裁决，客户端不参与结论。
  const [readiness, setReadiness] = useState<ProductionReadiness | null>(null);
  const [readinessBusy, setReadinessBusy] = useState(false);
  const [inspectingProduction, setInspectingProduction] = useState(false);
  const [libraryTarget, setLibraryTarget] = useState<ComponentItem | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryMode, setLibraryMode] = useState<'keyword' | 'lcsc'>('keyword');
  const [libraryResults, setLibraryResults] = useState<EasyEdaDeviceSearchItem[]>([]);
  const [librarySearching, setLibrarySearching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const assets = useMemo(() => state.assets.filter((item) => `${item.name} ${item.type} ${item.version}`.toLowerCase().includes(query.toLowerCase()) && (status === 'all' || item.status === status)), [state.assets, query, status]);
  const projectComponents = useMemo(() => state.components.filter((item) => item.projectId === state.activeProjectId), [state.components, state.activeProjectId]);
  const components = useMemo(() => projectComponents.filter((item) => `${item.refdes} ${item.mpn} ${item.manufacturer} ${item.lcscId}`.toLowerCase().includes(query.toLowerCase()) && (status === 'all' || item.status === status)), [projectComponents, query, status]);

  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    const items: FileAsset[] = Array.from(files).map((file, index) => ({ id: `asset-${Date.now()}-${index}`, name: file.name, type: file.name.split('.').pop()?.toUpperCase() || 'FILE', size: `${Math.max(1, Math.round(file.size / 1024))} KB`, version: '新上传', status: 'parsed', authoritative: false, addedByUser: true, hash: `sha256: demo-${Date.now().toString(36)}-${index}`, linkedTo: [] }));
    dispatch({ type: 'ADD_ASSETS', assets: items }); addAudit('project', '上传项目资料', `${items.length} 个本地文件记录（Demo）`, 'success'); notify('上传记录已创建', `${items.length} 个文件已加入 Demo 资料库；文件内容未发送。`, 'success');
    if (fileRef.current) fileRef.current.value = '';
  };
  const updateAsset = (asset: FileAsset) => { dispatch({ type: 'UPDATE_ASSET', asset }); setAssetDetail(asset); addAudit('project', '更新资料属性', asset.name, 'success'); notify('资料已更新', `${asset.name} 的依据状态已保存。`, 'success'); };
  const approveAlternate = (item: ComponentItem) => { const updated = { ...item, alternateApproved: true, status: 'approved' as const }; dispatch({ type: 'UPDATE_COMPONENT', component: updated }); setComponentDetail(updated); addAudit('requirement', '批准替代料', `${item.refdes}: ${item.alternate}`, 'success'); notify('替代料已批准', `${item.refdes} 可使用 ${item.alternate}。`, 'success'); };
  const exportBom = () => { const csv = ['RefDes,MPN,Manufacturer,Package,LCSC,Qty,Status', ...projectComponents.map((item) => [item.refdes, item.mpn, item.manufacturer, item.package, item.lcscId, item.qty, item.status].join(','))].join('\n'); downloadDemoFile('CircuitPilot-DEMO-BOM.csv', csv, 'text/csv;charset=utf-8'); addAudit('project', '导出Demo BOM', 'CircuitPilot-DEMO-BOM.csv', 'warning'); notify('Demo 文件已生成', '导出内容带有 DEMO ONLY 标记，不可用于生产。', 'warning'); setExportOpen(false); };
  const inspectProduction = async () => {
    setInspectingProduction(true);
    try {
      const context = await runtimeClient.pcbContext();
      const project = context.project as { uuid?: string; friendlyName?: string } | null;
      const document = context.pcb?.document as { uuid?: string } | null;
      // P0-7：产物清单只绑定真实工程/文档/源摘要；semantic/compiled/execution 不再用 AI 任务 id 冒充，
      // 它们由 runReadiness 用服务端编译结果与真实 PCB 执行记录补进 binding。
      const inspection = await runtimeClient.inspectProductionArtifacts({ projectId: project?.uuid || '', projectName: project?.friendlyName || '', documentId: document?.uuid || '', sourceDigest: context.sourceDigest || '' });
      setProductionInspection(inspection);
      addAudit('validation', '校验真实生产资料包', `${inspection.manifest.files.length}个文件 · ${inspection.manifest.manifestHash.slice(0, 12)}`, inspection.readyForHumanReview ? 'success' : 'warning');
      notify('生产资料检查完成', inspection.readyForHumanReview ? '文件和版本绑定完整，等待在线DFM与人工终审。' : `仍有${inspection.blockers.length}项阻断。`, inspection.readyForHumanReview ? 'success' : 'warning');
    } catch (error) { notify('生产资料检查失败', error instanceof Error ? error.message : 'Runtime不可用', 'danger'); }
    finally { setInspectingProduction(false); }
  };

  /**
   * P0-7：readiness 的输入必须是真实可复核的引用。
   * - semantic/compiled 计划哈希：服务端现场编译同一份语义计划后返回（不再拿 task.planHash 兼任两者）；
   * - pcbExecutionId：真实 PCB 执行历史里 completed 且官方 DRC 通过的那条（不再拿 AI 任务 id）；
   * - manifestHash：统一产物根（deliverables/）算出的清单哈希，经 sessionStorage 交给签核与正式导出。
   * 任一缺失都给出精确错误码与补救路径，不降级成"用差不多的值凑一凑"。
   */
  const runReadiness = async () => {
    if (!productionInspection) return notify('请先检查生产资料', 'readiness 需要先绑定项目/文档/清单，先点“检查生产资料”。', 'warning');
    const draft = readSemanticPlanDraft();
    if (!draft?.plan) {
      notify('缺少已生成的语义计划', '[PRODUCTION_PLAN_MISSING] 先在 AI 任务页生成可验证 PCBA 语义计划并“进入 EDA 编译与审批”；readiness 不接受 AI 任务 id 当计划哈希。', 'danger');
      addAudit('validation', 'readiness 输入缺失', 'PRODUCTION_PLAN_MISSING：没有可编译的语义计划草稿', 'error');
      return;
    }
    setReadinessBusy(true);
    try {
      // 1) 现场登记 + 编译：拿服务端认可的 semanticPlanHash / compiledPlanHash。
      let planning: SemanticPlanResult;
      try {
        planning = await runtimeClient.compileProductionPlan(draft.plan);
      } catch (error) {
        const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : 'Runtime 不可用';
        notify('语义计划编译失败', `[PRODUCTION_PLAN_COMPILE_FAILED] ${detail}`, 'danger');
        addAudit('validation', 'readiness 语义计划编译失败', detail, 'error');
        return;
      }
      if (!planning.compiled || !planning.compiledPlanHash) {
        const blockers = [...(planning.blocking || []).map((item) => `${item.code}: ${item.message}`), ...(planning.issues || []).map((item) => `${item.code}: ${item.message}`)].slice(0, 5).join('；');
        notify('语义计划编译被阻断', `[PRODUCTION_PLAN_COMPILE_BLOCKED] ${blockers || '计划未通过固定 Schema 校验'}。先在 EDA 页修正计划并重新编译。`, 'danger');
        addAudit('validation', 'readiness 语义计划编译被阻断', blockers || 'compiledPlanHash 缺失', 'error');
        return;
      }
      // 2) 真实 PCB 执行记录（completed + 官方 DRC 通过）。
      const history = await runtimeClient.pcbExecutions();
      const picked = pickReadinessPcbExecution(history.executions || []);
      if ('error' in picked) {
        notify('readiness 输入不完整', `[PRODUCTION_PCB_EXECUTION_MISSING] ${picked.error}`, 'danger');
        addAudit('validation', 'readiness 输入缺失', picked.error, 'error');
        return;
      }
      // 3) binding 只用真实值：工程/文档/源摘要来自“检查生产资料”，计划与执行来自第 1、2 步。
      const manifest = productionInspection.manifest;
      const binding = {
        projectId: manifest.projectId,
        projectName: manifest.projectName || '',
        documentId: manifest.documentId,
        sourceDigest: manifest.sourceDigest || '',
        semanticPlanHash: planning.planHash,
        compiledPlanHash: planning.compiledPlanHash,
        executionId: picked.execution.id,
      };
      const result = await runtimeClient.productionReadiness({
        semanticPlanHash: planning.planHash,
        compiledPlanHash: planning.compiledPlanHash,
        pcbExecutionId: picked.execution.id,
        binding,
      });
      setReadiness(result);
      saveReadinessInputs({ semanticPlanHash: planning.planHash, compiledPlanHash: planning.compiledPlanHash, pcbExecutionId: picked.execution.id, executionState: picked.execution.state, drcPassed: true });
      // 交接：签核与正式导出必须用同一 binding 重算 manifestHash（P0-6）。
      try {
        sessionStorage.setItem('circuitpilot:release-binding', JSON.stringify({ manifestHash: result.referenced?.manifestHash ?? null, binding, savedAt: new Date().toISOString() }));
      } catch { /* 存储不可用不阻塞 readiness */ }
      addAudit('validation', '生产放行readiness复核', `${result.ready ? 'ready' : 'blocked'} · ${result.reason.slice(0, 80)}`, result.ready ? 'success' : 'warning');
      notify(result.ready ? '生产放行就绪（不含下单）' : '生产放行仍被阻断', result.reason, result.ready ? 'success' : 'warning');
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : 'Runtime 不可用';
      // 精确错误码：PRODUCTION_PLAN_UNKNOWN / PRODUCTION_EXECUTION_UNKNOWN / PRODUCTION_COMPILED_PLAN_MISMATCH ...
      notify('readiness 复核失败', `${detail}；本次结论未落库，不会把旧结论当新证据。`, 'danger');
      addAudit('validation', 'readiness 复核失败', detail, 'error');
    } finally { setReadinessBusy(false); }
  };

  const openLibrarySearch = (item: ComponentItem) => {
    setLibraryTarget(item);
    setLibraryQuery(item.lcscId || item.mpn);
    setLibraryMode(item.lcscId ? 'lcsc' : 'keyword');
    setLibraryResults([]);
  };
  const searchLibrary = async () => {
    if (!libraryQuery.trim()) return;
    setLibrarySearching(true);
    try {
      const result = await runtimeClient.searchEasyEdaDevices(libraryQuery.trim(), libraryMode);
      setLibraryResults(result.candidates);
      addAudit('eda', '搜索嘉立创EDA器件库', `${result.query} · ${result.candidates.length}个候选`, 'info');
      notify('器件库搜索完成', `找到 ${result.candidates.length} 个候选，绑定前请核对符号和封装。`, result.candidates.length ? 'success' : 'warning');
    } catch (error) { notify('嘉立创EDA搜索失败', error instanceof Error ? error.message : '未知错误', 'danger'); }
    finally { setLibrarySearching(false); }
  };
  const bindLibraryDevice = (candidate: EasyEdaDeviceSearchItem) => {
    if (!libraryTarget) return;
    const updated: ComponentItem = { ...libraryTarget, easyEdaBinding: { name: candidate.name, uuid: candidate.uuid, libraryUuid: candidate.libraryUuid, symbol: candidate.symbol, footprint: candidate.footprint, model3D: candidate.model3D, boundAt: new Date().toLocaleString('zh-CN', { hour12: false }) } };
    dispatch({ type: 'UPDATE_COMPONENT', component: updated });
    addAudit('project', '绑定嘉立创EDA器件身份', `${updated.refdes} · ${candidate.name} · ${candidate.uuid}`, 'success');
    notify('器件身份已绑定', `${updated.refdes} 已关联 ${candidate.name}；未修改原理图。`, 'success');
    setLibraryTarget(null); setLibraryResults([]);
  };
  const linkAssetToEdaProject = async (asset: FileAsset) => {
    try {
      const command = await runtimeClient.executeCommand('project.current');
      const project = command.result as { uuid?: string; friendlyName?: string; name?: string } | null;
      const label = `嘉立创EDA项目：${project?.friendlyName || project?.name || project?.uuid || '当前项目'}`;
      updateAsset({ ...asset, linkedTo: Array.from(new Set([...asset.linkedTo, label])) });
      addAudit('eda', '关联资料与嘉立创EDA项目', `${asset.name} → ${label}`, 'success');
      notify('资料关联已保存', '仅保存本地关联，未上传文件到嘉立创EDA。', 'success');
    } catch (error) { notify('关联失败', error instanceof Error ? error.message : '无法读取当前EDA项目', 'danger'); }
  };

  return (
    <>
      <div className="stats-grid stats-grid--4"><Stat label="资料文件" value={state.assets.length} hint={`${state.assets.filter((item) => item.authoritative).length} 份正式依据`} /><Stat label="BOM 行数" value={state.components.length} hint={`${state.components.reduce((sum, item) => sum + item.qty, 0)} 个元件`} /><Stat label="采购风险" value={state.components.filter((item) => item.status === 'risk').length} hint="库存或替代料风险" tone="warning" /><Stat label="待审批" value={state.components.filter((item) => item.status === 'pending').length} hint="约束冲突待处理" tone="danger" /></div>
      <Panel eyebrow="PROJECT EVIDENCE" title="资料库与元件清单" actions={<>{tab === 'assets' ? <Button variant="primary" icon={<Upload size={15} />} onClick={() => fileRef.current?.click()}>上传资料</Button> : <Button variant="primary" icon={<Download size={15} />} onClick={() => state.settings.confirmExport ? setExportOpen(true) : exportBom()}>导出 Demo CSV</Button>}<input ref={fileRef} className="visually-hidden" type="file" multiple onChange={(e) => upload(e.target.files)} aria-label="选择项目资料文件" /></>}>
        <div className="toolbar toolbar--wrap"><SegmentedTabs label="资料类型" value={tab} onChange={(value) => { setTab(value as 'assets' | 'bom'); setStatus('all'); setQuery(''); }} items={[{ value: 'assets', label: '资料文件', count: state.assets.length }, { value: 'bom', label: 'BOM 清单', count: state.components.length }]} /><div className="toolbar__spacer" /><label className="search-box"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tab === 'assets' ? '搜索文件名、类型、版本' : '搜索位号、型号、厂商、LCSC'} aria-label="搜索资料或BOM" /></label><select className="compact-select compact-select--plain" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="筛选状态">{tab === 'assets' ? <><option value="all">全部状态</option><option value="official">正式资料</option><option value="parsed">已解析</option><option value="warning">需复核</option></> : <><option value="all">全部状态</option><option value="approved">已批准</option><option value="risk">有风险</option><option value="pending">待审批</option></>}</select></div>

        {tab === 'assets' ? <div className="asset-grid">{assets.map((asset) => <article className="asset-card" key={asset.id}><button type="button" className="asset-card__main" onClick={() => setAssetDetail(asset)}><div className="asset-icon"><FileText size={21} /></div><div><div className="asset-title"><strong>{asset.name}</strong>{asset.authoritative && <ShieldCheck size={15} aria-label="正式依据" />}</div><small>{asset.type} · {asset.size} · {asset.version}</small></div></button><div className="asset-card__bottom"><Badge tone={asset.status === 'official' ? 'success' : asset.status === 'warning' ? 'warning' : 'info'}>{asset.status === 'official' ? '正式资料' : asset.status === 'warning' ? '需复核' : '已解析'}</Badge><span>{asset.linkedTo.length} 个关联</span><Button size="sm" variant="ghost" onClick={() => setAssetDetail(asset)}>详情</Button></div></article>)}</div> : <TableFrame label="BOM元件清单"><table><thead><tr><th>位号 / 数量</th><th>型号</th><th>厂商 / 封装</th><th>LCSC</th><th>嘉立创EDA身份</th><th>风险与替代料</th><th className="table-actions">操作</th></tr></thead><tbody>{components.map((item) => <tr key={item.id}><td><strong>{item.refdes}</strong><small>数量 {item.qty}</small></td><td><strong>{item.mpn}</strong><small>{item.value}</small></td><td>{item.manufacturer}<small>{item.package}</small></td><td><code>{item.lcscId}</code></td><td>{item.easyEdaBinding ? <><Badge tone="success">已绑定</Badge><small>{item.easyEdaBinding.name}</small></> : <Badge tone="neutral">未绑定</Badge>}</td><td><Badge tone={item.status === 'approved' ? 'success' : item.status === 'risk' ? 'danger' : 'warning'}>{item.status === 'approved' ? '已批准' : item.status === 'risk' ? '采购风险' : '待审批'}</Badge>{item.alternate && <small>替代：{item.alternate}{item.alternateApproved ? ' · 已批准' : ''}</small>}</td><td className="row-actions"><Button size="sm" onClick={() => setComponentDetail(item)}>详情</Button><Button size="sm" variant="primary" icon={<Search size={13} />} onClick={() => openLibrarySearch(item)}>嘉立创EDA搜索</Button>{item.alternate && !item.alternateApproved && <Button size="sm" icon={<Check size={13} />} onClick={() => approveAlternate(item)}>批准替代</Button>}</td></tr>)}</tbody></table></TableFrame>}
      </Panel>

      <Panel eyebrow="IMMUTABLE PRODUCTION PACKAGE" title="真实生产资料与不可变清单" meta="读取 manufacturing 目录；不自动下单或支付" actions={<Button variant="primary" icon={inspectingProduction ? <RefreshCw className="spin" size={15} /> : <FileCheck2 size={15} />} onClick={inspectProduction} disabled={inspectingProduction}>{inspectingProduction ? '检查中' : '检查生产资料'}</Button>}>
        {!productionInspection ? <div className="empty-inline"><ShieldCheck size={25} /><strong>尚未执行生产资料校验</strong><span>检查会计算每个文件的SHA-256，校验BOM/CPL字段、位号及Gerber层集，并绑定当前真实PCB。</span></div> : <div className="detail-stack">
          <div className={`inline-alert ${productionInspection.readyForHumanReview ? 'inline-alert--success' : 'inline-alert--warning'}`}><ShieldCheck size={16} /><span><strong>{productionInspection.readyForHumanReview ? '本地资料校验通过' : '生产资料仍被阻断'}</strong> · 在线DFM和最终人工终审始终独立执行。</span></div>
          <div className="stats-grid stats-grid--4"><Stat label="文件" value={productionInspection.manifest.files.length} hint="已计算SHA-256" /><Stat label="BOM位号" value={productionInspection.manifest.contentValidation.bomRefCount} hint="解析正式导出" /><Stat label="CPL贴片位号" value={productionInspection.manifest.contentValidation.cplRefCount} hint="已核对BOM集合" /><Stat label="生产放行" value={readiness ? readiness.ready ? 'ready' : 'blocked' : '未复核'} hint={readiness ? readiness.reason.slice(0, 30) : '运行一次 readiness 统一裁决'} tone={readiness ? readiness.ready ? 'success' : 'danger' : 'warning'} /></div>
          <div className="detail-block"><span>不可变清单哈希</span><code>{productionInspection.manifest.manifestHash}</code></div>
          <div className="detail-block"><span>嘉立创在线DFM交接</span><p>{productionInspection.manifest.dfm.reason}</p><div className="chip-list">{productionInspection.manifest.dfm.uploadFiles.map((file) => <span key={file}>{file}</span>)}</div><a className="button button--primary button--sm" href={productionInspection.manifest.dfm.portalUrl} target="_blank" rel="noreferrer">打开嘉立创DFM官网</a></div>
          <TableFrame label="生产资料文件哈希"><table><thead><tr><th>文件</th><th>类型</th><th>大小</th><th>SHA-256</th></tr></thead><tbody>{productionInspection.manifest.files.map((file) => <tr key={file.name}><td><strong>{file.name}</strong></td><td><Badge tone="info">{file.kind}</Badge></td><td>{file.size} B</td><td><code>{file.sha256}</code></td></tr>)}</tbody></table></TableFrame>
          {!!productionInspection.blockers.length && <div className="risk-box"><strong>尚未通过的生产门禁</strong>{productionInspection.blockers.map((blocker) => <p key={blocker}>• {blocker}</p>)}</div>}
        </div>}
      </Panel>

      <Panel
        eyebrow="PRODUCTION READINESS"
        title="生产放行统一裁决（本地门禁 + 人工证据）"
        meta="服务端重算：本地检查 + 在线 DFM + 终审签核；客户端提交不被信任"
        actions={<Button variant="primary" icon={<ShieldCheck size={15} />} loading={readinessBusy} disabled={readinessBusy || !productionInspection} title={!productionInspection ? '请先检查生产资料' : '由服务端重算所有门禁'} onClick={() => void runReadiness()}>运行 readiness 复核</Button>}
      >
        {!productionInspection ? <div className="empty-inline"><ShieldCheck size={24} /><strong>尚未绑定生产资料</strong><span>先“检查生产资料”得到 manifest（项目/文档/计划/执行/清单绑定），再做统一裁决。</span></div> : !readiness ? <div className="empty-inline"><ShieldCheck size={24} /><strong>尚未运行 readiness</strong><span>它会同时检查本地文件门禁、在线 DFM 证据、终审签核证据；缺任何一项都会明确 blocked。</span></div> : (
          <div className="detail-stack">
            <div className={`inline-alert ${readiness.ready ? 'inline-alert--success' : 'inline-alert--warning'}`}><ShieldCheck size={16} /><span><strong>{readiness.ready ? '生产放行就绪（仅文件与签核）' : '生产放行被阻断'}</strong> · {readiness.reason}</span></div>
            <div className="row-actions"><Badge tone={readiness.ready ? 'success' : 'danger'}>{readiness.ready ? 'ready' : 'blocked'}</Badge><span>下单能力：<strong>{readiness.orderEnabled ? '启用' : '永久禁用'}</strong></span>{readiness.referenced ? <><span>清单 <code>{readiness.referenced.manifestHash?.slice(0, 12) || '—'}</code></span><span>终审 <code>{readiness.referenced.reviewHash?.slice(0, 12) || '未签核'}</code></span></> : null}</div>
            <TableFrame label="门禁明细（服务端重算，不接受客户端结论）">
              <table>
                <thead><tr><th>门禁</th><th>结论</th><th>证据来源</th><th>原因</th></tr></thead>
                <tbody>
                  {readiness.gates.map((gate) => (
                    <tr key={gate.id}>
                      <td><code>{gate.id}</code></td>
                      <td><Badge tone={gate.passed ? 'success' : 'danger'}>{gate.passed ? '通过' : '阻断'}</Badge></td>
                      <td>{gate.source}</td>
                      <td>{gate.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
            {!readiness.ready ? <div className="inline-alert inline-alert--warning"><ShieldCheck size={16} /><span>缺口补齐路径：在线 DFM 到验证页登记；终审由三方签核（硬件/工艺/负责人）落盘；文件门禁到“检查生产资料”修文件。系统<b>不会</b>自动下单或支付。</span></div> : null}
          </div>
        )}
      </Panel>

      <Drawer open={Boolean(assetDetail)} onClose={() => setAssetDetail(null)} title={assetDetail?.name || '资料详情'} eyebrow="EVIDENCE INSPECTOR" footer={<>{assetDetail?.addedByUser && <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setRemoveTarget(assetDetail)}>移除记录</Button>}<Button icon={<Link2 size={15} />} onClick={() => assetDetail && void linkAssetToEdaProject(assetDetail)}>关联当前嘉立创EDA项目</Button><Button icon={<Link2 size={15} />} onClick={() => { if (assetDetail) updateAsset({ ...assetDetail, linkedTo: Array.from(new Set([...assetDetail.linkedTo, `AI任务 ${state.task.id}`])) }); }}>关联当前AI任务</Button><Button variant="primary" onClick={() => assetDetail && updateAsset({ ...assetDetail, authoritative: !assetDetail.authoritative, status: !assetDetail.authoritative ? 'official' : 'parsed' })}>{assetDetail?.authoritative ? '取消正式依据' : '设为正式依据'}</Button></>}>
        {assetDetail && <div className="detail-stack"><div className="demo-banner">Demo 仅保存文件元数据，不上传或解析真实文件内容。</div><div className="detail-block"><span>文件信息</span><strong>{assetDetail.type} · {assetDetail.size} · {assetDetail.version}</strong></div><div className="detail-block"><span>内容哈希</span><code>{assetDetail.hash}</code></div><div className="detail-block"><span>证据关联</span><div className="chip-list">{assetDetail.linkedTo.length ? assetDetail.linkedTo.map((item) => <span key={item}><Link2 size={12} />{item}</span>) : <small>尚未建立关联</small>}</div></div><Toggle checked={assetDetail.authoritative} onChange={(checked) => updateAsset({ ...assetDetail, authoritative: checked, status: checked ? 'official' : 'parsed' })} label="作为正式设计依据" description="AI计划优先引用正式依据，并记录到证据链。" /></div>}
      </Drawer>

      <Drawer open={Boolean(componentDetail)} onClose={() => setComponentDetail(null)} title={componentDetail ? `${componentDetail.refdes} · ${componentDetail.mpn}` : '元件详情'} eyebrow="BOM INSPECTOR" footer={<>{componentDetail?.alternate && !componentDetail.alternateApproved && <Button variant="primary" icon={<PackageCheck size={15} />} onClick={() => approveAlternate(componentDetail)}>批准替代料</Button>}<Button onClick={() => setComponentDetail(null)}>关闭</Button></>}>
        {componentDetail && <div className="detail-stack"><div className="detail-block"><span>制造商</span><strong>{componentDetail.manufacturer}</strong></div><div className="detail-block"><span>封装 / 参数</span><strong>{componentDetail.package} · {componentDetail.value}</strong></div><div className="detail-block"><span>立创商城编号</span><code>{componentDetail.lcscId}</code></div>{componentDetail.risk && <div className="risk-box"><strong>工程风险</strong><p>{componentDetail.risk}</p></div>}{componentDetail.alternate && <div className="detail-block"><span>候选替代料</span><strong>{componentDetail.alternate}</strong><Badge tone={componentDetail.alternateApproved ? 'success' : 'warning'}>{componentDetail.alternateApproved ? '已批准' : '待人工批准'}</Badge></div>}</div>}
      </Drawer>
      <Modal open={Boolean(libraryTarget)} onClose={() => setLibraryTarget(null)} title={`在嘉立创EDA搜索 · ${libraryTarget?.refdes || ''}`} eyebrow="EASYEDA DEVICE LIBRARY · BETA" width="820px">
        <div className="library-search"><div className="inline-alert inline-alert--warning"><ShieldCheck size={16} /><span>只读搜索官方Beta器件库。“确认绑定”只保存CircuitPilot身份信息，不会放置器件或修改嘉立创EDA。</span></div><div className="library-search__controls"><SegmentedTabs label="搜索方式" value={libraryMode} onChange={(value) => setLibraryMode(value as 'keyword' | 'lcsc')} items={[{ value: 'keyword', label: '型号 / 关键词' }, { value: 'lcsc', label: '立创 C 编号' }]} /><label className="search-box"><Search size={15} /><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void searchLibrary(); }} placeholder={libraryMode === 'lcsc' ? '例如：C190794' : '例如：nRF52840-QIAA'} aria-label="嘉立创EDA器件搜索词" /></label><Button variant="primary" icon={<Search size={14} />} loading={librarySearching} disabled={!libraryQuery.trim() || librarySearching} onClick={() => void searchLibrary()}>搜索器件库</Button></div>{!libraryResults.length ? <div className="empty-inline"><Search size={24} /><strong>尚未获取候选器件</strong><span>优先使用立创C编号精确匹配；绑定前请核对符号、封装和3D模型。</span></div> : <div className="library-results">{libraryResults.map((candidate) => <article key={`${candidate.libraryUuid}-${candidate.uuid}`}><header><div><strong>{candidate.name}</strong><small>{candidate.description || '无描述'}</small></div><Badge tone="warning">BETA</Badge></header><div className="library-result__evidence"><span>器件<code>{candidate.uuid}</code></span><span>符号<strong>{candidate.symbol?.name || '缺失'}</strong></span><span>封装<strong>{candidate.footprint?.name || '缺失'}</strong></span><span>3D<strong>{candidate.model3D?.name || '未关联'}</strong></span></div><footer><code>{candidate.libraryUuid}</code><Button size="sm" variant="primary" icon={<Link2 size={13} />} onClick={() => bindLibraryDevice(candidate)}>确认绑定</Button></footer></article>)}</div>}</div>
      </Modal>
      <ConfirmDialog open={Boolean(removeTarget)} onClose={() => setRemoveTarget(null)} onConfirm={() => { if (removeTarget) { dispatch({ type: 'REMOVE_ASSET', id: removeTarget.id }); addAudit('project', '移除上传资料记录', removeTarget.name, 'warning'); notify('记录已移除', `${removeTarget.name} 已从 Demo 资料库移除。`, 'warning'); setAssetDetail(null); } }} title="移除这条资料记录？" description="仅移除 Demo 中的元数据记录，不会删除你电脑上的原始文件。" confirmLabel="确认移除" danger />
      <Modal open={exportOpen} onClose={() => setExportOpen(false)} title="导出 Demo BOM？" eyebrow="DEMO EXPORT" footer={<><Button onClick={() => setExportOpen(false)}>取消</Button><Button variant="primary" icon={<Download size={15} />} onClick={exportBom}>下载带标记的 CSV</Button></>}><div className="dialog-copy"><p>导出文件将包含当前 Demo BOM 数据和明确的 <strong>DEMO ONLY</strong> 标记。</p><p>它不能作为采购、生产或嘉立创EDA正式导入文件。</p></div></Modal>
    </>
  );
}
