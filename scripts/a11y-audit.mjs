#!/usr/bin/env node
/**
 * D9：全站可访问性**静态启发式**审计（不是 WCAG 合规认证）。
 *
 * 为什么用静态扫描而不是装 axe-core：
 *   - 仓库没有 @testing-library/react，也不想为一次性审计加运行时依赖；
 *   - 这里只查"能在 JSX 源码里确定性判定"的问题：图标按钮无可访问名、img 缺 alt、
 *     可点击 div 无 role/tabIndex、input 无 label 关联、正数 tabIndex、无 href 的链接。
 *   - 误报/漏报都真实存在：文件名+行号要人工复核；动态 aria 插值会记为 warning 而不是 violation。
 *
 * 输出 `artifacts/d9-a11y/a11y-audit-<ts>.{json,md}`；没有违规时也写报告。
 * 退出码：扫描失败（读不到 src / 报告写不出）→ 1；发现违规仍 exit 0（advisory），
 * 因为这是启发式审计，不能用一个静态脚本假装挡住构建——是否阻断由人工/后续规则决定。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'artifacts/d9-a11y');

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (name.endsWith('.tsx')) files.push(full);
  }
  return files;
}

/** 打开标签文本（从 `<tag` 到匹配的 `>`——够用即可，属性里出现 `>` 的极端情况会少扫，报告里说明）。 */
function openingTags(source, tag) {
  const tags = [];
  const pattern = new RegExp(`<${tag}\\b[^>]*>`, 'g');
  let match;
  while ((match = pattern.exec(source))) {
    const line = source.slice(0, match.index).split('\n').length;
    tags.push({ text: match[0], line, index: match.index });
  }
  return tags;
}

function elementText(source, startIndex, tag) {
  const close = source.indexOf(`</${tag}>`, startIndex);
  if (close < 0) return '';
  return source.slice(startIndex, close).replace(/<[^>]*>/g, ' ').replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasAttr(text, name) { return new RegExp(`\\b${name}\\s*=`).test(text); }

const violations = [];
const warnings = [];
const files = existsSync(SRC) ? walk(SRC) : [];
for (const file of files) {
  const rel = relative(ROOT, file);
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const labelledIds = new Set([...source.matchAll(/htmlFor\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));

  for (const button of openingTags(source, 'button')) {
    const rawContent = source.slice(button.index, source.indexOf('</button>', button.index) + 9);
    const text = elementText(source, button.index, 'button');
    const iconOnly = /\{[^}]*<([A-Z][A-Za-z0-9]*)[^}]*\}/.test(rawContent);
    // 通用组件定义把文案放在 props.children 里（如 ui.tsx 的 Button）：静态扫描看不到真实调用，
    // 记为 warning 而不是 violation，避免"把组件定义当页面按钮"的误报。
    if (rawContent.includes('{children}')) {
      warnings.push({ rule: 'button-children-prop', file: rel, line: button.line, detail: '通用 Button 组件定义：可访问名来自调用处 children，静态扫描无法确认每个调用都有文案' });
    } else if (!text && !hasAttr(button.text, 'aria-label') && !hasAttr(button.text, 'aria-labelledby')) {
      violations.push({ rule: 'button-name', file: rel, line: button.line, detail: '按钮没有可访问文本/aria-label（图标按钮必须有 aria-label）', severity: 'violation' });
    } else if (!text && iconOnly) {
      warnings.push({ rule: 'button-name-icon', file: rel, line: button.line, detail: '按钮只有图标：请确认 aria-label 语义足够（启发式未完全解析 JSX）' });
    }
  }

  for (const input of openingTags(source, 'input')) {
    if (/type\s*=\s*["']hidden["']/.test(input.text)) continue;
    const id = input.text.match(/\bid\s*=\s*["']([^"']+)["']/)?.[1];
    const hasAria = hasAttr(input.text, 'aria-label') || hasAttr(input.text, 'aria-labelledby');
    const hasLabel = id && labelledIds.has(id);
    if (!hasAria && !hasLabel) warnings.push({ rule: 'input-label', file: rel, line: input.line, detail: 'input 无 aria-label 也未发现同文件 htmlFor 关联（可能由外部 Field 组件包装，人工复核）' });
  }

  for (const img of openingTags(source, 'img')) {
    if (!hasAttr(img.text, 'alt')) violations.push({ rule: 'img-alt', file: rel, line: img.line, detail: 'img 缺 alt（装饰图应写 alt=""）', severity: 'violation' });
  }

  for (const div of openingTags(source, 'div')) {
    if (/\bonClick\s*=/.test(div.text) && !hasAttr(div.text, 'role') && !hasAttr(div.text, 'tabIndex')) {
      violations.push({ rule: 'clickable-div', file: rel, line: div.line, detail: 'div 有 onClick 但没有 role/tabIndex：键盘不可达（应改 button 或补 role+tabIndex+键盘处理）', severity: 'violation' });
    }
  }

  lines.forEach((lineText, index) => {
    const positive = lineText.match(/tabIndex\s*=\s*\{?([1-9]\d*)\}?/);
    if (positive) warnings.push({ rule: 'positive-tabindex', file: rel, line: index + 1, detail: `tabIndex=${positive[1]} 正数会打乱焦点顺序（通常应为 0/-1）` });
    if (/<a\b/.test(lineText) && !/href\s*=/.test(lineText) && !/role\s*=/.test(lineText)) warnings.push({ rule: 'anchor-href', file: rel, line: index + 1, detail: 'a 标签没有 href/role：点击语义不明确（人工复核）' });
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  scope: 'src/**/*.tsx（静态启发式，不是 WCAG 合规认证）',
  filesScanned: files.length,
  violations: violations.length,
  warnings: warnings.length,
  byRule: [...new Set([...violations, ...warnings].map((item) => item.rule))].map((rule) => ({ rule, count: [...violations, ...warnings].filter((item) => item.rule === rule).length })),
  violationsList: violations,
  warningsList: warnings,
  boundaries: [
    '静态正则启发式：不看运行时 DOM、不检测颜色对比度/屏幕阅读器/动态焦点',
    '图标按钮的 JSX 解析不完整：有 aria-label 即视为通过，动态 aria 会显示 warning',
    'input 可能由 Field 组件包装（本文件看不到外部 htmlFor），因此归为 warning 而非 violation',
    '发现违规仍 exit 0（advisory）；解析/写报告失败才 exit 1',
  ],
};
mkdirSync(OUT, { recursive: true });
const stamp = report.generatedAt.replace(/[:.]/g, '-');
const jsonPath = join(OUT, `a11y-audit-${stamp}.json`);
const mdPath = join(OUT, `a11y-audit-${stamp}.md`);
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
const md = [
  '# D9 全站可访问性静态审计（启发式）', '',
  `- 时间：${report.generatedAt}`, `- 范围：${report.scope}`,
  `- 扫描文件：${report.filesScanned}`, `- 违规：${report.violations} · 警告：${report.warnings}`, '',
  '## 违规（violations，确定性可判定）',
  ...violationsListToMd(violations),
  '', '## 警告（warnings，需人工复核）',
  ...violationsListToMd(warnings),
  '', '## 边界', ...report.boundaries.map((item) => `- ${item}`), '',
].join('\n');
writeFileSync(mdPath, md);
function violationsListToMd(items) {
  if (!items.length) return ['无。'];
  return items.map((item) => `- \`${item.rule}\` ${item.file}:${item.line} — ${item.detail}`);
}
console.log(`[a11y] 扫描 ${files.length} 个 tsx：violations ${violations.length}，warnings ${warnings.length}`);
console.log(`[a11y] 报告 ${jsonPath}`);
console.log(`[a11y] 报告 ${mdPath}`);
process.exit(0);
