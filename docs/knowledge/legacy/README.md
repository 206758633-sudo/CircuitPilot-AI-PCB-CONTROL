# 历史条目迁移与退役记录（K7）

> 背景：K6 审计发现运行态知识库（`~/Library/Application Support/com.circuitpilot.desktop/state/knowledge`）比仓库数据集多 **84 条**不可复现条目，另有 **17 个重复 part entityKey**；其中 38 条是需求/验收被误放进 `module` kind。K7 的处理原则是：**先备份、再迁移/退役、最后以仓库数据集为唯一可复现源重建运行态**。

## 1. 备份

- 备份目录：`artifacts/evidence/knowledge-backup-k7-20261022-153136/`
- 内容：rule 87 · module 86 · part 63 · failure 48（共 284 条 JSON，原样保留）
- 恢复方式：把备份目录内容拷回运行态 `state/knowledge/`，再 `POST /api/rag/reindex`。

## 2. 迁移（保留为人类可读）

| 原条目 | 数量 | 迁移位置 | 说明 |
|---|---:|---|---|
| `PCB-R/M/F/V-*` 需求/验收（module kind） | 38 | [requirements/requirements.md](../requirements/requirements.md) | 产品需求，不是电路模块；已从知识库 kind 中迁出 |
| `ERC_ERROR/ERC_PIN_FLOATING/...` 证据规则 | 5 | 由 `SCH-RULE-ERC-*` 覆盖 | 原始证据计数无长期复用价值，退役 |
| `WEB-*` 规则/失败（Wikipedia/JLCPCB 抓取） | 7 | 由 K5 官方来源核对 + 现有规则覆盖 | `unverified`，不作为候选长期保留 |
| `CATALOG-*` 失败模式 | 10 | 由 `SCH-FAIL-*` / 现有 failure 覆盖 | 失败模式名保留在备份，避免重复条目 |
| `NETLIST-*` 具体网表缺陷 | 7 | 由 `SCH-FAIL-NET-*` 与 ERC 条目覆盖 | 具体板级证据，不适合作为通用知识 |
| 旧 BOM part（seed-k0） | 17 | 以 K1 人工策划 part 为准 | 同 LCSC 不同 payload，保留 K1 版本 |
| 其他 | 0 | — | — |

## 3. 退役规则

1. 运行态只允许保留**仓库数据集可复现**的条目；重建步骤见 §4。
2. 任何历史条目在退役前必须有备份；备份保留至少一个发布周期。
3. 审核状态仍为 candidate 的历史条目不得直接删除后“重新造一条 approved”；如需保留，按新条目重新走审核。
4. 未来新增/更新条目只通过 `knowledge/pcb/dataset/*.json` + seed 脚本进入仓库，禁止手工写运行态 JSON。

## 4. 重建命令（K7 最终态）

```bash
# 1) 备份（已执行）
cp -R "$HOME/Library/Application Support/com.circuitpilot.desktop/state/knowledge" \
      "artifacts/evidence/knowledge-backup-k7-$(date +%Y%m%d-%H%M%S)"

# 2) 清空运行态 knowledge 四类目录（只删 4 个 kind 目录，不动 usage.jsonl）
rm -rf "$HOME/Library/Application Support/com.circuitpilot.desktop/state/knowledge"/{rule,module,part,failure}

# 3) 用仓库数据集重建（API 写入仍为 candidate/reference）
node scripts/seed-knowledge-pcb.mjs --api http://127.0.0.1:4178

# 4) 重建 RAG 索引
TOKEN=$(cat /tmp/cp_app_token.txt)
curl -s -X POST -H "x-circuitpilot-token: $TOKEN" -H 'origin: tauri://localhost' \
  http://127.0.0.1:4178/api/rag/reindex

# 5) 验证
curl -s -H "x-circuitpilot-token: $TOKEN" http://127.0.0.1:4178/api/knowledge/health
```

> 注意：清空运行态前必须先确认备份存在且文件数正确（rule 87/module 86/part 63/failure 48）。API 写库不会自动清理旧文件，所以“先清空再 seed”是唯一能得到 0 重复 entityKey 的路径。

## 5. 验收

- 运行态条目数 = 数据集条目数（本轮目标 ≥196，K8/K9 完成后更高）；
- 重复 entityKey = 0；
- `conflictKeys=0` 且 `conflicts.json` 的组内规则都带 scope；
- 所有条目仍为 candidate/reference，不因重建而变成 approved。
