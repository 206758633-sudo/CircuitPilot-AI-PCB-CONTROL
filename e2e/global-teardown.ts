/**
 * F2：live e2e 结束自动归档失败现场（截图/trace/HTML 报告/自动化 journal）。
 * 只在 CP_LIVE_EDA_E2E=1 时执行，离线跑 e2e 不产生噪声；归档失败只 warn，
 * 绝不因为归档问题改变测试结论。
 */
import { join } from 'node:path';
import { archiveEvidence } from '../runtime/evidence-archive.mjs';
import { defaultAutomationDir } from '../runtime/automation/journal.mjs';

export default async function globalTeardown(): Promise<void> {
  if (process.env.CP_LIVE_EDA_E2E !== '1') return;
  try {
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const manifest = archiveEvidence({
      sources: [
        join(process.cwd(), 'test-results'),
        join(process.cwd(), 'playwright-report'),
        defaultAutomationDir(),
      ],
      outDir: join(process.cwd(), 'artifacts/live-evidence', runId),
      runId,
    });
    console.log(`[live-evidence] ${manifest.summary.files} files archived -> ${manifest.outDir}`);
  } catch (error) {
    console.warn('[live-evidence] 归档失败（不影响测试结论）：', error instanceof Error ? error.message : error);
  }
}
