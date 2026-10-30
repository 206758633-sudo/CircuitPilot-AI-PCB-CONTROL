import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, FileCode2, Hash, Play, Search, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { runtimeClient, RuntimeApiError } from '../services/runtimeClient';
import type { LayoutRuleAudit, LayoutRuleLevel, LayoutRulePackSummary, LayoutRuleStatus } from '../types';
import { Badge, Button, Panel, SegmentedTabs, Stat, TableFrame } from '../components/ui';

/**
 * 规则中心：把 docs/pcb-layout 的 151 条 PCBA 布局规则变成可执行审计。
 *
 * 界面纪律（与 LayoutRuleAudit 的语义一一对应）：
 *   1. REVIEW 显示为"待复核"，绝不是"通过"——缺 Gerber/网表/3D 证据就不许放行；
 *   2. "可放行"只由全部门禁决定（GATE-01..10），且门禁必须带外部签字证据；
 *   3. 每条 FAIL 都展示判定依据与证据，方便直接改图，而不是只给一个红点。
 */
const toneOf = (status: LayoutRuleStatus) => status === 'PASS' ? 'success' : status === 'FAIL' ? 'danger' : status === 'REVIEW' ? 'warning' : 'neutral';
const labelOf = (status: LayoutRuleStatus) => ({ PASS: '通过', FAIL: '不通过', REVIEW: '待复核', NA: '不适用' })[status];
const levelTone = (level: LayoutRuleLevel) => level === '硬门禁' ? 'danger' : 'info';

export function RuleCenterPage() {
  const { notify, addAudit, reportIssue } = useApp();
  const [pack, setPack] = useState<LayoutRulePackSummary | null>(null);
  const [fixtures, setFixtures] = useState<string[]>([]);
  const [audit, setAudit] = useState<LayoutRuleAudit | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'ALL' | LayoutRuleStatus>('FAIL');
  const [groupFilter, setGroupFilter] = useState('ALL');
  const [query, setQuery] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [customJson, setCustomJson] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fail = (caught: unknown, action: string) => {
    const detail = caught instanceof RuntimeApiError ? `[${caught.code}] ${caught.message}` : caught instanceof Error ? caught.message : '未知错误';
    setError(detail);
    reportIssue({ fingerprint: `layout-rules:${action}`, source: 'validation', severity: 'error', status: 'open', code: caught instanceof RuntimeApiError ? caught.code : 'LAYOUT_RULE_AUDIT_FAILED', summary: `布局规则${action}失败`, detail, suggestedAction: '确认本机Runtime已启动（npm run dev:full）后重试。界面不会把失败伪装成通过。' });
    notify(`布局规则${action}失败`, detail, 'danger');
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await runtimeClient.layoutRulePack();
        if (cancelled) return;
        setPack(loaded.pack);
        setFixtures(loaded.fixtures);
        addAudit('validation', '加载 PCBA 布局规则包', `${loaded.pack.total} 条 · ${loaded.pack.documents?.rulesA ? '规则出处已绑定' : '规则出处缺失'} · ${loaded.pack.hash.slice(0, 12)}`, 'info');
      } catch (caught) {
        if (!cancelled) fail(caught, '规则包加载');
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runFixture = async (fixtureId: string) => {
    setBusy(fixtureId); setError(null);
    try {
      const result = await runtimeClient.auditLayoutRules({ fixtureId });
      setAudit(result);
      addAudit('validation', `审计布局规则样板 ${fixtureId}`, `${result.summary.blockingFailures} 项阻断 · ${result.summary.REVIEW} 项待复核 · ${result.auditHash.slice(0, 12)}`, result.passed ? 'success' : 'warning');
      notify('布局规则审计完成', `${fixtureId}：${result.summary.FAIL} 条不通过（阻断 ${result.summary.blockingFailures}）、${result.summary.REVIEW} 条待复核；${result.releaseReady ? '门禁可放行' : '不可放行'}。`, result.releaseReady ? 'success' : 'warning');
    } catch (caught) { fail(caught, '样板审计'); } finally { setBusy(null); }
  };

  const runCustom = async () => {
    let input: unknown;
    try { input = JSON.parse(customJson); } catch (caught) { setError(`JSON 解析失败：${(caught as Error).message}`); return; }
    setBusy('custom'); setError(null);
    try {
      const result = await runtimeClient.auditLayoutRules({ input });
      setAudit(result);
      setCustomOpen(false);
      addAudit('validation', '审计自定义布局输入', `${result.summary.blockingFailures} 项阻断 · ${result.auditHash.slice(0, 12)}`, result.passed ? 'success' : 'warning');
      notify('布局规则审计完成', `自定义输入：${result.summary.FAIL} 条不通过、${result.summary.REVIEW} 条待复核。`, result.passed ? 'success' : 'warning');
    } catch (caught) { fail(caught, '自定义审计'); } finally { setBusy(null); }
  };

  const rows = useMemo(() => {
    if (!audit) return [];
    const keyword = query.trim().toLowerCase();
    return audit.rules.filter((rule) => {
      if (statusFilter !== 'ALL' && rule.status !== statusFilter) return false;
      if (groupFilter !== 'ALL' && rule.group !== groupFilter) return false;
      if (!keyword) return true;
      return `${rule.id} ${rule.name} ${rule.message}`.toLowerCase().includes(keyword);
    });
  }, [audit, statusFilter, groupFilter, query]);

  const findings = useMemo(() => {
    if (!audit) return [];
    return [...audit.findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocking' ? -1 : 1));
  }, [audit]);

  return (
    <>
      <Panel
        eyebrow="PCBA LAYOUT RULE PACK"
        title="规则中心"
        meta="docs/pcb-layout 151 条可执行规则 · 判定结果带证据与哈希"
        actions={(
          <div className="row-actions">
            <Button icon={<FileCode2 size={15} />} onClick={() => setCustomOpen((value) => !value)}>自定义输入</Button>
            {fixtures.map((fixtureId) => (
              <Button key={fixtureId} variant={fixtureId === 'ESP32-TEST-BOARD' ? 'primary' : 'secondary'} icon={<Play size={15} />} loading={busy === fixtureId} disabled={Boolean(busy)} onClick={() => void runFixture(fixtureId)}>
                {fixtureId === 'ESP32-TEST-BOARD' ? '审计现状板' : '审计整改骨架'}
              </Button>
            ))}
          </div>
        )}
      >
        {pack ? (
          <>
            <div className="stats-grid stats-grid--4">
              <Stat label="规则总数" value={pack.total} hint={`规则包 v${pack.version}`} tone="info" />
              <Stat label="硬门禁" value={pack.levels['硬门禁'] ?? 0} hint="未清零不得投板" tone="danger" />
              <Stat label="推荐项" value={pack.levels['推荐'] ?? 0} hint="不达标记警告并留痕" tone="warning" />
              <Stat label="规则分组" value={pack.groups.length} hint={pack.groups.map((group) => group.id).join(' / ')} tone="neutral" />
            </div>
            <div className="inline-alert inline-alert--warning">
              <AlertTriangle size={16} />
              <span>规则数值只来自规则包（<code>{pack.policy.valueSource}</code>），代码不另抄常量；<strong>REVIEW 不是 PASS</strong>——缺 Gerber、网表、叠层或 3D 高度的规则一律待复核。规则包 SHA-256：<code>{pack.hash.slice(0, 16)}…</code></span>
            </div>
            <div className="toolbar toolbar--wrap">
              {pack.groups.map((group) => (
                <span key={group.id} className="pill pill--neutral" title={group.name}>{group.id} {group.count}</span>
              ))}
              <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11.5 }}>
                {pack.documents?.rulesA ? '规则出处：02/03 号设计规则文档' : '未绑定文档出处'} · 诊断 {pack.documents?.diagnosis ? '已绑定' : '缺失'}
              </span>
            </div>
          </>
        ) : <div className="empty-inline"><CircleDashed size={25} /><strong>正在读取规则包</strong><span>连接本机 Runtime 后加载 128 条规则元信息。</span></div>}
        {error && <div className="inline-alert inline-alert--danger"><XCircle size={16} /><span>{error}</span></div>}
        {customOpen && (
          <div className="detail-stack">
            <div className="inline-alert inline-alert--info"><Hash size={16} /><span>粘贴布局输入（board / components / rf / silk / power / evidence）。缺字段会如实变成 REVIEW，不会蒙混过关。</span></div>
            <textarea className="input textarea textarea--large" value={customJson} onChange={(event) => setCustomJson(event.target.value)} placeholder={'{\n  "board": { "widthMm": 70, "heightMm": 48 },\n  "components": [ … ]\n}'} aria-label="自定义布局输入JSON" />
            <div className="row-actions"><Button variant="primary" icon={<Play size={15} />} loading={busy === 'custom'} disabled={!customJson.trim() || Boolean(busy)} onClick={() => void runCustom()}>运行审计</Button><Button onClick={() => setCustomJson('')}>清空</Button></div>
          </div>
        )}
      </Panel>

      {audit && (
        <>
          <Panel
            eyebrow="AUDIT VERDICT"
            title="审计结论"
            meta={`规则包 ${audit.packVersion} · ${audit.auditHash.slice(0, 16)}…`}
            actions={<Badge tone={audit.releaseReady ? 'success' : audit.passed ? 'warning' : 'danger'}>{audit.releaseReady ? '门禁可放行' : audit.passed ? '规则已清零·门禁未闭' : '存在阻断项'}</Badge>}
          >
            <div className="stats-grid stats-grid--4">
              <Stat label="通过" value={audit.summary.PASS} hint="本引擎已用数据验证" tone="success" />
              <Stat label="不通过" value={audit.summary.FAIL} hint={`阻断 ${audit.summary.blockingFailures} · 警告 ${audit.summary.warningFailures}`} tone="danger" />
              <Stat label="待复核" value={audit.summary.REVIEW} hint={`${audit.uncoveredReviews} 项无门禁覆盖`} tone="warning" />
              <Stat label="不适用" value={audit.summary.NA} hint="本板无对应工艺/器件" tone="neutral" />
            </div>
            <div className={`inline-alert inline-alert--${audit.releaseReady ? 'success' : 'warning'}`}>
              {audit.releaseReady ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
              <span>{audit.releaseReady
                ? `${audit.gates.length} 道门禁全部通过：可以进入官方 DRC / 在线 DFM / 首件 FAI 的签字流程。`
                : `尚不可投板：${audit.summary.blockingFailures} 条硬门禁不通过${audit.summary.blockingFailures ? `（${audit.findings.filter((item) => item.severity === 'blocking').slice(0, 5).map((item) => item.code.replace('LAYOUT_RULE_', '').replace('_', '-')).join('、')}${audit.summary.blockingFailures > 5 ? ' …' : ''}）` : ''}；${audit.summary.REVIEW} 条规则因缺少证据仍待复核。`}</span>
            </div>
            <div className="stats-grid stats-grid--4">
              {audit.gates.map((gate) => (
                <div className="finding-detail" key={gate.id}>
                  <div className="finding-detail__head"><Badge tone={toneOf(gate.status)}>{labelOf(gate.status)}</Badge><code>{gate.id}</code></div>
                  <h3>{gate.message}</h3>
                </div>
              ))}
            </div>
            <TableFrame label="不可投产红线">
              <table>
                <thead><tr><th>红线</th><th>状态</th></tr></thead>
                <tbody>
                  {audit.redLines.map((line) => (
                    <tr key={line.key}>
                      <td><strong>{line.key}</strong></td>
                      <td><Badge tone={line.hit === true ? 'danger' : line.hit === false ? 'success' : 'warning'}>{line.hit === true ? '命中' : line.hit === false ? '已清' : '未验证'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
            <div className="inline-alert inline-alert--info"><AlertTriangle size={16} /><span>{audit.policy}</span></div>
          </Panel>

          <Panel eyebrow="FAILED & AWAITING REVIEW" title="阻断项与待复核规则" meta={`${audit.summary.FAIL} 条不通过 · ${audit.summary.REVIEW} 条待复核`}>
            <div className="toolbar toolbar--wrap">
              <SegmentedTabs label="判定状态" value={statusFilter} onChange={(value) => setStatusFilter(value as 'ALL' | LayoutRuleStatus)} items={[{ value: 'ALL', label: '全部' }, { value: 'FAIL', label: '不通过', count: audit.summary.FAIL }, { value: 'REVIEW', label: '待复核', count: audit.summary.REVIEW }, { value: 'PASS', label: '通过', count: audit.summary.PASS }, { value: 'NA', label: '不适用', count: audit.summary.NA }]} />
              <select className="compact-select compact-select--plain" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} aria-label="筛选规则分组">
                <option value="ALL">全部分组</option>
                {pack?.groups.map((group) => <option key={group.id} value={group.id}>{group.id} · {group.name}（{group.count}）</option>)}
              </select>
              <label className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索编号、规则名、判定依据" aria-label="搜索规则" /></label>
            </div>
            <TableFrame label="规则判定明细">
              <table>
                <thead><tr><th>编号 / 分组</th><th>规则</th><th>等级</th><th>判定</th><th>判定依据（含量值）</th><th>证据 / 覆盖门禁</th></tr></thead>
                <tbody>
                  {rows.map((rule) => (
                    <tr key={rule.id}>
                      <td><strong>{rule.id}</strong><small>{rule.groupName}</small></td>
                      <td><strong>{rule.name}</strong><small>{rule.value.length > 90 ? `${rule.value.slice(0, 90)}…` : rule.value}</small></td>
                      <td><Badge tone={levelTone(rule.level)}>{rule.level}</Badge></td>
                      <td><Badge tone={toneOf(rule.status)}>{labelOf(rule.status)}</Badge></td>
                      <td>{rule.message}<small>{rule.basis}</small></td>
                      <td>
                        {rule.coveredBy.length > 0 && <><Badge tone="success">门禁覆盖</Badge><small>{rule.coveredBy.join(' / ')}</small></>}
                        {rule.evidence ? (
                          <details>
                            <summary>查看证据</summary>
                            <pre>{JSON.stringify(rule.evidence, null, 2)}</pre>
                          </details>
                        ) : <small>—</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
            {!rows.length && <div className="empty-inline"><CheckCircle2 size={25} /><strong>当前筛选下没有规则</strong><span>切换状态或分组查看其它判定。</span></div>}
          </Panel>

          {findings.length > 0 && (
            <Panel eyebrow="FINDINGS" title="可执行整改清单" meta={`${findings.length} 项 · 前 8 项`}>
              <div className="detail-stack">
                {findings.slice(0, 8).map((finding) => (
                  <div className="finding-detail" key={`${finding.code}-${finding.path}`}>
                    <div className="finding-detail__head">
                      <Badge tone={finding.severity === 'blocking' ? 'danger' : 'warning'}>{finding.severity === 'blocking' ? '阻断' : '警告'}</Badge>
                      <code>{finding.code}</code>
                    </div>
                    <h3>{finding.message}</h3>
                    <div className="detail-block"><span>数据路径</span><strong>{finding.path}</strong></div>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </>
      )}
    </>
  );
}
