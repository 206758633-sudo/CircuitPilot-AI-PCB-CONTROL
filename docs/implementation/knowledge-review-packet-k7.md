# 知识审核包（K7，人工审核用）

> 目的：把“可审核的候选条目”整理成一批，交由**人类评审人**逐条给出 `approved / rejected` 与理由；AI/脚本不得自审。审核通过前，条目只能作为参考，不得被门禁引用。
> 生成时间：2026-10-22 15:48 +0800；当前运行态：353 条，`approved=0`。

## 使用方式

1. 打开 CircuitPilot「知识库 → 审核队列」，或按条目 ID 查 `GET /api/knowledge/entries?query=<id>`；文档在 `doc` 字段路径。
2. 逐条核对：**判据是否可判定、数值是否有依据、scope 是否写清、是否与冲突登记表一致、是否有编造/过度承诺**。
3. 审核通过（仅限人类评审人）：
   ```bash
   TOKEN=$(cat /tmp/cp_app_token.txt)
   curl -s -X POST -H "x-circuitpilot-token: $TOKEN" -H 'content-type: application/json' \
     -H 'origin: tauri://localhost' \
     -d '{"state":"approved","reviewedBy":"<你的姓名>"}' \
     http://127.0.0.1:4178/api/knowledge/entries/<entryId>/review
   ```
   驳回用 `"state":"rejected"`，理由写进评审记录。
4. 审核后跑 `node scripts/verify-rag.mjs` 与 `node scripts/seed-knowledge-pcb.mjs --check`，确认没有把候选误当门禁。

## 建议首批（20 条）

| kind | 业务 ID | entryId（审核 API 用） | 标题 | 文档 |
|---|---|---|---|---|
| rule | `SCH-RULE-ERC-001` | `kn-rule-89f7969fc3ed6e90` | ERC 告警必须三态归属：已修 / 有依据豁免 / 待复核 | `docs/knowledge/schematic/06-erc-review-checklist.md` |
| rule | `PCB-RULE-REL-DERATING-001` | `kn-rule-e996ddaea2bc792a` | 降额门禁：每个功率/高压/大电流器件必须算应力比并签核超限项 | `docs/knowledge/pcb/09-reliability-derating.md` |
| rule | `PCB-RULE-TEST-COVERAGE-001` | `kn-rule-ada33e93f9fd96e9` | 可测网络覆盖率门禁：关键网络 100%，整体建议 ≥95% | `docs/knowledge/pcb/10-testability-production-test.md` |
| rule | `PCB-RULE-SAFE-CREEPAGE-001` | `kn-rule-407be76f69eba7a2` | 爬电/间隙按标准表计算：四输入齐全并留裕量，隔离带禁跨接 | `docs/knowledge/pcb/11-safety-certification.md` |
| rule | `PCB-RULE-HS-IMPEDANCE-001` | `kn-rule-9e59a15937f46e09` | 高速链路阻抗：按协议定 85/90/100 Ω，TDR 验收并做测试条 | `docs/knowledge/pcb/14-high-speed-protocols.md` |
| rule | `PCB-RULE-FLEX-BEND-001` | `kn-rule-b015c617d07117ab` | 柔性板弯折半径：静态 6–10 倍总厚、动态 20–100 倍总厚，最终以弯折寿命实测为准 | `docs/knowledge/pcb/12-flex-rigid-flex.md` |
| rule | `PCB-RULE-PKG-BGA-VOID-001` | `kn-rule-875e4da2b7a15ea9` | BGA 空洞验收：按单球面积百分比与位置判定，不只看「有没有空洞」 | `docs/knowledge/pcb/13-package-assembly-rework.md` |
| rule | `SCH-RULE-RF-001` | `kn-rule-0748ebbf14bd0f60` | 天线净空禁布区：keepout 内不得有铜/走线/器件/金属 | `docs/knowledge/schematic/11-rf-antenna.md` |
| rule | `SCH-RULE-PWR-001` | `kn-rule-6598d2e05e6d30bb` | 多相 Buck 均流误差与相位一致性要求 | `docs/knowledge/schematic/12-power-topologies.md` |
| rule | `CMP-RULE-LIB-001` | `kn-rule-97d51deba74ca106` | 符号/封装/焊盘三源核验：引脚号三者必须一致 | `docs/knowledge/components/12-library-management.md` |
| module | `PCB-MOD-REL-DERATING` | `kn-module-d6b91f8048b8caec` | 降额与应力比设计流程 | `docs/knowledge/pcb/09-reliability-derating.md` |
| module | `PCB-MOD-DFT-ICT` | `kn-module-c30df9c76737b576` | 测试点与 ICT 治具设计 | `docs/knowledge/pcb/10-testability-production-test.md` |
| module | `SCH-MOD-BMS-1S-PROTECT` | `kn-module-4c6e0603b9d27be9` | 1S 锂电保护板：OVP/UVP/OCP/SCP/OTP 与双 MOS | `docs/knowledge/schematic/10-battery-bms.md` |
| module | `SCH-MOD-RF-001` | `kn-module-1eb733be5b8b833a` | 2.4GHz 匹配网络与巴伦前端 | `docs/knowledge/schematic/11-rf-antenna.md` |
| module | `CMP-MOD-SC-001` | `kn-module-40872578dd120333` | 供应链风险看板与生命周期管理（状态/PCN/交期/库存/单点） | `docs/knowledge/components/11-supply-chain.md` |
| failure | `PCB-FAIL-REL-DERATE-OVER` | `kn-failure-1329d1b0df7f5bb1` | 降额不足导致高温满载过热/寿命不足 | `docs/knowledge/pcb/09-reliability-derating.md` |
| failure | `PCB-FAIL-TEST-COVERAGE-GAP` | `kn-failure-d94469e9b6f14c20` | 测试覆盖缺口导致不良流出到客户 | `docs/knowledge/pcb/10-testability-production-test.md` |
| failure | `PCB-FAIL-SAFE-CREEPAGE` | `kn-failure-d8668d2b6869beab` | 爬电距离不足/隔离带被跨越导致打火与耐压击穿 | `docs/knowledge/pcb/11-safety-certification.md` |
| failure | `SCH-FAIL-RF-001` | `kn-failure-943f7be26117d1ed` | 天线净空被铜/电池破坏导致失谐与效率下降 | `docs/knowledge/schematic/11-rf-antenna.md` |
| failure | `CMP-FAIL-LIB-001` | `kn-failure-bd1605894106cb04` | 符号/封装 pin map 不一致导致反装、直通或整批报废 | `docs/knowledge/components/12-library-management.md` |


## 审核判定口径

- **通过**：判据/数值/依据三者可追溯，scope 与冲突登记一致，未夸大“保证通过认证/保证可靠”。
- **驳回**：数值无来源、把经验值写成标准强制值、doc 不存在、ID/entityKey 冲突、与已登记冲突组口径矛盾。
- **挂起**：需要 datasheet/标准原文/实测数据，当前证据不足；挂起条目保持 candidate。

## 注意

- 审核动作会改运行态 `review.state`，但不会改仓库数据集；仓库状态以 `knowledge/pcb/dataset/*.json` 为准，重新 seed 会把运行态回到 candidate。若要长期保留 approved，需要同时把审核结论落库/落评审记录（K7 尚未做审核结果回写仓库，属后续治理项）。
- 57 条 part 中仅 5 条 `lcscIdVerified=true`，其余 52 条为待核验；**不得**把待核验料号直接用于生产 BOM。
