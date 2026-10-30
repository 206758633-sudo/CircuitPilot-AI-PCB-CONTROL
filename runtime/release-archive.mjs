/**
 * B8：不可变发布版本（release archive）。
 *
 * 设计约束：
 *   - 只有**放行真正 ready**（本地门禁全过 + 人工 DFM/签核证据齐备）才允许归档；
 *     不 ready 一律 409 RELEASE_ARCHIVE_NOT_ALLOWED，并列出 blockedBy——绝不让"先归档后补证据"发生；
 *   - 归档记录绑定 planHash / manifestHash / pcbUuid / reviewHash / gateFingerprint / decisionFingerprint，
 *     证据文件逐个记 path+sha256+bytes；写盘用 writeFileSync(..., {flag:'wx'})，**已存在即失败**，没有覆盖路径；
 *   - 模块只提供 archive/list/get/verify，**没有 update/delete**——不可变不是 UI 约定，是能力缺失；
 *   - verify 会重算记录哈希并重新校验证据文件 sha256：文件被改/缺 → verified:false + problems，
 *     不把"记录还在"当成"证据仍然可信"。
 */
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectProductionArtifacts } from './production.mjs';

export const RELEASE_ARCHIVE_CODES = Object.freeze({
  NOT_ALLOWED: 'RELEASE_ARCHIVE_NOT_ALLOWED',
  BINDING_INVALID: 'RELEASE_ARCHIVE_BINDING_INVALID',
  // P1-6：文档/版本/执行域缺失（稀疏 binding）时不能拿它重算 manifestHash——那会得到与签核/导出一致的假象。
  BINDING_INCOMPLETE: 'RELEASE_ARCHIVE_BINDING_INCOMPLETE',
  // P1-6：服务端用完整 binding 重算的 manifestHash ≠ 调用方/签核绑定值 ⇒ 物料已变，拒绝归档。
  MANIFEST_DRIFT: 'RELEASE_ARCHIVE_MANIFEST_DRIFT',
  EVIDENCE_UNREADABLE: 'RELEASE_ARCHIVE_EVIDENCE_UNREADABLE',
  DUPLICATE: 'RELEASE_ARCHIVE_DUPLICATE',
  NOT_FOUND: 'RELEASE_ARCHIVE_NOT_FOUND',
  INVALID_ID: 'RELEASE_ARCHIVE_INVALID_ID',
});

const text = (value) => String(value ?? '').trim();
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const ID_PATTERN = /^rel-[a-z0-9-]{6,80}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** 记录哈希：对除 archiveHash 外的规范字段求 sha256（JSON 键序由构造顺序固定）。 */
function computeArchiveHash(record) {
  const { archiveHash: _ignored, ...rest } = record;
  return sha256(JSON.stringify(rest));
}

function evidenceFileEntries(files) {
  const entries = [];
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = text(file?.path);
    if (!filePath) continue;
    try {
      const bytes = readFileSync(filePath);
      entries.push({ role: text(file?.role) || 'artifact', path: filePath, bytes: bytes.length, sha256: sha256(bytes) });
    } catch (error) {
      entries.push({ role: text(file?.role) || 'artifact', path: filePath, bytes: null, sha256: null, error: `读取失败：${error?.code || error?.message || 'unknown'}` });
    }
  }
  return entries;
}

export function createReleaseArchiveStore({ dir, now = () => new Date().toISOString() } = {}) {
  if (!dir) throw new Error('release archive 必须提供 dir');
  const ensureDir = () => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); };

  function verifyRecord(record) {
    const problems = [];
    if (!record || typeof record !== 'object') return { verified: false, problems: ['记录不是对象'] };
    if (record.immutable !== true) problems.push('记录未标记 immutable=true');
    if (record.archiveHash !== computeArchiveHash(record)) problems.push('记录哈希与内容不一致：归档记录被改动过');
    for (const file of Array.isArray(record.evidence?.files) ? record.evidence.files : []) {
      if (!file.path) { problems.push('证据条目缺 path'); continue; }
      if (!existsSync(file.path)) { problems.push(`证据文件缺失：${file.path}`); continue; }
      try {
        const bytes = readFileSync(file.path);
        if (sha256(bytes) !== file.sha256) problems.push(`证据文件被改动：${file.path}`);
        if (bytes.length !== file.bytes) problems.push(`证据文件长度变化：${file.path}`);
      } catch (error) {
        problems.push(`证据文件不可读：${file.path}（${error?.code || error?.message}）`);
      }
    }
    return { verified: problems.length === 0, problems };
  }

  return {
    dir,
    /**
     * 归档一次已 ready 的放行。调用方必须传入**服务端重算**过的 gate/releaseDecision，
     * 不能把客户端自报的 ready 传进来（路由层负责重算）。
     */
    archive({ gate = null, releaseDecision = null, binding = null, artifactsDir = null, files = [], notes = '', recomputeManifest = undefined } = {}) {
      if (!gate || gate.ready !== true) {
        throw Object.assign(new Error('本地放行门禁未通过，不能归档发布版本'), {
          code: RELEASE_ARCHIVE_CODES.NOT_ALLOWED, status: 409,
          details: { blockers: Array.isArray(gate?.blockers) ? gate.blockers : [], verdict: gate?.verdict ?? null }, 
        });
      }
      if (!releaseDecision || releaseDecision.ready !== true) {
        throw Object.assign(new Error('统一放行裁决未 ready（人工 DFM/签核证据缺失或不匹配），不能归档发布版本'), {
          code: RELEASE_ARCHIVE_CODES.NOT_ALLOWED, status: 409,
          details: { blockedBy: Array.isArray(releaseDecision?.blockedBy) ? releaseDecision.blockedBy : [], verdict: releaseDecision?.verdict ?? null },
        });
      }
      // P1-6：归档是"把已签核的那批物料冻起来"，所以 manifestHash 必须由服务端用**与导出/签核
      // 相同的完整 binding**（projectId/documentId/sourceDigest/semanticPlanHash/compiledPlanHash/
      // executionId）对 artifactsDir 重算，不能信任调用方传来的（旧路由曾用稀疏 binding 重算，
      // 结果与签核哈希必然不等 → B8 结构性 400/409）。
      const semanticPlanHash = text(binding?.semanticPlanHash) || text(binding?.planHash) || null;
      const legacyPlanHash = text(binding?.planHash) || null;
      const fullBinding = {
        projectId: text(binding?.projectId) || null,
        projectName: text(binding?.projectName) || null,
        documentId: text(binding?.documentId) || null,
        sourceDigest: text(binding?.sourceDigest) || null,
        semanticPlanHash,
        compiledPlanHash: text(binding?.compiledPlanHash) || null,
        executionId: text(binding?.executionId) || text(binding?.pcbExecutionId) || null,
      };
      const fullBindingMissing = ['projectId', 'documentId', 'sourceDigest', 'semanticPlanHash', 'compiledPlanHash', 'executionId'].filter((key) => !fullBinding[key]);
      const fullBindingMode = fullBindingMissing.length === 0;
      // 自动模式：完整 binding + artifactsDir ⇒ 必须重算（这正是服务端归档路由的形状）。
      // 旧测试/旧调用的稀疏 binding 保持原行为；显式 true 时即使稀疏也要求重算（交给下面报 INCOMPLETE）。
      const recomputeRequested = recomputeManifest === true || (recomputeManifest !== false && fullBindingMode);
      if (recomputeRequested && !fullBindingMode) {
        throw Object.assign(new Error(`归档 binding 不完整（缺 ${fullBindingMissing.join('/')}）：稀疏 binding 重算的 manifestHash 与导出/签核不会一致，拒绝用假哈希归档`), {
          code: RELEASE_ARCHIVE_CODES.BINDING_INCOMPLETE, status: 400, details: { missing: fullBindingMissing },
        });
      }
      // planHash 兼容口径（与 UI"可留空"一致）：semanticPlanHash 或 planHash 任一存在即可。
      if (!semanticPlanHash) {
        throw Object.assign(new Error('归档必须绑定语义计划哈希（semanticPlanHash）或 planHash'), {
          code: fullBindingMode ? RELEASE_ARCHIVE_CODES.BINDING_INCOMPLETE : RELEASE_ARCHIVE_CODES.BINDING_INVALID,
          status: 400, details: { missing: ['semanticPlanHash', 'planHash'] },
        });
      }
      let authoritativeManifestHash = text(binding?.manifestHash) || null;
      let manifestRecomputed = null;
      if (recomputeRequested) {
        if (!text(artifactsDir)) {
          throw Object.assign(new Error('完整 binding 归档必须提供 artifactsDir：服务端要用它重算 manifestHash（不能拿调用方自报值当依据）'), {
            code: RELEASE_ARCHIVE_CODES.BINDING_INCOMPLETE, status: 400, details: { missing: ['artifactsDir'] },
          });
        }
        manifestRecomputed = inspectProductionArtifacts(text(artifactsDir), fullBinding).manifest.manifestHash;
        if (authoritativeManifestHash && authoritativeManifestHash !== manifestRecomputed) {
          throw Object.assign(new Error(`归档 manifestHash 与 artifactsDir 重算不一致（signoff/请求=${authoritativeManifestHash.slice(0, 12)}…，重算=${manifestRecomputed.slice(0, 12)}…）：物料已变，不能把旧签核冻进发布版本`), {
            code: RELEASE_ARCHIVE_CODES.MANIFEST_DRIFT, status: 409,
            details: { provided: authoritativeManifestHash, recomputed: manifestRecomputed, artifactsDir: text(artifactsDir) },
          });
        }
        authoritativeManifestHash = manifestRecomputed;
      }
      const safeBinding = {
        planHash: legacyPlanHash || semanticPlanHash,
        semanticPlanHash,
        compiledPlanHash: fullBinding.compiledPlanHash,
        pcbUuid: text(binding?.pcbUuid) || null,
        pcbExecutionId: text(binding?.pcbExecutionId) || null,
        executionId: fullBinding.executionId,
        projectId: fullBinding.projectId,
        projectName: fullBinding.projectName,
        documentId: fullBinding.documentId,
        sourceDigest: fullBinding.sourceDigest,
        reviewHash: text(binding?.reviewHash) || null,
        manifestHash: authoritativeManifestHash,
        gateFingerprint: gate?.fingerprint?.sha256 ?? null,
        decisionFingerprint: releaseDecision?.fingerprint ?? null,
        manifestRecomputed,
      };
      if (!safeBinding.manifestHash || !HEX64.test(safeBinding.manifestHash)) throw Object.assign(new Error('归档必须绑定合法的 manifestHash（sha256 十六进制）'), { code: RELEASE_ARCHIVE_CODES.BINDING_INVALID, status: 400, details: { manifestHash: safeBinding.manifestHash } });
      if (!safeBinding.reviewHash) throw Object.assign(new Error('归档必须绑定人工终审 reviewHash'), { code: RELEASE_ARCHIVE_CODES.BINDING_INVALID, status: 400 });
      // 目录本身不作为文件条目（readFileSync 目录会 EISDIR）；目录路径单独记在 evidence.artifactsDir。
      const evidenceFiles = evidenceFileEntries(Array.isArray(files) ? files : []);
      if (evidenceFiles.some((item) => item.error)) {
        throw Object.assign(new Error('证据文件不可读，拒绝归档（不能留下无法复核的发布版本）'), {
          code: RELEASE_ARCHIVE_CODES.EVIDENCE_UNREADABLE, status: 400,
          details: { files: evidenceFiles.filter((item) => item.error) },
        });
      }
      const createdAt = now();
      const record = {
        schemaVersion: 1,
        kind: 'circuitpilot-release-archive',
        releaseId: `rel-${createdAt.replace(/[:.]/g, '-').toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt,
        immutable: true,
        binding: safeBinding,
        gate: {
          ready: gate.ready,
          verdict: gate.verdict,
          blockers: Array.isArray(gate.blockers) ? gate.blockers.map((item) => ({ code: item.code, message: item.message })) : [],
          warnings: Array.isArray(gate.warnings) ? gate.warnings.map((item) => ({ code: item.code, message: item.message })) : [],
          gates: Array.isArray(gate.gates) ? gate.gates.map((item) => ({ id: item.id, status: item.status, blockingCount: item.blockingCount })) : [],
        },
        releaseDecision: {
          ready: releaseDecision.ready,
          verdict: releaseDecision.verdict,
          blockedBy: releaseDecision.blockedBy ?? [],
          gates: Array.isArray(releaseDecision.gates) ? releaseDecision.gates.map((item) => ({ id: item.id, scope: item.scope, status: item.status, passed: item.passed })) : [],
          evidence: releaseDecision.evidence ?? null,
        },
        evidence: {
          artifactsDir: artifactsDir ? text(artifactsDir) : null,
          files: evidenceFiles,
        },
        notes: text(notes).slice(0, 500) || null,
        operatorNote: '归档绑定服务端重算的门禁/裁决/人工证据指纹；本记录无更新/删除接口（不可变）',
      };
      record.archiveHash = computeArchiveHash(record);
      ensureDir();
      const filePath = join(dir, `${record.releaseId}.json`);
      try {
        writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
      } catch (error) {
        if (error?.code === 'EEXIST') throw Object.assign(new Error(`发布版本已存在，拒绝覆盖：${record.releaseId}`), { code: RELEASE_ARCHIVE_CODES.DUPLICATE, status: 409 });
        throw error;
      }
      return { ...record, filePath, verification: verifyRecord(record) };
    },

    list() {
      if (!existsSync(dir)) return { releases: [], corrupt: [] };
      const releases = [];
      const corrupt = [];
      for (const name of readdirSync(dir).filter((item) => item.endsWith('.json')).sort()) {
        try {
          const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
          const verification = verifyRecord(record);
          releases.push({ releaseId: record.releaseId, createdAt: record.createdAt, binding: record.binding, verdict: record.gate?.verdict ?? null, files: record.evidence?.files?.length ?? 0, verification });
        } catch (error) {
          corrupt.push({ file: name, error: error?.message || String(error) });
        }
      }
      releases.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
      return { releases, corrupt };
    },

    get(releaseId) {
      if (!ID_PATTERN.test(text(releaseId))) throw Object.assign(new Error(`发布版本 id 非法：${releaseId || '空'}`), { code: RELEASE_ARCHIVE_CODES.INVALID_ID, status: 400 });
      const filePath = join(dir, `${releaseId}.json`);
      if (!existsSync(filePath)) throw Object.assign(new Error(`发布版本不存在：${releaseId}`), { code: RELEASE_ARCHIVE_CODES.NOT_FOUND, status: 404 });
      const record = JSON.parse(readFileSync(filePath, 'utf8'));
      return { ...record, filePath, verification: verifyRecord(record) };
    },
  };
}
