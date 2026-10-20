/**
 * 任务 journal 的**文件实现**（Node 侧）。
 *
 * 为什么单独一个文件：`eda-jobs.mjs` 保持纯逻辑、可注入 journal（浏览器/测试都不需要 fs），
 * 而"持久化"这件事只属于运行时进程。这里用**追加写**：
 * 每一次状态迁移都落一行，恢复时以最后一行为准——所以进程被杀也不会留下"未知状态"的幻影。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function createFileJournal(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw Object.assign(new Error('journal 路径不能为空'), { code: 'EDA_JOB_JOURNAL_PATH_INVALID' });
  return {
    path: filePath,
    append(record) {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    },
    read() {
      if (!existsSync(filePath)) return [];
      return readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    },
  };
}
