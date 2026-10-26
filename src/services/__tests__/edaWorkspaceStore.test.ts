import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearEdaDocumentBinding,
  isEdaDocumentUuid,
  readEdaDocumentBinding,
  resolvePcbDocumentUuid,
  saveEdaDocumentBinding,
  type EdaDocumentBinding,
} from '../edaWorkspaceStore';

const KEY = 'circuitpilot-eda-docs-v1';
const DOC_A = 'aaaabbbbccccdddd';
const DOC_B = '1111222233334444';

describe('D7 EDA 文档绑定按项目持久化', () => {
  beforeEach(() => localStorage.clear());

  it('按项目隔离写入/读取，刷新（重新读取）仍一致', () => {
    expect(saveEdaDocumentBinding('proj-a', DOC_A)).toMatchObject({ pcbDocumentUuid: DOC_A });
    saveEdaDocumentBinding('proj-b', DOC_B);
    expect(readEdaDocumentBinding('proj-a')).toMatchObject({ pcbDocumentUuid: DOC_A });
    expect(readEdaDocumentBinding('proj-b')).toMatchObject({ pcbDocumentUuid: DOC_B });
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { byProject: Record<string, EdaDocumentBinding> };
    expect(raw.byProject['proj-a'].pcbDocumentUuid).toBe(DOC_A);
  });

  it('非法 UUID 不落盘，并删除该项目旧值（防止刷新后回到错板）', () => {
    saveEdaDocumentBinding('proj-a', DOC_A);
    expect(saveEdaDocumentBinding('proj-a', 'destroys-everything')).toBeNull();
    expect(readEdaDocumentBinding('proj-a')).toBeNull();
    expect(isEdaDocumentUuid('de4911bced17666d')).toBe(true);
    expect(isEdaDocumentUuid('')).toBe(false);
  });

  it('解析优先级：项目 EDA 绑定 > 本机按项目记忆 > 空串（绝不跨项目）', () => {
    saveEdaDocumentBinding('proj-a', DOC_B);
    expect(resolvePcbDocumentUuid({ id: 'proj-a' })).toBe(DOC_B);
    expect(resolvePcbDocumentUuid({ id: 'proj-a', edaWorkspace: { pcbUuid: DOC_A } })).toBe(DOC_A);
    expect(resolvePcbDocumentUuid({ id: 'proj-c' })).toBe('');
    expect(resolvePcbDocumentUuid(null)).toBe('');
  });

  it('损坏/异常存储回退空值；删除项目绑定后不再出现', () => {
    localStorage.setItem(KEY, '{not-json');
    expect(readEdaDocumentBinding('proj-a')).toBeNull();
    saveEdaDocumentBinding('proj-a', DOC_A);
    clearEdaDocumentBinding('proj-a');
    expect(readEdaDocumentBinding('proj-a')).toBeNull();
  });
});
