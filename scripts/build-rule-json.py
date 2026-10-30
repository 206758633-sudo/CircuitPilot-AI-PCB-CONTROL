#!/usr/bin/env python3
"""从 docs/pcb-layout/02|03 的规则表机械抽取规则，生成 rules/board-layout-rules.json。
用法：python3 scripts/build-rule-json.py
规则以文档为唯一事实源；本脚本只做抽取与连续性校验，不修改文档。"""
import re, json, sys, pathlib, hashlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = ROOT / 'docs' / 'pcb-layout'
FILES = [('02-设计规则A-机械占位连接器RF.md', 'A'), ('03-设计规则B-电气丝印制造装配.md', 'B')]
GROUPS = {'MECH': '机械/板框/拼板/边缘', 'SPACE': '占位与禁止叠放',
          'ZCLR': 'Z 轴装配净空/高度', 'CONN': '连接器朝向与插拔空间',
          'RF': '天线与射频', 'PWR': '电源/去耦/热', 'MOVE': '布局变更影响',
          'SILK': '丝印', 'DFM': '可制造性',
          'DFA': '可装配/可测试', 'PRJ': '工程与交付一致性',
          'GATE': '放行门禁'}
def sha256_of(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

rules, seen, problems = [], set(), []
for fn, _tag in FILES:
    for line in (BASE / fn).read_text(encoding='utf-8').split('\n'):
        if not line.startswith('|'):
            continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) < 7:
            continue
        m = re.match(r'^([A-Z]{2,5})-(\d{2})$', cells[0])
        if not m or m.group(1) not in GROUPS:
            continue
        rid, grp, no = cells[0], m.group(1), int(m.group(2))
        if rid in seen:
            problems.append('重复编号 ' + rid); continue
        seen.add(rid)
        rules.append({'id': rid, 'group': grp, 'groupName': GROUPS[grp], 'no': no,
                      'name': cells[1], 'level': cells[2], 'value': cells[3],
                      'check': cells[4], 'basis': cells[5], 'scope': cells[6], 'source': fn})
order = list(GROUPS)
rules.sort(key=lambda r: (order.index(r['group']), r['no']))
counts = {}
for r in rules:
    counts[r['group']] = counts.get(r['group'], 0) + 1
for g in counts:
    ns = sorted(r['no'] for r in rules if r['group'] == g)
    if ns != list(range(1, len(ns) + 1)):
        problems.append(f'{g} 编号不连续: {ns}')
lvl = {}
for r in rules:
    lvl[r['level']] = lvl.get(r['level'], 0) + 1
doc = {
    'title': 'PCB 布局设计规则集（ESP32 测试板 ≈70×48 mm；含 Z 轴装配净空、布局变更影响、工程与交付一致性）', 'version': '1.2.0',
    'generatedFrom': 'scripts/build-rule-json.py',
    'sourceHashes': {fn: sha256_of(BASE / fn) for fn, _tag in FILES},
    'generatedFor': 'CircuitPilot AI-PCBA',
    'board': {'widthMm': 70, 'heightMm': 48, 'thicknessMm': 1.6, 'layers': 4, 'copperOz': 1,
              'scaleNote': '板框为图像估算值（≈24 px/mm，±10%），以 EDA 板框层为准'},
    'legend': {'level': {'硬门禁': '违反即阻断投产', '推荐': '不阻断，但需书面签核接受理由'},
               'basis': {'IPC-2221B': '通用设计标准（载流/间距/热）', 'IPC-7351B': '焊盘与 courtyard 标准',
                         'JLC': '板厂工艺能力默认值，以确认单为准', 'EXP': '工程经验值', 'DS': '器件 datasheet'}},
    'groupIdOrder': order, 'groupNames': GROUPS, 'counts': counts, 'levelCounts': lvl,
    'total': len(rules),
    'usage': '由 scripts/build-rule-json.py 从 02/03 号文档规则表机械抽取；修改规则请改文档后重跑本脚本。01/04 号文档通过 id 引用。',
    'validation': {'duplicateOrGap': problems or 'none', 'rulesParsed': len(rules)},
    'rules': rules,
}
# 两份拷贝，内容一致：
#   1. rules/board-layout-rules.json —— 文档评审与外部工具用的稳定路径；
#   2. runtime/engineering/rules/board-layout-rules.json —— 运行时唯一数值来源（sidecar 只打包 runtime/）。
# 两份都由本脚本生成，禁止手改任何一份，否则规则文档与判定会悄悄分叉。
doc['documents'] = {
    'diagnosis': 'docs/pcb-layout/01-布局诊断.md',
    'rulesA': 'docs/pcb-layout/02-设计规则A-机械占位连接器RF.md',
    'rulesB': 'docs/pcb-layout/03-设计规则B-电气丝印制造装配.md',
    'checklist': 'docs/pcb-layout/04-规则落地校验清单.md',
    'integration': 'docs/implementation/pcba-layout-rules-integration.md',
}
doc['canonicalRuntimeCopy'] = True
public = {k: v for k, v in doc.items() if k != 'canonicalRuntimeCopy'}
for target in (ROOT / 'rules' / 'board-layout-rules.json', ROOT / 'runtime' / 'engineering' / 'rules' / 'board-layout-rules.json'):
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(doc if target.parent.parent.name == 'engineering' else public, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
tmp = doc.pop('canonicalRuntimeCopy', None)
# 04 号文档「规则全集索引」自动重写：分组 → (文档号, 章节)
INDEX_DOC = {'MECH': ('02', '1'), 'SPACE': ('02', '2'), 'ZCLR': ('02', '7'),
             'CONN': ('02', '3'), 'RF': ('02', '4'),
             'PWR': ('03', '1'), 'MOVE': ('03', '8'), 'SILK': ('03', '2'),
             'DFM': ('03', '3'), 'DFA': ('03', '4'), 'PRJ': ('03', '9'),
             'GATE': ('03', '5')}


def rewrite_group_table(doc04: pathlib.Path, rules, counts, lvl):
    """把 04 号文档 §0.3「规则分组与条数」表按规则包重写（防文档/JSON 分叉）。"""
    text = doc04.read_text(encoding='utf-8')
    header = '| 组 | 条数 | 硬门禁 / 推荐 | 文档 |'
    if header not in text:
        return False
    per = {}
    for r in rules:
        bucket = per.setdefault(r['group'], {'硬门禁': 0, '推荐': 0})
        bucket[r['level']] = bucket.get(r['level'], 0) + 1
    rows = [header, '| --- | --- | --- | --- |']
    for group in order:
        if group not in counts:
            continue
        doc_no, sec = INDEX_DOC[group]
        rows.append('| %s %s | %d | %d / %d | `%s` §%s |' % (
            group, GROUPS[group], counts[group], per[group].get('硬门禁', 0), per[group].get('推荐', 0), doc_no, sec))
    rows.append('| **合计** | **%d** | **%d / %d** | — |' % (len(rules), lvl.get('硬门禁', 0), lvl.get('推荐', 0)))
    pattern = re.compile(r'\| 组 \| 条数 \| 硬门禁 / 推荐 \| 文档 \|.*?\| \*\*合计\*\* \|[^\n]*\n', re.S)
    if not pattern.search(text):
        return False
    text = pattern.sub('\n'.join(rows) + '\n', text, count=1)
    doc04.write_text(text, encoding='utf-8')
    return True


def rewrite_index(doc04: pathlib.Path, rules, counts, lvl):
    """把 04 号文档 RULE_INDEX 区块按规则包重写，防止文档与 JSON 分叉。"""
    text = doc04.read_text(encoding='utf-8')
    start, end = '<!-- RULE_INDEX_START -->', '<!-- RULE_INDEX_END -->'
    if start not in text or end not in text:
        return False
    head = text.split(start)[0]
    tail = text.split(end, 1)[1]
    lines = [start, '', '> 本区块由 `python3 scripts/build-rule-json.py` 自动重写，请勿手改；编号/名称/等级以规则包为准。', '']
    for group in order:
        grp_rules = [r for r in rules if r['group'] == group]
        if not grp_rules:
            continue
        doc_no, sec = INDEX_DOC[group]
        lines.append('**%s · %s（%d 条）**' % (group, GROUPS[group], len(grp_rules)))
        lines.append('')
        lines.append('| 编号 | 名称 | 等级 | 文档 |')
        lines.append('| --- | --- | --- | --- |')
        for r in grp_rules:
            lines.append('| %s | %s | %s | `%s` §%s |' % (r['id'], r['name'], r['level'], doc_no, sec))
        lines.append('')
    doc04.write_text(head + '\n'.join(lines) + tail, encoding='utf-8')
    return True

if rewrite_index(BASE / '04-规则落地校验清单.md', rules, counts, lvl):
    print('04 号文档规则索引已重写')
if rewrite_group_table(BASE / '04-规则落地校验清单.md', rules, counts, lvl):
    print('04 号文档分组条数表已重写')
print(json.dumps({'counts': counts, 'levels': lvl, 'total': len(rules), 'problems': problems or 'none'}, ensure_ascii=False))
