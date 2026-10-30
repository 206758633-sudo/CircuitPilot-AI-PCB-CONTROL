#!/usr/bin/env node
/**
 * 审计归档/回放 CLI。
 *
 *   node scripts/agent-audit-archive.mjs create \
 *     --audit-file <agent-audit.jsonl> --key-file <agent-audit.key.json> \
 *     --head-file <agent-audit.head.json> --out <new-archive-dir>
 *
 *   node scripts/agent-audit-archive.mjs verify \
 *     --dir <archive-dir> --key-file <agent-audit.key.json>
 *
 * 输出 JSON；成功 exit 0，失败 exit 1。绝不打印 key/token 内容。
 */
import {
  AGENT_AUDIT_ARCHIVE_CODES,
  createAgentAuditArchive,
  createExternalAuditAnchor,
  verifyAgentAuditArchive,
  verifyExternalAuditAnchor,
} from '../runtime/agent-audit-archive.mjs';

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith('--')) {
      options[key] = value;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

async function main() {
  const [command] = process.argv.slice(2);
  const options = parseArgs(process.argv.slice(3));
  if (command === 'create') {
    if (!options['audit-file'] || !options.out) {
      console.error('create 需要 --audit-file 与 --out');
      return 1;
    }
    const result = await createAgentAuditArchive({
      auditFile: options['audit-file'],
      keyFile: options['key-file'],
      headFile: options['head-file'],
      outDir: options.out,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (command === 'verify') {
    if (!options.dir || !options['key-file']) {
      console.error('verify 需要 --dir 与 --key-file');
      return 1;
    }
    const result = await verifyAgentAuditArchive({ dir: options.dir, keyFile: options['key-file'] });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (command === 'anchor') {
    if (!options['audit-file'] || !options.dir) {
      console.error('anchor 需要 --audit-file 与 --dir（独立于 state 的外部目录）');
      return 1;
    }
    const result = await createExternalAuditAnchor({
      auditFile: options['audit-file'],
      keyFile: options['key-file'],
      headFile: options['head-file'],
      anchorDir: options.dir,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (command === 'verify-anchor') {
    if (!options['anchor-file'] || !options['audit-file'] || !options['key-file']) {
      console.error('verify-anchor 需要 --anchor-file、--audit-file 与 --key-file');
      return 1;
    }
    const result = await verifyExternalAuditAnchor({
      anchorFile: options['anchor-file'],
      auditFile: options['audit-file'],
      keyFile: options['key-file'],
      headFile: options['head-file'],
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  console.error(`未知命令：${command ?? '(空)'}；可用 create|verify|anchor|verify-anchor`);
  return AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT ? 1 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(JSON.stringify({ ok: false, code: 'AGENT_AUDIT_ARCHIVE_UNEXPECTED', message: String(error?.message || error) }));
  process.exit(1);
});
