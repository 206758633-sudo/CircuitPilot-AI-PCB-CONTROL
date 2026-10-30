import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppProvider } from '../../state/AppContext';
import { KnowledgePage } from '../KnowledgePage';

const render = (initialTab?: 'overview' | 'rag' | 'review' | 'entries' | 'badcases' | 'contribute') => renderToStaticMarkup(<AppProvider><KnowledgePage initialTab={initialTab} /></AppProvider>);

describe('知识库功能区 UI 冒烟', () => {
  it('知识库功能区头 + 六个分区入口 + 边界声明', () => {
    const html = render();
    expect(html).toContain('知识库功能区');
    expect(html).toContain('知识 = 可追溯、可审核、可失效的工程依据');
    for (const tab of ['概览', 'RAG 检索', '审核队列', '知识条目', 'badcase', '贡献']) expect(html).toContain(tab);
    expect(html).toContain('只产 candidate');
  });

  it('概览分区：健康度 + 知识管理 Agent + 调度状态', () => {
    const html = render('overview');
    expect(html).toContain('知识库健康度');
    expect(html).toContain('知识管理 Agent（KMA）');
    expect(html).toContain('采集 badcase');
    expect(html).toContain('抓取网页知识');
  });

  it('概览分区：复盘学习 Agent（RLA）入口与边界声明', () => {
    const html = render('overview');
    expect(html).toContain('复盘学习 Agent（RLA）');
    expect(html).toContain('运行项目复盘');
    expect(html).toContain('AI 起草经验');
    expect(html).toContain('跨项目合并');
    expect(html).toContain('导出经验包');
    expect(html).toContain('由 KMA 整理');
    expect(html).toContain('人工审核');
  });

  it('RAG 分区：索引状态/重建/检索，并声明只提供依据', () => {
    const html = render('rag');
    expect(html).toContain('RAG 检索（本地混合索引）');
    expect(html).toContain('重建索引');
    expect(html).toContain('只提供依据');
  });

  it('审核队列分区：审核人 + 通过/驳回说明', () => {
    const html = render('review');
    expect(html).toContain('审核队列');
    expect(html).toContain('approved 才能进门禁引用');
    expect(html).toContain('审核人');
  });

  it('知识条目分区：类型/审核状态/可信等级/过期筛选 + 冲突检测', () => {
    const html = render('entries');
    expect(html).toContain('检索与冲突');
    expect(html).toContain('审核状态');
    expect(html).toContain('包含过期');
    expect(html).toContain('检测冲突');
  });

  it('badcase 分区与贡献分区可达', () => {
    expect(render('badcases')).toContain('badcase 候选');
    expect(render('badcases')).toContain('来自真实证据');
    expect(render('contribute')).toContain('新增候选条目');
    expect(render('contribute')).toContain('提交候选');
  });
});
