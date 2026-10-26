/**
 * 项目/需求业务状态的服务端持久化（C1）。
 *
 * 问题：项目、需求、器件、资料这些"用户真正的工作内容"过去只存在浏览器 localStorage，
 * 换浏览器/清缓存/换机器就没了；Runtime 侧没有任何项目管理接口，审计也只有前端内存。
 *
 * 本模块只做**业务状态**的 fail-closed 校验与落盘：
 *   - 校验失败（形状不对、id 重复、activeProjectId 指向不存在的项目）一律 400，不静默"修正"；
 *   - 原子写（tmp+rename）由 store 保证，损坏/版本不匹配抛 STORE_*，不假装读成功；
 *   - 这是用户数据不是 EDA 写板，不需要写板批准，但仍要求 Runtime 会话令牌。
 */
import { createJsonStore } from './store.mjs';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_STATE_CODES = {
  INVALID: 'PROJECT_STATE_INVALID',
  NOT_FOUND: 'PROJECT_STATE_NOT_FOUND',
};

/** 项目 id 同时用作状态文件名：只允许安全字符，路径穿越/空白一律拒绝（fail-closed）。 */
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const projectIdOf = (value) => String(value ?? '').trim();
export function assertProjectId(projectId) {
  const id = projectIdOf(projectId);
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw Object.assign(new Error(`项目 id 非法：只允许字母数字开头、字母数字/下划线/连字符，最长 64 字符（收到 ${JSON.stringify(String(projectId ?? '').slice(0, 80))}）`), {
      code: PROJECT_STATE_CODES.INVALID, details: { field: 'projectId' },
    });
  }
  return id;
}

const asArray = (value) => (Array.isArray(value) ? value : null);
const text = (value) => String(value ?? '').trim();

/** 校验并归一化业务状态；失败抛 PROJECT_STATE_INVALID（带可读 details）。 */
export function normalizeProjectState(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('项目状态必须是对象'), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'state' } });
  }
  const projects = asArray(input.projects);
  const requirements = asArray(input.requirements);
  const components = input.components === undefined ? [] : asArray(input.components);
  const assets = input.assets === undefined ? [] : asArray(input.assets);
  if (!projects) throw Object.assign(new Error('projects 必须是数组'), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'projects' } });
  if (!requirements) throw Object.assign(new Error('requirements 必须是数组'), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'requirements' } });
  if (!components) throw Object.assign(new Error('components 必须是数组'), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'components' } });
  if (!assets) throw Object.assign(new Error('assets 必须是数组'), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'assets' } });
  const projectIds = new Set();
  for (const project of projects) {
    const id = text(project?.id);
    if (!id) throw Object.assign(new Error('项目缺少 id'), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'projects[].id' } });
    if (projectIds.has(id)) throw Object.assign(new Error(`项目 id 重复：${id}`), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'projects[].id', id } });
    projectIds.add(id);
  }
  const activeProjectId = input.activeProjectId === null || input.activeProjectId === undefined ? null : text(input.activeProjectId);
  if (activeProjectId !== null && activeProjectId !== '' && !projectIds.has(activeProjectId)) {
    throw Object.assign(new Error(`activeProjectId 指向不存在的项目：${activeProjectId}`), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'activeProjectId', activeProjectId } });
  }
  const requirementIds = new Set();
  for (const requirement of requirements) {
    const id = text(requirement?.id);
    if (!id) throw Object.assign(new Error('需求缺少 id'), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'requirements[].id' } });
    if (requirementIds.has(id)) throw Object.assign(new Error(`需求 id 重复：${id}`), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'requirements[].id', id } });
    requirementIds.add(id);
  }
  return {
    projects,
    activeProjectId: activeProjectId || null,
    requirements,
    components,
    assets,
    schemaVersion: 1,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : new Date().toISOString(),
  };
}

/** 业务状态存储：读失败抛 STORE_*；写前必须 normalizeProjectState。 */
export function createProjectStateStore({ file } = {}) {
  const store = createJsonStore({
    file,
    schemaVersion: 1,
    initial: () => ({ projects: [], activeProjectId: null, requirements: [], components: [], assets: [], updatedAt: null }),
  });
  const read = () => {
    const loaded = store.load();
    return { state: loaded.data, savedAt: loaded.savedAt };
  };
  const replace = (input) => {
    const state = normalizeProjectState(input);
    const saved = store.save(state);
    return { state, savedAt: saved.savedAt };
  };
  return { file: store.file, read, replace };
}

/**
 * C6 项目级切片（读取侧）：从聚合状态里取出**单个项目**的视图。
 *
 * 隔离规则（宁可少给不可多给）：
 *   - projects：只给目标项目本身；
 *   - requirements/assets：给了 projectId 的按项目过滤；**没给 projectId 的历史数据只在"它就是当前项目"时包含**，
 *     否则不放进任何切片（避免把 A 的历史需求塞给 B）；
 *   - components：按 projectId 过滤（无 projectId 的旧数据同 requirements 规则）。
 */
export function sliceProjectState(state, projectId) {
  const id = assertProjectId(projectId);
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const project = projects.find((item) => item?.id === id);
  if (!project) return null;
  const belongs = (item) => {
    const tagged = projectIdOf(item?.projectId);
    if (tagged) return tagged === id;
    return projectIdOf(state?.activeProjectId) === id;
  };
  return {
    projects: [project],
    activeProjectId: id,
    requirements: (Array.isArray(state?.requirements) ? state.requirements : []).filter(belongs),
    components: (Array.isArray(state?.components) ? state.components : []).filter(belongs),
    assets: (Array.isArray(state?.assets) ? state.assets : []).filter(belongs),
    updatedAt: state?.updatedAt ?? null,
  };
}

/**
 * C6 项目级切片（写入侧）：校验并**强制打标**。
 *
 * - activeProjectId 必须等于路径项目 id（不允许借 A 的路径写 B 的 active 状态）；
 * - projects 里必须包含目标项目，且不能夹带其它项目的业务数据；
 * - requirements/assets/components 一律补/校验 projectId = 路径项目 id；已有其它项目标签 → 400（不静默改归属）。
 */
export function normalizeProjectSlice(input = {}, projectId) {
  const id = assertProjectId(projectId);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('项目状态必须是对象'), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'state' } });
  }
  const projects = asArray(input.projects);
  if (!projects) throw Object.assign(new Error('projects 必须是数组'), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'projects' } });
  if (!projects.some((item) => item?.id === id)) {
    throw Object.assign(new Error(`切片里必须包含项目 ${id}`), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'projects[].id', projectId: id } });
  }
  if (input.activeProjectId !== undefined && input.activeProjectId !== null && projectIdOf(input.activeProjectId) !== id) {
    throw Object.assign(new Error(`activeProjectId 必须是 ${id}（收到 ${String(input.activeProjectId)}）：不允许借别的项目路径写当前状态`), {
      code: PROJECT_STATE_CODES.INVALID, details: { field: 'activeProjectId', expected: id },
    });
  }
  let tagged = 0;
  const tag = (list, field) => {
    if (list === undefined) return [];
    const array = asArray(list);
    if (!array) throw Object.assign(new Error(`${field} 必须是数组`), { code: PROJECT_STATE_CODES.INVALID, details: { field } });
    return array.map((item, index) => {
      const current = projectIdOf(item?.projectId);
      if (current && current !== id) {
        throw Object.assign(new Error(`${field}[${index}] 属于项目 ${current}，不能通过项目 ${id} 的切片写入`), {
          code: PROJECT_STATE_CODES.INVALID, details: { field: `${field}[${index}].projectId`, expected: id, actual: current },
        });
      }
      if (!current) tagged += 1;
      return { ...item, projectId: id };
    });
  };
  const requirements = tag(input.requirements, 'requirements');
  const components = tag(input.components, 'components');
  const assets = tag(input.assets, 'assets');
  const normalized = normalizeProjectState({ projects: projects.filter((item) => item?.id === id), activeProjectId: id, requirements, components, assets, updatedAt: input.updatedAt });
  return { state: normalized, tagged };
}

/** 项目级状态存储：每项目一个 JSON 文件（stateDir/project-states/<id>.json），互不覆盖。 */
export function createProjectScopedStore({ dir, legacyStore = null } = {}) {
  const root = projectIdOf(dir);
  if (!root) throw Object.assign(new Error('项目状态目录不能为空'), { code: PROJECT_STATE_CODES.INVALID, details: { field: 'dir' } });
  const stores = new Map();
  const fileFor = (projectId) => join(root, `${assertProjectId(projectId)}.json`);
  const storeFor = (projectId) => {
    const file = fileFor(projectId);
    if (!stores.has(file)) {
      stores.set(file, createJsonStore({
        file,
        schemaVersion: 1,
        initial: () => ({ projects: [], activeProjectId: assertProjectId(projectId), requirements: [], components: [], assets: [], updatedAt: null }),
      }));
    }
    return stores.get(file);
  };
  const read = (projectId) => {
    const id = assertProjectId(projectId);
    const loaded = storeFor(id).load();
    const hasOwnData = Array.isArray(loaded.data?.projects) && loaded.data.projects.some((item) => item?.id === id);
    if (hasOwnData) return { projectId: id, state: loaded.data, savedAt: loaded.savedAt, source: 'project' };
    if (!legacyStore) return { projectId: id, state: null, savedAt: null, source: 'missing' };
    let legacy = null;
    try { legacy = legacyStore.read().state; } catch { legacy = null; }
    const slice = legacy ? sliceProjectState(legacy, id) : null;
    if (!slice) return { projectId: id, state: null, savedAt: null, source: 'missing' };
    return { projectId: id, state: slice, savedAt: null, source: 'legacy-migration' };
  };
  const replace = (projectId, input) => {
    const id = assertProjectId(projectId);
    const prepared = normalizeProjectSlice(input, id);
    const saved = storeFor(id).save(prepared.state);
    return { projectId: id, state: prepared.state, savedAt: saved.savedAt, tagged: prepared.tagged };
  };
  const list = () => {
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const projectId = name.slice(0, -'.json'.length);
        if (!PROJECT_ID_PATTERN.test(projectId)) return null;
        try {
          const loaded = storeFor(projectId).load();
          return {
            projectId,
            savedAt: loaded.savedAt,
            requirements: loaded.data?.requirements?.length ?? 0,
            components: loaded.data?.components?.length ?? 0,
            assets: loaded.data?.assets?.length ?? 0,
          };
        } catch (error) {
          return { projectId, savedAt: null, error: String(error?.code || error?.message || error).slice(0, 120) };
        }
      })
      .filter(Boolean);
  };
  return { dir: root, read, replace, list };
}
