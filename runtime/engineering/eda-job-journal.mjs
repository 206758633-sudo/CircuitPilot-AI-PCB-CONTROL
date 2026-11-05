/**
 * 任务 journal 的**文件实现**（Node 侧）。
 *
 * 为什么单独一个文件：`eda-jobs.mjs` 保持纯逻辑、可注入 journal（浏览器/测试都不需要 fs），
 * 而"持久化"这件事只属于运行时进程。这里用**追加写**：
 * 每一次状态迁移都落一行，恢复时以最后一行为准——所以进程被杀也不会留下"未知状态"的幻影。
 *
 * P2-6（2026-11-05 运行时/运维审计）：旧实现只追加、无上限，真机 journal 已涨到 5.1MB，
 * 恢复时要把整份文件读进内存；也没有"旧记录归档"的语义。这里加**单级轮转**：
 *   - 写前检查：文件字节数 ≥ maxBytes 或行数 ≥ maxLines → 先把旧文件改名为 `<file>.1`，
 *     新文件从空开始（只保留一代：够恢复最近任务，又不会让 journal 无限膨胀）；
 *   - 轮转失败**绝不阻断写**：journal 是崩溃恢复的真相来源，宁可文件大一点也不能丢掉
 *     "最后一次状态迁移"。失败只在返回值里给 `rotation.rotated=false` 标记 + 打一次告警，
 *     下一次追加继续尝试（不静默假装轮转成功）；
 *   - `read()` 按时间顺序读 `.1`（旧）+ 当前文件（新），坏行照旧跳过——这样重启 recover
 *     仍能拿到跨轮转的最近任务，不会因为轮转把"在途"洗成不存在。
 * 行数只在首次写/每次轮转后统计一次：每行都重读整个文件会把追加写退化成 O(n²)。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** 默认 8MB：单条记录的结果明细已由 eda-jobs.mjs 封顶，这个阈值只用来兜住长期运行。 */
export const JOURNAL_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** 默认 5000 行：按"每次状态迁移一行"估算，足够恢复最近若干天的任务。 */
export const JOURNAL_DEFAULT_MAX_LINES = 5000;
/** 旧一代固定后缀：只保留一份，避免轮转链无限增长。 */
export const JOURNAL_ARCHIVE_SUFFIX = '.1';

export function createFileJournal(filePath, { maxBytes = JOURNAL_DEFAULT_MAX_BYTES, maxLines = JOURNAL_DEFAULT_MAX_LINES } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw Object.assign(new Error('journal 路径不能为空'), { code: 'EDA_JOB_JOURNAL_PATH_INVALID' });
  // 阈值参数可由调用方注入（测试/运维演练用）；非法值回退默认，不因为一个配置错就拒绝启动。
  const bytesLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : JOURNAL_DEFAULT_MAX_BYTES;
  const linesLimit = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : JOURNAL_DEFAULT_MAX_LINES;
  const archivePath = `${filePath}${JOURNAL_ARCHIVE_SUFFIX}`;
  let lineCount = null;
  let rotationWarned = false;

  /** 只认普通文件：归档路径被手工建成目录/设备文件时不能让 read()/stats() 抛错（journal 不可读会拖垮恢复）。 */
  const isFile = (file) => {
    try { return existsSync(file) && statSync(file).isFile(); } catch { return false; }
  };
  const countLines = () => (isFile(filePath) ? readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim()).length : 0);

  /** 写前轮转。返回 null（无需轮转）或轮转结果标记；任何异常都转成标记，绝不向外抛。 */
  const rotateIfNeeded = () => {
    if (!isFile(filePath)) return null;
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch (error) {
      // 连 stat 都失败（权限/文件被删）：不轮转，但也不阻断本次追加（后面 append 会给出真实错误）。
      return { rotated: false, reason: 'stat-failed', message: String(error?.message || error) };
    }
    if (lineCount === null) {
      try { lineCount = countLines(); } catch { lineCount = 0; }
    }
    const reason = size >= bytesLimit ? 'bytes' : lineCount >= linesLimit ? 'lines' : null;
    if (!reason) return null;
    const linesAtRotation = lineCount;
    try {
      // 先删旧归档再改名：rename 到已存在目标在部分平台会失败；手工改坏的归档也不该挡住新记录。
      rmSync(archivePath, { force: true });
      renameSync(filePath, archivePath);
      lineCount = 0;
      rotationWarned = false;
      return { rotated: true, archivePath, bytes: size, lines: linesAtRotation, reason };
    } catch (error) {
      // 轮转失败不阻断写：继续追加到当前文件（可能继续增大，但恢复真相优先）。
      if (!rotationWarned) {
        rotationWarned = true;
        console.warn('[circuitpilot] EDA 任务 journal 轮转失败（继续追加，不阻断记录）:', String(error?.message || error));
      }
      return { rotated: false, reason, message: String(error?.message || error) };
    }
  };

  return {
    path: filePath,
    archivePath,
    maxBytes: bytesLimit,
    maxLines: linesLimit,
    append(record) {
      mkdirSync(dirname(filePath), { recursive: true });
      // 新文件（不存在）从 0 开始计数；已存在则由 rotateIfNeeded 首次读取初始化。
      if (lineCount === null && !isFile(filePath)) lineCount = 0;
      const rotation = rotateIfNeeded();
      appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
      if (lineCount !== null) lineCount += 1;
      return rotation ? { ok: true, rotation } : { ok: true };
    },
    read() {
      // 旧归档在前、当前文件在后：同一 jobId 以"最新一行"为准（EdaJobStore.recover 顺序 set 即依赖这个顺序）。
      const records = [];
      for (const file of [archivePath, filePath]) {
        if (!isFile(file)) continue;
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          // 坏行（进程被杀的半行/手改）只跳过，不能让整份 journal 变不可读。
          try { records.push(JSON.parse(line)); } catch { /* ignore bad line */ }
        }
      }
      return records;
    },
    /** 只读诊断：轮转是否已发生、当前体积/行数（不触发轮转）。 */
    stats() {
      const bytes = isFile(filePath) ? statSync(filePath).size : 0;
      return {
        path: filePath,
        archivePath,
        bytes,
        lines: lineCount ?? (isFile(filePath) ? countLines() : 0),
        maxBytes: bytesLimit,
        maxLines: linesLimit,
        archived: isFile(archivePath),
      };
    },
  };
}
