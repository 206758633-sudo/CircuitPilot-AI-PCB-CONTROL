# 通用网表回归 fixture（W2-03）

每个 JSON 是一个跨板可复用的最小场景：`{ name, intent, actual, expect: { verdict, codes } }`。
- `intent`：意图网表（`[{net, endpoints:[{ref,pin}]}]` 或 design-spec `{netIntent:[...]}`）；
- `actual`：EDA 实际网表（EasyEDA 导出 `{components:{...pinInfoMap}}` 或 `{nets:[...]}`）；
- `expect`：期望 verdict 与必须出现的 finding code。
不绑定任何具体项目/坐标/料号，只描述“缺陷类别”。
