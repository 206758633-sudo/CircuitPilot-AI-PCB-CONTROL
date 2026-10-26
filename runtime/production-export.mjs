import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportAssembled3d, exportManufactureFile } from './artifacts.mjs';
import { artifactName } from './production-release.mjs';

/**
 * 生产文件导出：**先问产出裁决，再导出，落盘后立刻复核**。
 *
 * 为什么顺序不能反：
 *  1. 反过来（先导出再检查）会让"文件已经在磁盘上"变成事实，人就会当它是交付物；
 *  2. 命名必须由裁决决定（草稿带标记、正式不带），不能由导出者随手取名；
 *  3. 导出后要立刻用**门禁同一套规则**复核内容（Gerber 铜层数 vs 板子层数、BOM 位号集合、
 *     CPL 坐标容差、STEP 头），否则"有文件"和"文件对"混为一谈——这正是本仓库反复踩过的坑。
 */

export const PRODUCTION_EXPORT_CODES = {
  NOT_ALLOWED: 'PRODUCTION_EXPORT_NOT_ALLOWED',
  KINDS_INVALID: 'PRODUCTION_EXPORT_KINDS_INVALID',
  VERIFY_FAILED: 'PRODUCTION_EXPORT_VERIFY_FAILED',
};

export const KIND_SPECS = Object.freeze({
  gerber: { base: 'GERBER_CircuitPilot-gerber', ext: 'zip', edaFileName: 'CircuitPilot-Gerber' },
  bom: { base: 'BOM_CircuitPilot-bom', ext: 'csv', edaFileName: 'CircuitPilot-BOM' },
  cpl: { base: 'CPL_CircuitPilot-cpl', ext: 'csv', edaFileName: 'CircuitPilot-CPL' },
  step: { base: 'STEP_CircuitPilot-step', ext: 'step', edaFileName: 'CircuitPilot-Assembled-3D' },
});

export const DEFAULT_KINDS = ['gerber', 'bom', 'cpl'];

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * 计划：产出裁决不允许就不给目标文件名——**在写盘之前就把路堵死**。
 * @returns {{outDir: string, outputClass: 'draft'|'final', ticket: string|null, targets: Array<{kind: string, path: string, name: string}>}}
 */
export function planProductionExport({ decision = null, outDir, kinds = DEFAULT_KINDS } = {}) {
  if (decision?.allowed !== true || (decision.outputClass !== 'draft' && decision.outputClass !== 'final')) {
    throw fail(PRODUCTION_EXPORT_CODES.NOT_ALLOWED, `产出未获允许，拒绝导出任何生产文件（${decision?.code || 'PRODUCTION_OUTPUT_NOT_DECIDED'}）`, { decision: decision ?? null });
  }
  if (typeof outDir !== 'string' || !outDir.trim()) throw fail(PRODUCTION_EXPORT_CODES.KINDS_INVALID, '导出目录不能为空');
  const list = Array.isArray(kinds) ? kinds : null;
  if (!list || !list.length || list.some((kind) => !KIND_SPECS[kind])) throw fail(PRODUCTION_EXPORT_CODES.KINDS_INVALID, `导出种类必须是 ${Object.keys(KIND_SPECS).join('/')} 的非空子集`);
  const targets = list.map((kind) => {
    const spec = KIND_SPECS[kind];
    const named = artifactName({ base: spec.base, ext: spec.ext, outputClass: decision.outputClass });
    return { kind, path: join(outDir, named.name), name: named.name };
  });
  return { outDir, outputClass: decision.outputClass, ticket: decision.ticket ?? null, targets };
}

/**
 * 执行导出并落盘 + 复核 + 写清单。
 *
 * @param {object} options
 * @param {object} options.decision 产出裁决（来自 runtime/production-release.mjs）
 * @param {string} options.outDir 导出目录（不存在就建）
 * @param {string[]} [options.kinds] 默认 Gerber/BOM/CPL；STEP 体积大，要显式要
 * @param {(commandId: string, args: object) => Promise<unknown>} options.execute 桥命令执行器
 * @param {(input: {files: Record<string,string>, design: object}) => object|null} [options.verify] 复核回调（门禁同一套规则）
 * @param {object} [options.design] 复核需要的设计现状（位号/放置/层数/网表摘要）
 */
export async function runProductionExport({ decision = null, outDir, kinds = DEFAULT_KINDS, execute, verify = null, design = null, date = null } = {}) {
  if (typeof execute !== 'function') throw fail(PRODUCTION_EXPORT_CODES.KINDS_INVALID, '导出需要桥命令执行器');
  const plan = planProductionExport({ decision, outDir, kinds });
  mkdirSync(plan.outDir, { recursive: true });
  const files = {};
  const exported = [];
  // 至此裁决已明确允许产出（planProductionExport 不通过就直接抛了），所以这里才显式授权导出命令。
  // 顺序是有意的：**先裁决再授权**，而不是先授权再去想能不能导出。
  // 授权面只覆盖"产生文件"的命令：分片读取是只读操作，不给写授权——授权面越小越好。
  const writesArtifacts = (commandId) => commandId === 'pcb.manufacture.export' || commandId === 'pcb.3d.export';
  const authorizedExecute = (commandId, args) => (writesArtifacts(commandId) ? execute(commandId, args, { allowWrite: true }) : execute(commandId, args));
  for (const target of plan.targets) {
    const spec = KIND_SPECS[target.kind];
    const saved = target.kind === 'step'
      ? await exportAssembled3d({ execute: authorizedExecute, targetPath: target.path, fileName: spec.edaFileName })
      : await exportManufactureFile({ execute: authorizedExecute, kind: target.kind, targetPath: target.path, fileName: spec.edaFileName });
    files[target.kind] = target.path;
    exported.push({ kind: target.kind, name: target.name, path: target.path, bytes: saved.bytes, sha256: saved.sha256, chunks: saved.chunks ?? null, retriesUsed: saved.retriesUsed ?? null, edaName: saved.name ?? null });
  }
  // 导出即复核：用门禁同一套规则（Gerber 铜层/zip 完整性、BOM 位号集合、CPL 坐标容差、STEP 头）
  const verification = typeof verify === 'function' ? verify({ files, design }) : null;
  const verified = verification ? verification.status !== 'fail' : null;
  const manifest = {
    kind: 'production-export-manifest',
    schemaVersion: 1,
    generatedAt: date ?? new Date().toISOString(),
    outDir: plan.outDir,
    outputClass: plan.outputClass,
    decisionTicket: plan.ticket,
    gateFingerprint: decision?.gate?.fingerprint ?? null,
    humanSignoffRequired: true,
    files: exported.map((item) => ({ ...item, path: item.name })),
    verification,
    released: plan.outputClass === 'final' && verified === true,
  };
  if (verification && verified === false) {
    return { ok: false, code: PRODUCTION_EXPORT_CODES.VERIFY_FAILED, manifest, message: `导出完成但复核未通过（${verification.blockingCount ?? 0} 条阻断）：这些文件不能当交付物`, exported };
  }
  const manifestText = JSON.stringify(manifest, null, 2);
  const manifestPath = join(plan.outDir, 'manifest.json');
  writeFileSync(manifestPath, manifestText);
  return {
    ok: true,
    manifest: { ...manifest, manifestPath, manifestSha256: createHash('sha256').update(manifestText).digest('hex') },
    exported,
    message: plan.outputClass === 'final' ? '已按正式命名产出生产文件（仍须人工签字才能下单）' : '已产出草稿文件：带草稿标记，不得用于下单',
  };
}

/** 读回落盘的清单（供界面/审计引用，不重新计算）。 */
export function readExportManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/**
 * 导出后的复核分两种，不能混为一谈：
 *  - **内容复核**：文件真的对上设计了吗（铜层数、位号集合、CPL 坐标容差、zip 完整性、STEP 头）；
 *  - **放行命名复核**：文件是不是正式命名（草稿标记必然挡住放行，但那是我们按草稿要求故意加的）。
 *
 * 草稿导出如果直接拿"放行检查"当复核，会永远失败——这不是文件不对，而是拿错了尺子。
 * 所以这里把与本次产出类别**无关**的检查显式豁免，并把豁免内容原样记进清单（豁免不等于隐藏）。
 */
export function sanitizeArtifactVerification({ report = null, outputClass = 'draft', kinds = DEFAULT_KINDS } = {}) {
  if (!report || !Array.isArray(report.findings)) return report;
  const waived = [];
  const keep = [];
  for (const finding of report.findings) {
    const code = finding?.code;
    if (outputClass === 'draft' && code === 'RELEASE_ARTIFACT_DRAFT_MARKER') {
      waived.push({ code, message: finding.message, why: '本次就是按草稿产出：草稿标记是我们自己强制加上的，不算文件问题' });
      continue;
    }
    if (code === 'RELEASE_ARTIFACT_MISSING') {
      const missingKind = Object.keys(KIND_SPECS).find((kind) => !kinds.includes(kind) && typeof finding.message === 'string' && finding.message.includes(kind));
      if (missingKind) {
        waived.push({ code, message: finding.message, why: `本次没有申请导出 ${missingKind}，因此不算缺失` });
        continue;
      }
    }
    keep.push(finding);
  }
  const blockingCount = keep.filter((item) => item.severity === 'blocking' || item.severity === 'unknown').length;
  return {
    ...report,
    status: blockingCount ? 'fail' : 'pass',
    blockingCount,
    findings: keep,
    waived,
    note: waived.length ? `已豁免 ${waived.length} 条与本次产出类别无关的检查（原因见 waived）` : null,
  };
}
