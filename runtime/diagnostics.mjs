import { existsSync } from 'node:fs';
import os from 'node:os';
import { edaAppCandidates, platformId } from './platform.mjs';
import { findExecutable, runProcess } from './process.mjs';

async function executableCheck(name) {
  const executable = await findExecutable(name);
  if (!executable) return { id: name, status: 'fail', installed: false, code: `${name.toUpperCase()}_NOT_FOUND`, detail: `${name}未在受支持路径中找到` };
  const result = await runProcess(executable, ['--version'], { timeoutMs: 4_000 });
  return { id: name, status: result.ok ? 'pass' : 'warn', installed: true, path: executable, detail: (result.stdout || result.stderr || '版本未知').slice(0, 160) };
}

export async function systemDiagnostics() {
  const [codex, claude, cargo] = await Promise.all([
    executableCheck('codex'),
    executableCheck('claude'),
    executableCheck('cargo'),
  ]);
  const edaPath = edaAppCandidates().find((candidate) => existsSync(candidate)) || null;
  return {
    checkedAt: new Date().toISOString(),
    platform: { id: platformId(), status: ['darwin', 'win32', 'linux'].includes(process.platform) ? 'pass' : 'fail', platform: process.platform, release: os.release(), arch: process.arch },
    node: { id: 'node', status: 'pass', installed: true, detail: process.version },
    codex,
    claude,
    cargo,
    easyeda: {
      id: 'easyeda',
      status: edaPath ? 'pass' : 'fail',
      installed: Boolean(edaPath),
      path: edaPath,
      code: edaPath ? undefined : 'EASYEDA_NOT_FOUND',
      detail: edaPath ? '已发现嘉立创EDA专业版' : '未在受支持路径发现嘉立创EDA专业版',
    },
  };
}
