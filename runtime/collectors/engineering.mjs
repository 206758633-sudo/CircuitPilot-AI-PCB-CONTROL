import { readFileSync } from 'node:fs';
import { defineCollector } from './collect.mjs';

/**
 * 工程知识采集器（W3-08）：把需求/BOM/历史 ERC-DRC 记录沉淀为结构化候选条目。
 * - requirements → module 条目（模块/需求清单）；
 * - BOM → part 条目（位号/料号/封装，供 Librarian 复核）；
 * - 历史规则报告 → rule 条目（错误码出现次数，供规则库与回归）。
 * 只读文件；文件缺失/解析失败记入 evidence，不使整个采集器崩掉。
 */
export function createEngineeringCollector({ artifacts = {}, readFile = null, now = () => new Date() } = {}) {
  const reader = readFile || ((filePath) => readFileSync(filePath, 'utf8'));
  return defineCollector({
    id: 'engineering-artifacts',
    kind: 'module',
    source: 'engineering',
    run: async () => {
      const fetchedAt = now().toISOString();
      const items = [];
      const files = [];
      const readJson = (filePath) => {
        try {
          const content = reader(filePath);
          const parsed = JSON.parse(content);
          files.push({ path: filePath, ok: true });
          return parsed;
        } catch (error) {
          files.push({ path: filePath, ok: false, code: error?.code || 'READ_FAILED', message: String(error?.message || error).slice(0, 200) });
          return null;
        }
      };
      const provenance = (filePath) => ({ source: 'engineering', url: filePath, version: null, fetchedAt, collector: 'engineering-artifacts' });

      if (artifacts.requirements) {
        const requirements = readJson(artifacts.requirements);
        const list = Array.isArray(requirements) ? requirements : requirements?.requirements;
        if (Array.isArray(list)) {
          for (const [index, requirement] of list.entries()) {
            const moduleId = String(requirement?.id ?? requirement?.moduleId ?? `REQ-${index + 1}`);
            items.push({ kind: 'module', title: String(requirement?.name ?? requirement?.title ?? moduleId), payload: { moduleId, requirement }, provenance: provenance(artifacts.requirements), trust: 'unverified', ttlDays: null });
          }
        }
      }
      if (artifacts.bom) {
        const bom = readJson(artifacts.bom);
        const components = Array.isArray(bom) ? bom : (bom?.components ?? bom?.rows ?? []);
        for (const component of Array.isArray(components) ? components : []) {
          const lcscId = String(component?.lcscId ?? component?.supplierPart ?? '').trim();
          const mpn = String(component?.mpn ?? component?.model ?? '').trim();
          if (!lcscId && !mpn) continue;
          items.push({
            kind: 'part',
            title: mpn || lcscId,
            payload: { lcscId: lcscId || null, mpn: mpn || null, value: component?.value ?? null, footprint: component?.footprint ?? component?.package ?? null, designators: component?.designators ?? (component?.designator ? [component.designator] : []) },
            provenance: provenance(artifacts.bom), trust: 'unverified', ttlDays: null,
          });
        }
      }
      const history = Array.isArray(artifacts.history) ? artifacts.history : [];
      for (const filePath of history) {
        const report = readJson(filePath);
        const findings = Array.isArray(report?.findings) ? report.findings : (Array.isArray(report?.payload?.report?.findings) ? report.payload.report.findings : []);
        const byCode = new Map();
        for (const finding of findings) {
          const code = String(finding?.code ?? 'UNKNOWN');
          const entry = byCode.get(code) ?? { code, count: 0, severities: new Set() };
          entry.count += 1;
          entry.severities.add(String(finding?.severity ?? 'unknown'));
          byCode.set(code, entry);
        }
        for (const entry of byCode.values()) {
          items.push({
            kind: 'rule',
            title: `${entry.code}（历史记录 ${entry.count} 次）`,
            payload: { ruleId: entry.code, occurrences: entry.count, severities: [...entry.severities], sourceFile: filePath },
            provenance: provenance(filePath), trust: 'reference', ttlDays: 180,
          });
        }
      }
      return { items, evidence: { artifacts: Object.keys(artifacts).length, files, itemCount: items.length } };
    },
  });
}
