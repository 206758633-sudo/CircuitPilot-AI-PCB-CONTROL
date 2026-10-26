import { ShieldCheck } from 'lucide-react';
import { EdaPage } from './EdaPage';
import { useApp } from '../state/AppContext';

import { STAGE_ORDER } from '../services/stageMachine';

const stageOrder = STAGE_ORDER;

export function ExecutionPage() {
  const { state, activeProject } = useApp();
  const stageIndex = Math.max(0, stageOrder.indexOf((activeProject?.stage ?? '概念') as typeof stageOrder[number]));
  const steps = [
    { title: '读取设计', meta: state.eda.connected ? `已连接 :${state.eda.port}` : '等待连接 EDA', done: state.eda.connected, now: !state.eda.connected },
    { title: '生成方案', meta: stageIndex >= 1 ? '方案已生成，待批准' : 'AI 生成网络表草案', done: stageIndex >= 2, now: stageIndex >= 1 && stageIndex < 2 },
    { title: '人工批准', meta: stageIndex >= 2 ? '已批准并写入' : '计划哈希 + 一次性令牌', done: stageIndex >= 3, now: stageIndex >= 2 && stageIndex < 3 },
    { title: '写入与验证', meta: stageIndex >= 3 ? '回读与 DRC 已执行' : '快照 → 写入 → 回读 → DRC', done: stageIndex >= 4, now: stageIndex >= 3 },
  ];

  return (
    <div>
      <div className="stepper" aria-label="受控执行步骤">
        {steps.map((step, index) => (
          <div className={`step ${step.done ? 'is-done' : step.now ? 'is-now' : 'is-todo'}`} key={step.title}>
            <i className="step-ico">{step.done ? '✓' : index + 1}</i>
            <strong>{step.title}</strong>
            <small>{step.meta}</small>
          </div>
        ))}
      </div>
      <div className="inline-alert" style={{ marginBottom: 14 }}>
        <ShieldCheck size={15} style={{ color: 'var(--green)', flex: 'none', marginTop: 2 }} />
        <span>安全门禁不可跳过：任何写入都要求「计划哈希 + 一次性批准令牌 + 写入前快照」，执行后强制回读与 DRC，失败自动回滚。这里只改变呈现层级，不删除门禁。</span>
      </div>
      <EdaPage />
    </div>
  );
}
