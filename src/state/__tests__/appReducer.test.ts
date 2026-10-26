import { beforeEach, describe, expect, it } from 'vitest';
import { createSeedState } from '../../data/seed';
import { appReducer, loadStoredState, STORAGE_KEY } from '../AppContext';

describe('appReducer', () => {
  beforeEach(() => localStorage.clear());

  it('creates, activates, archives and restores a project without losing history', () => {
    const initial = createSeedState();
    const project = { ...initial.projects[0], id: 'new-project', code: 'NEW-A01', name: 'New Project', archived: false };
    expect(project.stage).toBe('原理图');
    const created = appReducer(initial, { type: 'ADD_PROJECT', project });
    expect(created.activeProjectId).toBe('new-project');
    expect(created.projects[0]).toEqual(project);

    const archived = appReducer(created, { type: 'ARCHIVE_PROJECT', id: project.id, archived: true });
    expect(archived.projects.find((item) => item.id === project.id)).toMatchObject({ archived: true, stage: '归档', stageBeforeArchive: '原理图' });
    const restored = appReducer(archived, { type: 'ARCHIVE_PROJECT', id: project.id, archived: false });
    const restoredProject = restored.projects.find((item) => item.id === project.id);
    expect(restoredProject).toMatchObject({ archived: false, stage: '原理图' });
    expect(restoredProject?.stageBeforeArchive).toBeUndefined();
  });

  it('updates a requirement and reflects the confirmed state', () => {
    const initial = createSeedState();
    const suggested = initial.requirements.find((item) => item.status === 'suggested')!;
    const next = appReducer(initial, { type: 'UPDATE_REQUIREMENT', requirement: { ...suggested, status: 'confirmed' } });
    expect(next.requirements.find((item) => item.id === suggested.id)?.status).toBe('confirmed');
  });

  it('caps the audit history at 200 newest events', () => {
    let state = createSeedState();
    for (let index = 0; index < 205; index += 1) {
      state = appReducer(state, { type: 'ADD_AUDIT', event: { id: `event-${index}`, time: String(index), type: 'settings', title: 'event', detail: 'detail', status: 'info' } });
    }
    expect(state.audit).toHaveLength(200);
    expect(state.audit[0].id).toBe('event-204');
  });

  it('aggregates repeated unresolved issues by fingerprint', () => {
    const initial = createSeedState();
    const issue = { ...initial.issues[0], id: 'repeat-1', fingerprint: 'eda:BRIDGE:test', occurrences: 1 };
    const once = appReducer(initial, { type: 'REPORT_ISSUE', issue });
    const twice = appReducer(once, { type: 'REPORT_ISSUE', issue: { ...issue, id: 'repeat-2', detail: 'second occurrence', lastOccurredAt: 'later' } });
    const matches = twice.issues.filter((item) => item.fingerprint === issue.fingerprint);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ occurrences: 2, detail: 'second occurrence', lastOccurredAt: 'later' });
  });

  it('caps structured changes at 500 newest entries', () => {
    let state = createSeedState();
    for (let index = 0; index < 505; index += 1) {
      state = appReducer(state, { type: 'ADD_CHANGE', entry: { id: `change-${index}`, time: String(index), source: 'system', actor: 'test', action: 'update', objectType: 'test', objectId: String(index), summary: 'test' } });
    }
    expect(state.changes).toHaveLength(500);
    expect(state.changes[0].id).toBe('change-504');
  });

  it('tracks chat messages and suggestion decisions without changing requirements', () => {
    const initial = createSeedState();
    const message = { id: 'assistant-1', role: 'assistant' as const, content: '建议确认板厚', createdAt: 'now', status: 'complete' as const, suggestions: [{ id: 'suggestion-1', action: 'add' as const, targetRequirementId: null, category: '机械', name: '板厚', value: '1.0', unit: 'mm', kind: 'hard' as const, blocking: true, note: '待确认', status: 'pending' as const }] };
    const added = appReducer(initial, { type: 'ADD_CHAT_MESSAGE', message });
    const decided = appReducer(added, { type: 'DECIDE_CHAT_SUGGESTION', messageId: message.id, suggestionId: 'suggestion-1', status: 'accepted' });
    expect(decided.projectChats[initial.activeProjectId].messages[0].suggestions?.[0].status).toBe('accepted');
    expect(decided.requirements).toEqual(initial.requirements);
  });

  it('resets chat without clearing accepted project requirements', () => {
    const initial = createSeedState();
    const next = appReducer(initial, { type: 'RESET_CHAT', sessionId: 'chat-new' });
    expect(next.projectChats[initial.activeProjectId]).toMatchObject({ sessionId: 'chat-new', messages: [], status: 'idle' });
    expect(next.requirements).toEqual(initial.requirements);
    expect(next.components).toEqual(initial.components);
  });

  it('applies a BOM draft only to the active project and marks it applied', () => {
    const initial = createSeedState();
    const draft = { id: 'draft-1', status: 'draft' as const, title: 'AI BOM', summary: '', blockingQuestions: [], assumptions: [], items: [] };
    const withDraft = appReducer(initial, { type: 'ADD_CHAT_MESSAGE', message: { id: 'assistant-bom', role: 'assistant', content: '草案', createdAt: 'now', status: 'complete', bomDraft: draft } });
    const component = { id: 'cmp-ai', projectId: initial.activeProjectId, refdes: 'U99', mpn: 'TEST', manufacturer: 'Maker', package: 'QFN', lcscId: '', qty: 1, status: 'pending' as const, value: 'MCU' };
    const applied = appReducer(withDraft, { type: 'APPLY_BOM_DRAFT', messageId: 'assistant-bom', components: [component], appliedAt: 'now' });
    expect(applied.components).toContainEqual(component);
    expect(applied.projectChats[initial.activeProjectId].messages[0].bomDraft?.status).toBe('applied');
  });

  it('applies a BOM draft whose owner matches the active project', () => {
    const initial = createSeedState();
    const draft = { id: 'draft-own', status: 'draft' as const, title: 'AI BOM', summary: '', blockingQuestions: [], assumptions: [], items: [], projectId: initial.activeProjectId };
    const withDraft = appReducer(initial, { type: 'ADD_CHAT_MESSAGE', message: { id: 'assistant-bom-own', role: 'assistant', content: '草案', createdAt: 'now', status: 'complete', bomDraft: draft } });
    const component = { id: 'cmp-own', projectId: initial.activeProjectId, refdes: 'U97', mpn: 'TEST', manufacturer: 'Maker', package: 'QFN', lcscId: '', qty: 1, status: 'pending' as const, value: 'MCU' };
    const applied = appReducer(withDraft, { type: 'APPLY_BOM_DRAFT', messageId: 'assistant-bom-own', components: [component], appliedAt: 'now' });
    expect(applied).not.toBe(withDraft);
    expect(applied.components).toContainEqual(component);
    expect(applied.projectChats[initial.activeProjectId].messages[0].bomDraft?.status).toBe('applied');
  });

  it('refuses to apply a BOM draft that belongs to another project', () => {
    const initial = createSeedState();
    const draft = { id: 'draft-foreign', status: 'draft' as const, title: 'AI BOM', summary: '', blockingQuestions: [], assumptions: [], items: [], projectId: 'motor-node' };
    const withDraft = appReducer(initial, { type: 'ADD_CHAT_MESSAGE', message: { id: 'assistant-bom-foreign', role: 'assistant', content: '草案', createdAt: 'now', status: 'complete', bomDraft: draft } });
    const component = { id: 'cmp-foreign', projectId: initial.activeProjectId, refdes: 'U98', mpn: 'TEST', manufacturer: 'Maker', package: 'QFN', lcscId: '', qty: 1, status: 'pending' as const, value: 'MCU' };
    const blocked = appReducer(withDraft, { type: 'APPLY_BOM_DRAFT', messageId: 'assistant-bom-foreign', components: [component], appliedAt: 'now' });
    expect(blocked).toBe(withDraft);
    expect(blocked.components).toEqual(initial.components);
    expect(blocked.projectChats[initial.activeProjectId].messages[0].bomDraft?.status).toBe('draft');
  });

  it('refuses to apply a BOM draft whose message lives in another project chat', () => {
    const initial = createSeedState();
    const draft = { id: 'draft-chat', status: 'draft' as const, title: 'AI BOM', summary: '', blockingQuestions: [], assumptions: [], items: [] };
    const withDraft = appReducer(initial, { type: 'ADD_CHAT_MESSAGE', message: { id: 'assistant-bom-chat', role: 'assistant', content: '草案', createdAt: 'now', status: 'complete', bomDraft: draft } });
    const switched = appReducer(withDraft, { type: 'SET_ACTIVE_PROJECT', id: 'motor-node' });
    const component = { id: 'cmp-chat', projectId: 'motor-node', refdes: 'U96', mpn: 'TEST', manufacturer: 'Maker', package: 'QFN', lcscId: '', qty: 1, status: 'pending' as const, value: 'MCU' };
    const blocked = appReducer(switched, { type: 'APPLY_BOM_DRAFT', messageId: 'assistant-bom-chat', components: [component], appliedAt: 'now' });
    expect(blocked).toBe(switched);
    expect(blocked.projectChats[initial.activeProjectId].messages[0].bomDraft?.status).toBe('draft');
  });

  it('refuses to apply BOM components that are tagged with another project', () => {
    const initial = createSeedState();
    const draft = { id: 'draft-tag', status: 'draft' as const, title: 'AI BOM', summary: '', blockingQuestions: [], assumptions: [], items: [], projectId: initial.activeProjectId };
    const withDraft = appReducer(initial, { type: 'ADD_CHAT_MESSAGE', message: { id: 'assistant-bom-tag', role: 'assistant', content: '草案', createdAt: 'now', status: 'complete', bomDraft: draft } });
    const component = { id: 'cmp-tag', projectId: 'motor-node', refdes: 'U95', mpn: 'TEST', manufacturer: 'Maker', package: 'QFN', lcscId: '', qty: 1, status: 'pending' as const, value: 'MCU' };
    const blocked = appReducer(withDraft, { type: 'APPLY_BOM_DRAFT', messageId: 'assistant-bom-tag', components: [component], appliedAt: 'now' });
    expect(blocked).toBe(withDraft);
    expect(blocked.components).toEqual(initial.components);
  });

  it('keeps independent chat history for each selected project', () => {
    const initial = createSeedState();
    const projectA = initial.activeProjectId;
    const projectB = 'motor-node';
    const inA = appReducer(initial, { type: 'ADD_CHAT_MESSAGE', message: { id: 'a', role: 'user', content: 'A context', createdAt: 'now', status: 'complete' } });
    const switched = appReducer(inA, { type: 'SET_ACTIVE_PROJECT', id: projectB });
    const inB = appReducer(switched, { type: 'ADD_CHAT_MESSAGE', message: { id: 'b', role: 'user', content: 'B context', createdAt: 'now', status: 'complete' } });
    expect(inB.projectChats[projectA].messages.map((item) => item.content)).toEqual(['A context']);
    expect(inB.projectChats[projectB].messages.map((item) => item.content)).toEqual(['B context']);
  });

  it('deletes only the project and its dedicated chat memory', () => {
    const initial = createSeedState();
    const deletedId = initial.activeProjectId;
    const next = appReducer(initial, { type: 'DELETE_PROJECT', id: deletedId });
    expect(next.projects.some((item) => item.id === deletedId)).toBe(false);
    expect(next.projectChats[deletedId]).toBeUndefined();
    expect(next.activeProjectId).toBe('motor-node');
    expect(next.requirements).toEqual(initial.requirements);
  });
});

describe('persistence fallback', () => {
  beforeEach(() => localStorage.clear());

  it('restores a valid versioned state', () => {
    const state = createSeedState();
    state.activeProjectId = 'motor-node';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    expect(loadStoredState().activeProjectId).toBe('motor-node');
  });

  it('falls back to seed data when stored JSON is damaged', () => {
    localStorage.setItem(STORAGE_KEY, '{broken-json');
    expect(loadStoredState().schemaVersion).toBe(4);
    expect(loadStoredState().projects.length).toBeGreaterThan(0);
  });

  it('migrates a valid legacy v1 state without losing projects', () => {
    const legacy = createSeedState() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.runtime;
    delete legacy.changes;
    delete legacy.issues;
    legacy.settings = { ...(legacy.settings as object), provider: 'Codex（模拟）' };
    localStorage.setItem('circuitpilot-demo-state-v1', JSON.stringify(legacy));
    const migrated = loadStoredState();
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.projects).toHaveLength(createSeedState().projects.length);
    expect(migrated.settings.provider).toBe('demo');
    expect(migrated.issues.length).toBeGreaterThan(0);
    expect(migrated.projectChats[migrated.activeProjectId].messages).toEqual([]);
  });

  it('migrates the v3 global chat into the previously active project', () => {
    const v3 = createSeedState() as unknown as Record<string, unknown>;
    const projectChats = v3.projectChats as Record<string, unknown>;
    v3.schemaVersion = 3;
    v3.chat = { ...(projectChats['mira-sense'] as object), messages: [{ id: 'old', role: 'user', content: 'remember me', createdAt: 'now', status: 'complete' }] };
    delete v3.projectChats;
    localStorage.setItem('circuitpilot-state-v3', JSON.stringify(v3));
    const migrated = loadStoredState();
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.projectChats['mira-sense'].messages[0].content).toBe('remember me');
    expect(migrated.projectChats['motor-node'].messages).toEqual([]);
  });
});

describe('C4 输入变化自动标废批准', () => {
  const approvedTask = (state: ReturnType<typeof appReducer>) => ({
    ...state,
    task: {
      ...state.task,
      status: 'approved' as const,
      planHash: 'approved-plan-hash',
      steps: [{ id: 'step-1', title: '读取上下文', description: '读取真实 EDA 上下文', affected: ['eda'], selected: true, status: 'done' as const, risk: 'low' as const }],
    },
  });

  it('需求更新后：已批准任务退回 planned，planHash 作废并记录 invalidation', () => {
    const base = approvedTask(createSeedState());
    const requirement = base.requirements[0];
    const next = appReducer(base, { type: 'UPDATE_REQUIREMENT', requirement: { ...requirement, value: '3.3' } });
    expect(next.task.status).toBe('planned');
    expect(next.task.planHash.startsWith('invalidated-')).toBe(true);
    expect(next.task.invalidation?.trigger).toBe('requirement');
    expect(next.task.invalidation?.reason).toContain('需求');
  });

  it('器件变化同样标废；draft 状态不受影响（没有可失效的批准）', () => {
    const base = approvedTask(createSeedState());
    const component = base.components[0];
    const next = appReducer(base, { type: 'UPDATE_COMPONENT', component: { ...component, value: '10k' } });
    expect(next.task.invalidation?.trigger).toBe('component');

    const draft = createSeedState();
    expect(draft.task.status).toBe('draft');
    const after = appReducer(draft, { type: 'ADD_ASSETS', assets: [] });
    expect(after.task).toEqual(draft.task);
  });

  it('C1：服务端有业务状态时用服务端恢复（项目/需求/器件/资料整体替换）', () => {
    const initial = createSeedState();
    const project = { ...initial.projects[0], id: 'server-project', code: 'SRV-01', name: '服务端恢复项目' };
    const next = appReducer(initial, {
      type: 'HYDRATE_BUSINESS_STATE',
      state: {
        projects: [project],
        activeProjectId: 'server-project',
        requirements: [{ ...initial.requirements[0], id: 'server-req', name: '服务端需求' }],
        components: [initial.components[0]],
        assets: [],
      },
    });
    expect(next.projects).toHaveLength(1);
    expect(next.projects[0].id).toBe('server-project');
    expect(next.activeProjectId).toBe('server-project');
    expect(next.requirements[0].id).toBe('server-req');
  });

  it('C1：服务端为空时不覆盖本地项目（首次启动不清空用户正在编辑的内容）', () => {
    const initial = createSeedState();
    const next = appReducer(initial, {
      type: 'HYDRATE_BUSINESS_STATE',
      state: { projects: [], activeProjectId: '', requirements: [], components: [], assets: [] },
    });
    expect(next).toBe(initial);
  });

  it('C1：追溯三件套从 Runtime 恢复（版本/修改/审计整体替换）', () => {
    const initial = createSeedState();
    const next = appReducer(initial, {
      type: 'HYDRATE_TRACE_STATE',
      versions: [{ id: 'rv1', label: '服务端版本', kind: 'milestone', date: '2026-10-20', summary: 's', validationStatus: 'pass', requirements: 1, components: 1, designObjects: 1 }],
      changes: [{ id: 'rc1', time: '2026-10-20', source: 'runtime', actor: 'runtime', action: 'persist', objectType: 'project', objectId: 'p1', summary: '服务端修改' }],
      audit: [{ id: 'ra1', time: '2026-10-20', type: 'version', title: '服务端审计', detail: 'd', status: 'info' }],
    });
    expect(next.versions.map((item) => item.id)).toEqual(['rv1']);
    expect(next.changes.map((item) => item.id)).toEqual(['rc1']);
    expect(next.audit.map((item) => item.id)).toEqual(['ra1']);
  });

  it('C1：Runtime 追溯状态为空时不覆盖本地记录（首次启动不清空）', () => {
    const initial = createSeedState();
    const next = appReducer(initial, { type: 'HYDRATE_TRACE_STATE', versions: [], changes: [], audit: [] });
    expect(next).toBe(initial);
  });

  it('C1：activeProjectId 指向不存在的项目时回退到第一个项目', () => {
    const initial = createSeedState();
    const project = { ...initial.projects[0], id: 'only-project' };
    const next = appReducer(initial, {
      type: 'HYDRATE_BUSINESS_STATE',
      state: { projects: [project], activeProjectId: 'missing', requirements: [], components: [], assets: [] },
    });
    expect(next.activeProjectId).toBe('only-project');
  });

});

describe('C4 EDA 指纹 / Runtime 版本漂移提前标废', () => {
  const approvedWithEnv = (edaFingerprint = 'fp-aaaa-1111', runtimeVersion = '0.4.0') => {
    const base = createSeedState();
    const withEnv = appReducer(base, { type: 'PATCH_EDA', patch: { targetFingerprint: edaFingerprint } });
    const withVersion = appReducer(withEnv, { type: 'PATCH_RUNTIME', patch: { reachable: true, serviceVersion: runtimeVersion } });
    return appReducer(withVersion, { type: 'PATCH_TASK', patch: { status: 'approved', planHash: 'approved-hash', steps: [{ id: 's1', title: '计划', description: '读取', affected: ['eda'], selected: true, status: 'pending' as const, risk: 'low' as const }] } });
  };

  it('批准时绑定环境快照（EDA 指纹 + Runtime 版本）', () => {
    const state = approvedWithEnv();
    expect(state.task.boundEnv?.edaFingerprint).toBe('fp-aaaa-1111');
    expect(state.task.boundEnv?.runtimeVersion).toBe('0.4.0');
    expect(state.task.status).toBe('approved');
  });

  it('指纹未变不误伤；指纹变化后旧批准退回 planned 并记录 eda 触发器', () => {
    const state = approvedWithEnv();
    const same = appReducer(state, { type: 'CHECK_ENV_DRIFT', edaFingerprint: 'fp-aaaa-1111', runtimeVersion: '0.4.0' });
    expect(same.task.status).toBe('approved');

    const drifted = appReducer(state, { type: 'CHECK_ENV_DRIFT', edaFingerprint: 'fp-bbbb-2222', runtimeVersion: '0.4.0' });
    expect(drifted.task.status).toBe('planned');
    expect(drifted.task.planHash.startsWith('invalidated-')).toBe(true);
    expect(drifted.task.invalidation?.trigger).toBe('eda');
    expect(drifted.task.invalidation?.reason).toContain('指纹');
    expect(drifted.task.invalidation?.reason).toContain('fp-bbbb-2222');
  });

  it('Runtime 版本变化标废为 code 触发器；无绑定快照的草稿不受影响', () => {
    const state = approvedWithEnv();
    const drifted = appReducer(state, { type: 'CHECK_ENV_DRIFT', edaFingerprint: 'fp-aaaa-1111', runtimeVersion: '0.4.1' });
    expect(drifted.task.invalidation?.trigger).toBe('code');
    expect(drifted.task.invalidation?.reason).toContain('Runtime 版本');

    const draft = createSeedState();
    const after = appReducer(draft, { type: 'CHECK_ENV_DRIFT', edaFingerprint: 'fp-x', runtimeVersion: '9.9.9' });
    expect(after.task).toEqual(draft.task);
  });
});
