import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG, groupedProviderOptions, isAccountProvider, isApiProvider, modelOptions, providerEntry, providerLabel, providerOptions } from '../providerCatalog';
import type { ProviderSummary } from '../../types';

const summary = (patch: Partial<ProviderSummary> & { id: ProviderSummary['id'] }): ProviderSummary => ({ label: patch.id, kind: 'api', ready: false, configured: false, ...patch });

describe('providerCatalog', () => {
  it('每个 ProviderId 只声明一次，且都有标签、说明与分组', () => {
    const ids = PROVIDER_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('demo');
    for (const entry of PROVIDER_CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.group.length).toBeGreaterThan(0);
    }
  });

  it('第三方 API 平台都有独立申请入口与模型建议', () => {
    const apiEntries = PROVIDER_CATALOG.filter((entry) => entry.kind === 'api');
    expect(apiEntries.length).toBeGreaterThanOrEqual(12);
    for (const entry of apiEntries) {
      expect(entry.keyUrl, `${entry.id} 缺少 Key 申请入口`).toMatch(/^https:\/\//);
      expect(entry.models.length, `${entry.id} 缺少模型建议`).toBeGreaterThan(0);
    }
  });

  it('国内平台与国际平台都被登记，且分组顺序固定', () => {
    const groups = groupedProviderOptions([]);
    expect(groups.map((item) => item.group)).toEqual(['本地与官方账号', '国内平台 API', '国际平台 API']);
    expect(groups.flatMap((item) => item.entries).map((entry) => entry.id)).toEqual(PROVIDER_CATALOG.map((entry) => entry.id));
    for (const id of ['deepseek_api', 'moonshot_api', 'zhipu_api', 'dashscope_api', 'siliconflow_api']) {
      expect(providerEntry(id)?.group).toBe('国内平台 API');
    }
    for (const id of ['openai_api', 'anthropic_api', 'gemini_api', 'openrouter_api', 'xai_api', 'groq_api', 'mistral_api']) {
      expect(providerEntry(id)?.group).toBe('国际平台 API');
    }
  });

  it('模型选项始终包含 auto，并保留目录外的已保存值', () => {
    expect(modelOptions('deepseek_api', 'auto')).toEqual(['auto', 'deepseek-chat', 'deepseek-reasoner']);
    expect(modelOptions('deepseek_api', 'custom-model-v9')).toEqual(['auto', 'deepseek-chat', 'deepseek-reasoner', 'custom-model-v9']);
    expect(modelOptions('demo', 'auto')).toEqual(['auto']);
    expect(modelOptions('unknown-provider', 'gpt-5.6-terra')).toEqual(['auto', 'gpt-5.6-terra']);
  });

  it('runtime 上报的前端未知 Provider 也要能出现在选项里', () => {
    const options = providerOptions([summary({ id: 'brand_new_api' as ProviderSummary['id'], label: 'Brand New Platform' })]);
    const extra = options.find((entry) => (entry.id as string) === 'brand_new_api');
    expect(extra?.label).toBe('Brand New Platform');
    expect(extra?.group).toBe('国际平台 API');
    // CLI 型未知 Provider 归到官方账号分组，避免出现 "其它" 这种不可预期的分组。
    const cliOptions = providerOptions([summary({ id: 'brand_new_cli' as ProviderSummary['id'], label: 'Brand CLI', kind: 'cli' })]);
    expect(cliOptions.find((entry) => (entry.id as string) === 'brand_new_cli')?.group).toBe('本地与官方账号');
  });

  it('runtime 上报的标签优先于本地目录，未知 id 有安全兜底', () => {
    const options = providerOptions([summary({ id: 'deepseek_api', label: 'DeepSeek（Runtime 标签）' })]);
    expect(options.find((entry) => entry.id === 'deepseek_api')?.label).toBe('DeepSeek（Runtime 标签）');
    expect(providerLabel('brand_new_api')).toBe('brand_new_api');
    expect(providerEntry('brand_new_api')).toBeUndefined();
    expect(isApiProvider('deepseek_api')).toBe(true);
    expect(isAccountProvider('codex_account')).toBe(true);
    expect(isApiProvider('unknown')).toBe(false);
    expect(isAccountProvider('unknown')).toBe(false);
  });
});
