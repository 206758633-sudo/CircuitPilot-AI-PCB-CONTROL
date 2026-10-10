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
