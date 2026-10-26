/**
 * D7：EDA 文档绑定按项目持久化（跨页/刷新一致）。
 *
 * 为什么需要它：EDA 页原来把"当前 PCB 文档 UUID"放在组件 useState 里，刷新后回退到
 * 一个写死的 UUID（另一个项目的文档），导致"同一事实、多个状态源"：刷新后可能对错板子
 * 读取/批准。这里把**用户显式输入/新建/绑定**的文档身份按项目 id 落 localStorage，
 * 只作为"打开哪个文档"的候选；真正的证据仍必须由运行时读回（targetFingerprint）确认。
 *
 * 纪律：
 *   - 只接受 16-64 位十六进制 UUID；非法值不写入（避免把手误输入当默认目标）；
 *   - 按项目隔离，项目 A 的文档永远不能成为项目 B 的默认值；
 *   - 存储损坏/不可用时静默回退空值（fail-closed：宁可让用户重新选择，也不猜目标）。
 */
const KEY = 'circuitpilot-eda-docs-v1';
const UUID_RE = /^[a-f0-9]{16,64}$/i;
export const isEdaDocumentUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value.trim());

export interface EdaDocumentBinding {
  pcbDocumentUuid: string;
  updatedAt: string;
}
interface EdaDocumentStore {
  schemaVersion: 1;
  byProject: Record<string, EdaDocumentBinding>;
}

function readAll(): EdaDocumentStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { schemaVersion: 1, byProject: {} };
    const parsed = JSON.parse(raw) as Partial<EdaDocumentStore>;
    const byProject: Record<string, EdaDocumentBinding> = {};
    for (const [projectId, entry] of Object.entries(parsed?.byProject ?? {})) {
      if (!projectId || !entry || !isEdaDocumentUuid(entry.pcbDocumentUuid)) continue;
      byProject[projectId] = { pcbDocumentUuid: entry.pcbDocumentUuid.trim(), updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString() };
    }
    return { schemaVersion: 1, byProject };
  } catch {
    return { schemaVersion: 1, byProject: {} };
  }
}

export function readEdaDocumentBinding(projectId: string | null | undefined): EdaDocumentBinding | null {
  if (!projectId) return null;
  return readAll().byProject[projectId] ?? null;
}

/** 合法 UUID 写入；非法 UUID 会**删除**该项目旧值（不保留过期目标，避免刷新后回到错板）。 */
export function saveEdaDocumentBinding(projectId: string | null | undefined, pcbDocumentUuid: string): EdaDocumentBinding | null {
  if (!projectId) return null;
  const store = readAll();
  if (!isEdaDocumentUuid(pcbDocumentUuid)) {
    delete store.byProject[projectId];
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* 存储不可用时保持内存语义之外的行为不变 */ }
    return null;
  }
  const binding = { pcbDocumentUuid: pcbDocumentUuid.trim(), updatedAt: new Date().toISOString() };
  store.byProject[projectId] = binding;
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* 忽略：下次读取会回退 */ }
  return binding;
}

/** 项目被删除时清掉绑定，避免项目 id 复用后串目标。 */
export function clearEdaDocumentBinding(projectId: string | null | undefined): void {
  if (!projectId) return;
  const store = readAll();
  if (!(projectId in store.byProject)) return;
  delete store.byProject[projectId];
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* ignore */ }
}

/** 解析"当前项目 PCB 文档"的权威候选：项目绑定优先，其次本机按项目记忆；都没有返回空串。 */
export function resolvePcbDocumentUuid(project: { id: string; edaWorkspace?: { pcbUuid?: string } } | null | undefined): string {
  if (!project) return '';
  if (isEdaDocumentUuid(project.edaWorkspace?.pcbUuid)) return project.edaWorkspace!.pcbUuid!.trim();
  return readEdaDocumentBinding(project.id)?.pcbDocumentUuid ?? '';
}
