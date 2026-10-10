import type { AiTask, CommandLog, DiagnosticItem, ValidationCheck } from '../types';
import { logger } from '../utils/logger';

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export const demoAdapter = {
  async generatePlan(goal: string, alternative = false): Promise<Partial<AiTask>> {
    logger.info('DemoAdapter', 'Generating simulated AI plan', { alternative, goalLength: goal.length });
    await wait(700);
    const suffix = alternative ? 'B' : 'A';
    return {
      status: 'planned',
      planHash: `plan-${Date.now().toString(36)}-${suffix}`,
      evidence: ['nRF52840_PS_v1.9.pdf · USB章节', 'USB-C参考设计 Rev.2', '项目需求基线 v0.3'],
      unknowns: ['ESD器件最终料号需在BOM审批后冻结'],
      risks: alternative
        ? ['方案B减少元件数量，但USB数据线ESD裕量较低', '需要复核贴装库存']
        : ['新增ESD器件会增加约¥0.42成本', '需要在USB-C附近预留4.2mm × 2.0mm布局空间'],
      steps: [
        { id: 'step-1', title: '读取并核对USB-C网络', description: '读取VBUS、D+、D-、CC1和CC2网络及现有保护器件。', affected: ['J1', 'VBUS_5V', 'USB_DP', 'USB_DM'], selected: true, status: 'pending', risk: 'low' },
        { id: 'step-2', title: alternative ? '增加单芯片USB保护阵列' : '增加双路低容ESD保护', description: alternative ? '放置集成四通道阵列并更新网络。' : '在D+/D-和CC线上放置两类保护器件。', affected: ['D3', 'D4', 'USB_DP', 'USB_DM', 'CC1', 'CC2'], selected: true, status: 'pending', risk: 'medium' },
        { id: 'step-3', title: '增加量产测试点', description: '为VBUS、D+、D-和GND增加可探测测试点。', affected: ['TP7', 'TP8', 'TP9', 'TP10'], selected: true, status: 'pending', risk: 'low' },
        { id: 'step-4', title: '运行回读和ERC检查', description: '重新读取对象并验证网络、电气规则和BOM变化。', affected: ['ERC', 'BOM', '网表'], selected: true, status: 'pending', risk: 'low' },
      ],
      alternative,
      progress: 0,
      error: undefined,
    };
  },

  async checkEnvironment(current: DiagnosticItem[], onUpdate: (items: DiagnosticItem[]) => void) {
    logger.info('DemoAdapter', 'Running simulated environment diagnostics');
    let items: DiagnosticItem[] = current.map((item) => ({ ...item, status: 'idle' as const }));
    onUpdate(items);
    for (const item of items) {
      items = items.map((entry) => entry.id === item.id ? { ...entry, status: 'checking' as const } : entry);
      onUpdate(items);
      await wait(220);
      items = items.map((entry) => entry.id === item.id ? { ...entry, status: 'pass' as const } : entry);
      onUpdate(items);
    }
    return items;
  },

  async executeCommand(command: string, permission: 'read' | 'write'): Promise<CommandLog> {
    logger.info('DemoAdapter', 'Executing typed simulated command', { command, permission });
    const started = performance.now();
    await wait(380);
    const results: Record<string, string> = {
      'eda.connection.health': '{ service: "easyeda-bridge", connected: true, demo: true }',
      'eda.window.list': '{ windows: [{ id: "EDA-DEMO-A01", active: true }] }',
      'eda.project.readCurrent': '{ project: "Mira Sense 控制板", stage: "原理图" }',
      'eda.document.readCurrent': '{ type: "SCHEMATIC_PAGE", uuid: "SCH-01" }',
      'eda.validation.run': '{ erc: 2, drc: 0, status: "warning" }',
      'eda.project.save': '{ saved: true, demo: true }',
    };
    return {
      id: `cmd-${Date.now()}`,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      command,
      permission,
      duration: Math.round(performance.now() - started),
      result: results[command] ?? '{ ok: true, demo: true }',
      status: 'success',
    };
  },

  async runValidations(checks: ValidationCheck[], onUpdate: (checks: ValidationCheck[]) => void) {
    logger.info('DemoAdapter', 'Running all simulated validations');
    let result: ValidationCheck[] = checks.map((check) => ({ ...check, status: 'idle' as const }));
    for (const check of result) {
      result = result.map((item) => item.id === check.id ? { ...item, status: 'running' as const } : item);
      onUpdate(result);
      await wait(180);
      const finalStatus = check.findings.some((finding) => finding.severity === 'error' && finding.status === 'open')
        ? 'fail'
        : check.findings.some((finding) => finding.status === 'open') || check.id === 'val-bom'
          ? 'warn'
          : 'pass';
      result = result.map((item) => item.id === check.id ? { ...item, status: finalStatus, count: item.findings.filter((f) => f.status === 'open').length || (item.id === 'val-bom' ? 2 : 0) } : item);
      onUpdate(result);
    }
    return result;
  },

  async testProvider(provider: string) {
    logger.info('DemoAdapter', 'Testing simulated provider connection', { provider });
    const started = performance.now();
    await wait(620);
    return { ok: true, latency: Math.round(performance.now() - started), provider, demo: true };
  },
};

export function downloadDemoFile(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  logger.info('DemoAdapter', 'Generating local demo download', { filename });
  const blob = new Blob([`DEMO ONLY · 非生产资料\n\n${content}`], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
