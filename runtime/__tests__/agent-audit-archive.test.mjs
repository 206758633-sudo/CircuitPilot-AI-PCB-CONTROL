import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { appendAgentAudit } from '../agent-console.mjs';
import {
  AGENT_AUDIT_ARCHIVE_CODES,
  createAgentAuditArchive,
  createExternalAuditAnchor,
  verifyAgentAuditArchive,
  verifyAuditChain,
  verifyExternalAuditAnchor,
} from '../agent-audit-archive.mjs';

async function seedAudit() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cp-audit-archive-'));
  const auditFile = join(dir, 'agent-audit.jsonl');
  const keyFile = join(dir, 'agent-audit.key.json');
  const headFile = join(dir, 'agent-audit.head.json');
  for (let i = 1; i <= 3; i += 1) {
    const result = await appendAgentAudit({
      auditFile,
      keyFile,
      headFile,
      event: {
        at: new Date(2026, 9, 29, 10, 0, i).toISOString(),
        kind: 'request',
        actor: 'agent',
        method: 'GET',
        path: '/api/agent/status',
        outcome: 'ok',
        status: 200,
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  return { dir, auditFile, keyFile, headFile };
}

test('audit archive：create 冻结完整链，verify 成功且不复制 key', async () => {
  const { dir, auditFile, keyFile, headFile } = await seedAudit();
  try {
    const outDir = join(dir, 'archive');
    const created = await createAgentAuditArchive({ auditFile, keyFile, headFile, outDir });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.manifest.chain.total, 3);
    assert.equal(created.manifest.chain.verified, 3);
    assert.equal(created.manifest.chain.anchored, true);
    assert.equal(created.manifest.key.included, false);
    const names = await fs.readdir(outDir);
    assert.deepEqual(names.sort(), ['agent-audit.head.json', 'agent-audit.jsonl', 'manifest.json']);
    assert.equal(names.includes('agent-audit.key.json'), false);

    const verified = await verifyAgentAuditArchive({ dir: outDir, keyFile });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(verified.chain.total, 3);
    assert.equal(verified.chain.lastSeq, 3);
    assert.equal(verified.chain.anchored, true);

    if (process.platform !== 'win32') {
      for (const name of names) {
        const stat = await fs.stat(join(outDir, name));
        assert.equal(stat.mode & 0o777, 0o600, name);
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('audit archive：归档审计行被改写 → verify 拒绝', async () => {
  const { dir, auditFile, keyFile, headFile } = await seedAudit();
  try {
    const outDir = join(dir, 'archive');
    assert.equal((await createAgentAuditArchive({ auditFile, keyFile, headFile, outDir })).ok, true);
    const target = join(outDir, 'agent-audit.jsonl');
    const raw = await fs.readFile(target, 'utf8');
    await fs.writeFile(target, raw.replace('"outcome":"ok"', '"outcome":"fail"'));
    const verified = await verifyAgentAuditArchive({ dir: outDir, keyFile });
    assert.equal(verified.ok, false);
    assert.match(verified.message, /SHA-256/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('audit archive：归档 head 被改写 → verify 拒绝', async () => {
  const { dir, auditFile, keyFile, headFile } = await seedAudit();
  try {
    const outDir = join(dir, 'archive');
    assert.equal((await createAgentAuditArchive({ auditFile, keyFile, headFile, outDir })).ok, true);
    const target = join(outDir, 'agent-audit.head.json');
    const head = JSON.parse(await fs.readFile(target, 'utf8'));
    head.hash = 'f'.repeat(64);
    await fs.writeFile(target, JSON.stringify(head));
    const verified = await verifyAgentAuditArchive({ dir: outDir, keyFile });
    assert.equal(verified.ok, false);
    assert.match(verified.message, /SHA-256/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('audit archive：源链已断 / outDir 已存在 → create 拒绝', async () => {
  const { dir, auditFile, keyFile, headFile } = await seedAudit();
  try {
    const outDir = join(dir, 'archive');
    assert.equal((await createAgentAuditArchive({ auditFile, keyFile, headFile, outDir })).ok, true);
    const again = await createAgentAuditArchive({ auditFile, keyFile, headFile, outDir });
    assert.equal(again.ok, false);
    assert.equal(again.code, AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT);

    const brokenAudit = join(dir, 'broken-audit.jsonl');
    const brokenHead = join(dir, 'broken-audit.head.json');
    const brokenKey = join(dir, 'broken-audit.key.json');
    await fs.writeFile(brokenAudit, await fs.readFile(auditFile));
    await fs.writeFile(brokenHead, await fs.readFile(headFile));
    await fs.writeFile(brokenKey, await fs.readFile(keyFile));
    const raw = await fs.readFile(brokenAudit, 'utf8');
    await fs.writeFile(brokenAudit, raw.replace('"outcome":"ok"', '"outcome":"fail"'));
    const chain = await verifyAuditChain({ auditFile: brokenAudit, keyFile: brokenKey, headFile: brokenHead });
    assert.equal(chain.ok, false);
    assert.equal(chain.code, AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('audit archive：manifest 路径穿越 → verify 拒绝', async () => {
  const { dir, auditFile, keyFile, headFile } = await seedAudit();
  try {
    const outDir = join(dir, 'archive');
    assert.equal((await createAgentAuditArchive({ auditFile, keyFile, headFile, outDir })).ok, true);
    const manifestPath = join(outDir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.audit.file = '../agent-audit.jsonl';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const verified = await verifyAgentAuditArchive({ dir: outDir, keyFile });
    assert.equal(verified.ok, false);
    assert.equal(verified.code, AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED);
    assert.match(verified.message, /路径/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('audit archive：manifest 被改写但未重签 → verify 拒绝', async () => {
  const { dir, auditFile, keyFile, headFile } = await seedAudit();
  try {
    const outDir = join(dir, 'archive');
    assert.equal((await createAgentAuditArchive({ auditFile, keyFile, headFile, outDir })).ok, true);
    const manifestPath = join(outDir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.chain.total = 99;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const verified = await verifyAgentAuditArchive({ dir: outDir, keyFile });
    assert.equal(verified.ok, false);
    assert.equal(verified.code, AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED);
    assert.match(verified.message, /签名/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('audit archive：密钥错误/缺失 → verify 拒绝且不误报通过', async () => {
  const { dir, auditFile, keyFile, headFile } = await seedAudit();
  try {
    const outDir = join(dir, 'archive');
    assert.equal((await createAgentAuditArchive({ auditFile, keyFile, headFile, outDir })).ok, true);
    const wrongKey = join(dir, 'wrong.key.json');
    await fs.writeFile(wrongKey, JSON.stringify({ version: 1, key: 'a'.repeat(64) }));
    const wrong = await verifyAgentAuditArchive({ dir: outDir, keyFile: wrongKey });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED);
    assert.match(wrong.message, /签名/);

    const missing = await verifyAgentAuditArchive({ dir: outDir, keyFile: join(dir, 'missing.key.json') });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, AGENT_AUDIT_ARCHIVE_CODES.KEY_UNAVAILABLE);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test('audit external anchor：独立目录签名收据可验证，且当前链推进后不冒充一致', async () => {
  const { dir, auditFile, keyFile, headFile } = await seedAudit();
  try {
    const anchorDir = join(dir, 'external-anchors');
    const created = await createExternalAuditAnchor({ auditFile, keyFile, headFile, anchorDir });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.anchor.chain.lastSeq, 3);
    assert.equal(created.anchor.source.audit, 'agent-audit.jsonl');
    const names = await fs.readdir(anchorDir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^anchor-3-[0-9a-f]{16}\.json$/);
    if (process.platform !== 'win32') {
      const stat = await fs.stat(join(anchorDir, names[0]));
      assert.equal(stat.mode & 0o777, 0o600);
    }
    const verified = await verifyExternalAuditAnchor({ anchorFile: created.anchorFile, auditFile, keyFile, headFile });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(verified.currentMatches, true);
    assert.equal(verified.anchorSeq, 3);

    // 当前链继续前进：锚点仍然签名有效，但必须如实报告 currentMatches=false。
    await appendAgentAudit({ auditFile, keyFile, headFile, event: { at: new Date().toISOString(), kind: 'request', actor: 'agent', method: 'GET', path: '/api/agent/status', outcome: 'ok', status: 200 } });
    const advanced = await verifyExternalAuditAnchor({ anchorFile: created.anchorFile, auditFile, keyFile, headFile });
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    assert.equal(advanced.currentMatches, false);
    assert.equal(advanced.currentSeq, 4);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('audit external anchor：收据被改写 → 签名校验拒绝', async () => {
  const { dir, auditFile, keyFile, headFile } = await seedAudit();
  try {
    const anchorDir = join(dir, 'external-anchors');
    const created = await createExternalAuditAnchor({ auditFile, keyFile, headFile, anchorDir });
    assert.equal(created.ok, true, JSON.stringify(created));
    const raw = JSON.parse(await fs.readFile(created.anchorFile, 'utf8'));
    raw.chain.lastSeq = 99;
    await fs.writeFile(created.anchorFile, JSON.stringify(raw));
    const verified = await verifyExternalAuditAnchor({ anchorFile: created.anchorFile, auditFile, keyFile, headFile });
    assert.equal(verified.ok, false);
    assert.match(verified.message || '', /签名/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
