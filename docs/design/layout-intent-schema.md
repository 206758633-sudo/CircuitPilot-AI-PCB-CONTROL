# 布局设计意图 JSON（schemaVersion 1）

规则引擎只能判“有数据的部分”。2D 包围盒推不出连接器开口方向、天线端朝向、去耦配对、
测试点/按键空间、ESD 器件拓扑，这些必须由设计意图显式声明；**缺声明 = REVIEW，声明错 = 拒绝**。

校验器：`runtime/engineering/layout-intent.mjs`
合并器：`buildPlacementAuditInput({ intent })` / `auditPlacementPlan({ intent })`
真机 CLI：

```bash
node scripts/bridge-layout-audit.mjs \
  --open-uuid <pcbUuid> \
  --design artifacts/pcb-layout/design-intent.json \
  --out artifacts/pcb-layout/layout-audit.json
```

产品接线：
- `POST /api/eda/pcb/placement/plan|apply` 支持 `designIntent`（对象）与 `drcReport`/`drcScope`；
  非法意图在**读板之前**返回 400，不静默忽略；
- 布局页“设计意图 JSON（可选）”文本框会随读板/预演/写回一起提交；旁边“插入模板”会填入带 `<J1>/<VBUS>` 占位符的完整骨架（直接提交会被 400 拒绝，防止把模板误当成真实声明）；
- 审计结果在 `layoutAudit.supplements` 独立展示，`SUP-*` FAIL 会计入 `blockingFailures`；
- 布局页“自动跑官方 DRC（只读）”默认勾选，plan/apply 会带 `autoDrc:true`；DRC 成功才让 GATE-02 PASS，失败仍 REVIEW，不冒充通过。

## 1. 示例

```json
{
  "schemaVersion": 1,
  "pcbUuid": "5595e77cead09682",
  "board": {
    "thicknessMm": 1.6,
    "cornerRadiusMm": 1.0,
    "panelized": true,
    "processEdgeMm": 5,
    "vCutLines": [{ "x0": 0, "y0": 20, "x1": 40, "y1": 20 }]
  },
  "components": {
    "U1": {
      "packageClass": "MODULE",
      "side": "top",
      "heightMm3d": 3.2,
      "courtyardMm": 0.25,
      "antenna": { "endDir": "+y" }
    },
    "J1": {
      "courtyardMm": 0.25,
      "conn": {
        "kind": "USB-C",
        "openingDir": "-y",
        "openingNormalityDeg": 0,
        "plugClearanceMm": 12,
        "overhangMm": 0,
        "cableKeepout": true,
        "massG": 1.8,
        "reinforced": true,
        "pin1Marked": true
      }
    }
  },
  "rf": {
    "componentRef": "U1",
    "keepout": { "x0": 10, "y0": 0, "x1": 30, "y1": 15 },
    "copperInKeepout": false,
    "gndCoveragePercent": 92,
    "viaFencePitchMm": 2.5,
    "metalRefs": [],
    "noiseSourcesNearAntenna": [],
    "maskOpeningInKeepout": false,
    "silkInKeepout": false,
    "viasInKeepout": false,
    "gndViaRatio": 1
  },
  "power": {
    "decoupling": [
      { "capRef": "C1", "icRef": "U1", "net": "+3V3", "distanceMm": 0.8, "icClass": "MODULE" }
    ],
    "nets": [{ "net": "VBUS", "currentA": 3, "widthMm": 1.2, "layer": "outer" }],
    "paths": [{ "net": "VBUS", "peakCurrentA": 3, "designedForA": 4.5 }]
  },
  "testPoints": [{ "ref": "TP1", "x": 10, "y": 5, "diaMm": 1.5, "net": "3V3" }],
  "requiredNets": ["VBUS", "3V3", "GND", "EN"],
  "switches": [{ "ref": "SW1", "clearanceMm": 9 }],
  "esd": {
    "devices": [
      { "ref": "D1", "protectedInterfaces": ["USB1"], "distanceMm": 3, "gndViaDistanceMm": 1.2, "orderBeforeBranch": true }
    ]
  },
  "thermal": {
    "components": [
      { "ref": "U4", "powerW": 2, "copperAreaMm2": 240, "viaCount": 9, "viaPitchMm": 1.1, "viaHoleMm": 0.3 }
    ]
  },
  "pdn": {
    "rails": [{ "net": "VBUS", "dropV": 0.10, "maxDropV": 0.15 }]
  },
  "highSpeed": {
    "groups": [
      { "name": "USB3", "standard": "USB3", "maxSkewMm": 0.2, "targetImpedanceOhm": 90,
        "intraPairSkewMm": 0.05, "pairGapMm": 1.0, "planeEdgeClearanceMm": 3.0, "stubMm": 0.2,
        "members": [{ "net": "D+", "lengthMm": 10.0, "impedanceOhm": 92 }, { "net": "D-", "lengthMm": 10.1, "impedanceOhm": 89 }] }
    ]
  },
  "creepage": {
    "pairs": [{ "netA": "AC_L", "netB": "AC_N", "workingVoltageV": 230, "actualMm": 1.6, "requiredMm": 1.5 }]
  },
  "clearance": {
    "pairs": [{ "netA": "AC_L", "netB": "AC_N", "workingVoltageV": 230, "layer": "external", "coating": "uncoated", "altitudeM": 1000, "actualMm": 2.0 }]
  },
  "enclosure": { "requiredClearanceMm": 1.0, "actualClearanceMm": 2.0, "internalHeightMm": 8, "maxComponentHeightMm": 5 },
  "emc": {
    "pairs": [{ "from": "SW1", "to": "ANT1", "minMm": 15, "actualMm": 18 }]
  },
  "evidence": {
    "step3d": {
      "passed": true,
      "source": "STEP-Interference",
      "artifactHash": "<sha256 64 hex>",
      "issuedAt": "2026-10-23T09:00:00.000Z",
      "scope": "<pcbUuid>/rev-C"
    }
  }
}
```

## 2. 字段规则

| 字段 | 约束 | 缺失时规则行为 |
| --- | --- | --- |
| `schemaVersion` | 只支持 `1` | 其他值直接拒绝 |
| `components.<ref>` | 位号存在；只覆盖声明字段，不改读回坐标 | 未声明字段按实测/REVIEW |
| `components.<ref>.courtyardMm` | ≥0 数字 | `SPACE-01/02/03/04..08/11/12` REVIEW |
| `components.<ref>.heightMm3d` | >0 数字 | `SPACE-14/15/18` 无法判高度 |
| `components.<ref>.conn.openingDir` | `+x/-x/+y/-y` | CONN 组 REVIEW |
| `components.<ref>.antenna.endDir` | `+x/-x/+y/-y` | RF-01/02 REVIEW |
| `power.decoupling[]` | `capRef/icRef/distanceMm` 必填；显式条目才可 FAIL | PWR-01 REVIEW |
| `rf.keepout` | `x1>x0`、`y1>y0` | RF-03 REVIEW |
| `testPoints[]` | `ref/diaMm` 必填 | DFA-05/06 REVIEW |
| `switches[]` | `ref/clearanceMm` 必填 | DFA-04 REVIEW |
| `esd.devices[]` | `ref` 必填；量测缺失则 REVIEW | DFA-09 REVIEW |
| `thermal.components[]` | `ref/powerW` 必填；铜面积/热过孔量测缺失则 REVIEW | `SUP-TH-01/02` REVIEW |
| `pdn.rails[]` | `net/dropV/maxDropV` 必填 | `SUP-PDN-01` REVIEW |
| `highSpeed.groups[]` | `name/members≥2/maxSkewMm` 必填；成员 `lengthMm` 缺省时从 `pcb.copper.read` 按网络累加补齐（`lengthSource:copper.lines`）；`standard` 仅支持 `USB2/USB3/USB4`，USB 组可声明 `intraPairSkewMm/pairGapMm/planeEdgeClearanceMm/stubMm` | `SUP-HS-01`/`SUP-HS-02` REVIEW |
| `creepage.pairs[]` | `netA/netB/actualMm/requiredMm` 必填 | `SUP-CREEP-01` REVIEW |
| `clearance.pairs[]` | `netA/netB` 必填；`layer=internal/external`、`coating=uncoated/coated`、`altitudeM` 用于查 IPC-2221 表；`actualMm` 必填；`requiredMm` 可显式覆盖 | `SUP-IPC-01` REVIEW；>500 V 不自动外推 |
| `enclosure` | 间隙/内部高度/最高器件四个数 | `SUP-ENCL-01` REVIEW |
| `emc.pairs[]` | `from/to/actualMm/minMm` 必填 | `SUP-EMC-01` REVIEW |
| `evidence.*` | 必须 `passed + source + artifactHash + issuedAt + scope` | 对应 GATE REVIEW，不 PASS |

`artifactHash` 必须是 64 位 sha256；`issuedAt` 必须能被 `Date.parse` 解析。
不做默认值补全，不用“0”替代“未提供”。

## 3. 补充规则族（P2，独立于 128 条）

`thermal / pdn / highSpeed / creepage / clearance / enclosure / emc` 这些事实无法从 2D 几何推导，
统一走 `runtime/engineering/layout-supplements.mjs` 的 9 条 `SUP-*` 规则：
缺声明一律 REVIEW；有量测才 PASS/FAIL；FAIL 计入 `blockingFailures` 并让 `releaseReady=false`。
它们不改变 128 条规则包总数与 hash。

## 4. 与实测几何的优先级

- **坐标/尺寸**：以 `pcb.placement.read` 读回为准，意图不能改坐标；
- **角色属性**：`courtyard/height/conn/antenna/packageClass` 以意图为准；
- **门禁证据**：以 `evidence` 声明为准，但必须带 provenance；
- 意图 JSON 不会写回 EDA，也不自动改板。
