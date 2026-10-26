import { beforeEach, describe, expect, it } from 'vitest';
import { clearSchematicPlanDraft, clearSemanticPlanDraft, readSchematicPlanDraft, readSemanticPlanDraft, saveSchematicPlanDraft, saveSemanticPlanDraft } from './draftStore';

describe('semantic plan draft store', () => {
  beforeEach(() => { clearSemanticPlanDraft(); clearSchematicPlanDraft(); });

  it('saves a structured plan and reads it back with hash and source', () => {
    const saved = saveSemanticPlanDraft({ plan: { title: '板A', board: { widthMm: 45 } }, planHash: 'a'.repeat(16), explanation: '计划候选已生成', source: 'ai-page' });
    expect(saved.createdAt).toBeTruthy();
    const read = readSemanticPlanDraft();
    expect(read?.planHash).toBe('a'.repeat(16));
    expect(read?.plan).toEqual({ title: '板A', board: { widthMm: 45 } });
    expect(read?.source).toBe('ai-page');
  });

  it('returns null after clear and ignores corrupt payloads', () => {
    saveSemanticPlanDraft({ plan: { title: 'x' }, planHash: 'b'.repeat(16), explanation: 'e', source: 'ai-page' });
    clearSemanticPlanDraft();
    expect(readSemanticPlanDraft()).toBeNull();
    sessionStorage.setItem('circuitpilot.semantic-plan-draft', '{broken');
    expect(readSemanticPlanDraft()).toBeNull();
    sessionStorage.setItem('circuitpilot.semantic-plan-draft', JSON.stringify({ planHash: 'c' }));
    expect(readSemanticPlanDraft()).toBeNull();
  });
});

describe('schematic plan draft store', () => {
  beforeEach(() => clearSchematicPlanDraft());

  it('keeps proposal plan, hash and source label across pages, isolated from semantic drafts', () => {
    saveSemanticPlanDraft({ plan: { title: 'semantic' }, planHash: 'a'.repeat(16), explanation: 'x', source: 'ai-page' });
    saveSchematicPlanDraft({ plan: { kind: 'reviewed-netlist', title: '选型计划' }, planHash: 'f'.repeat(16), sourceLabel: '选型提案 abc123', source: 'part-proposal' });
    expect(readSchematicPlanDraft()?.sourceLabel).toBe('选型提案 abc123');
    expect(readSchematicPlanDraft()?.planHash).toBe('f'.repeat(16));
    expect(readSemanticPlanDraft()?.planHash).toBe('a'.repeat(16));
    clearSchematicPlanDraft();
    expect(readSchematicPlanDraft()).toBeNull();
    expect(readSemanticPlanDraft()).not.toBeNull();
  });

  it('ignores corrupt schematic payloads', () => {
    sessionStorage.setItem('circuitpilot.schematic-plan-draft', '{broken');
    expect(readSchematicPlanDraft()).toBeNull();
    sessionStorage.setItem('circuitpilot.schematic-plan-draft', JSON.stringify({ plan: {} }));
    expect(readSchematicPlanDraft()).toBeNull();
  });
});
