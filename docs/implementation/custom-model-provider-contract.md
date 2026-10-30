# 自定义模型 Provider 契约（实现协作基线）

> 目标：在 CircuitPilot 的「系统设置」里增加**自定义模型 API**能力（对齐参考图二）：
> 用户自己定义 Provider ID、显示名称、API 地址、API 协议、API 密钥，并维护**模型目录**
> （模型 ID / 显示名称 / 上下文窗口 / 最大输出 token 数 / 输入类型 / 推理等级）。
> Runtime 负责持久化、校验、凭据隔离与协议适配；前端只负责编辑与状态摘要。

本文件是 Runtime 与前端两侧实现的**接口基线**。字段名、路由、错误码不得单边改动；
如需调整，先改本文件并同时通知 Lead 与另一位实现者。

## 1. 数据模型（Runtime 权威持久化）

落盘：`${CIRCUITPILOT_STATE_DIR:-artifacts/state}/custom-providers.json`，
使用 `runtime/store.mjs` 的 `createJsonStore`，`schemaVersion: 1`，初始 `{ providers: [] }`。

```json
{
  "id": "acme-gateway",
  "label": "Acme 网关",
  "protocol": "openai",
  "baseUrl": "https://gateway.example/v1",
  "models": [
    {
      "id": "gpt-5.6-sol",
      "label": "GPT-5.6 Sol",
      "contextWindow": 256000,
      "maxOutputTokens": 32000,
      "input": ["text", "image"],
      "reasoning": false
    }
  ],
  "createdAt": "2026-10-20T08:00:00.000Z",
  "updatedAt": "2026-10-20T08:00:00.000Z"
}
```

### 校验规则（Runtime 与前端镜像，Runtime 为最终裁决）

| 字段 | 规则 | 失败错误码 |
| --- | --- | --- |
| `id` | `/^[a-z][a-z0-9._-]{1,39}$/`，小写字母开头，2~40 字符；不得与内置 Provider ID 冲突（含 `demo`、`codex_account`、`claude_account`、全部 `*_api`、`custom_api`）；同一注册表内唯一 | `CUSTOM_PROVIDER_INVALID` |
| `label` | 去首尾空白后 1~60 字符 | `CUSTOM_PROVIDER_INVALID` |
| `protocol` | `openai`（OpenAI Chat Completions）或 `anthropic`（Anthropic Messages） | `CUSTOM_PROVIDER_INVALID` |
| `baseUrl` | 复用 `providers.mjs#normalizeBaseUrl`：仅 HTTPS，或本机回环 HTTP；禁止 URL 内嵌凭据 | `PROVIDER_BASE_URL_INVALID` / `CUSTOM_PROVIDER_INVALID` |
| `models` | 数组 1~20 条，模型 `id` 唯一且非空（≤120 字符，无空白）；`contextWindow` 整数 1000~10000000；`maxOutputTokens` 整数 100~1000000 且 ≤ `contextWindow`；`input` ∈ `['text','image']` 非空去重（必须含 `text`）；`reasoning` 布尔 | `CUSTOM_PROVIDER_INVALID` |
| 注册表上限 | 最多 20 个自定义 Provider | `CUSTOM_PROVIDER_LIMIT` |

错误统一 `Object.assign(new Error(中文可操作提示), { code, status })`。

## 2. Runtime 模块与函数

### 2.1 `runtime/config.mjs`

```js
export const CUSTOM_KEYCHAIN_PREFIX = 'com.circuitpilot.provider.custom';
export const customKeychainService = (id) => `${CUSTOM_KEYCHAIN_PREFIX}.${id}`;
```

`runtime/keychain.mjs`：`serviceFor(provider)` 先查 `KEYCHAIN_SERVICES`；未命中时若
`/^[a-z][a-z0-9._-]{1,39}$/.test(provider)` 返回 `customKeychainService(provider)`，否则仍抛
`KEYCHAIN_PROVIDER_UNSUPPORTED`。每个自定义 Provider 一个独立钥匙串条目，撤销/轮换互不影响。

### 2.2 `runtime/customProviders.mjs`（新增）

```js
export const CUSTOM_PROVIDER_PROTOCOLS = Object.freeze(['openai', 'anthropic']);

export function validateCustomProvider(input, { reservedIds = [], idFromPath = null } = {})
// → 归一化后的 { id, label, protocol, baseUrl, models: [...] }

export class CustomProviderRegistry {
  constructor({ file, reservedIds = [], now = () => new Date() })
  list()                                   // → 配置数组（含 createdAt/updatedAt，无任何密钥字段）
  get(id)                                  // → 配置 | null
  upsert(input, { idFromPath } = {})       // → { created, provider }
  remove(id)                               // → { removed: true }
  async statuses(keychain)                 // → ProviderSummary[]（见 §3）
  resolve(id)                              // → { id, label, kind:'api', custom:true, editable:true, protocol,
                                           //     baseUrl, chatBaseUrl: baseUrl, chatModel: models[0].id,
                                           //     auth: protocol==='anthropic'?'x-api-key':'bearer',
                                           //     headers: protocol==='anthropic'?{'anthropic-version':'2023-06-01'}:{},
                                           //     models } | null
}
```

- 读损坏/版本不符由 `createJsonStore` 抛 `STORE_*`：**不得吞掉变成空注册表**。server 侧构造时
  捕获并降级为内存注册表 + `logger.error`（与其它子系统一致），对外仍返回明确错误。
- `upsert`：路径 id 与 body `id` 不一致 → `CUSTOM_PROVIDER_INVALID`；已存在则保留 `createdAt`、
  更新 `updatedAt`；新 id 冲突内置 id → `CUSTOM_PROVIDER_INVALID`。
- `statuses` 返回摘要，**不得包含任何密钥/凭据字段**（沿用 `providers.test.mjs` 的敏感字段断言）。

### 2.3 `runtime/providers.mjs`

- `testProvider(id, keychain, { baseUrl, provider })`：新增可选 `provider` 覆盖（自定义 Provider
  由注册表 `resolve` 得到），模型列表地址 = `normalizeBaseUrl(baseUrl) ?? provider.chatBaseUrl`
  + `/models`；鉴权头仍由 `authHeaders(provider, key)` 生成。内置 Provider 行为不变。
- `providerStatuses` 保持只返回内置 Provider；server 负责与自定义摘要合并。

### 2.4 `runtime/apiChat.mjs`

`completeJson(options)` 扩展（保持现有调用兼容）：

```js
// 新增可选字段：
// provider?: 描述对象（来自 chat.mjs backend()，含 protocol/auth/headers/chatModel）
// protocol?: 'openai'|'anthropic'
// auth?: 'bearer'|'x-api-key'
// headers?: Record<string,string>
// maxTokens?: number
// images?: Array<{ name: string, mime: string, dataBase64: string }>
```

- 无 `provider` 时仍按 `PROVIDERS[providerId]` 解读（旧测试/调用不变）。
- `protocol === 'openai'`：`POST {base}/chat/completions`，Bearer/现有鉴权头；`max_tokens` 取
  `options.maxTokens ?? 4000`；图片按 `{type:'image_url', image_url:{url:'data:<mime>;base64,...'}}`
  拼在 user content 数组里（无图片时仍用字符串 content）。
- `protocol === 'anthropic'`：`POST {base}/messages`，头 `x-api-key` + `anthropic-version: 2023-06-01`；
  body `{ model, max_tokens, temperature, system, messages }`；图片按
  `{type:'image', source:{type:'base64', media_type:mime, data}}`；解析 `body.content[].text` 拼接；
  不使用 `response_format`，仅靠 JSON Schema 提示词。
- 模型名：`options.model || provider.chatModel`；都为空 → `PROVIDER_MODEL_REQUIRED`（现状保留）。
- 错误码保持现状（401/403/429/超时/JSON 解析），Key 不得进入错误消息。

### 2.5 `runtime/chat.mjs`（ChatManager）

- 构造参数新增 `customProviders = null`（`CustomProviderRegistry`）。
- `status(providerId)`：内置优先；否则注册表命中则 `{ ready: configured, provider: summary }`。
- `backend(body)`：内置优先；否则注册表 `resolve`，读钥匙串 Key；返回
  `{ kind:'api', providerId, baseUrl, key, label, protocol, auth, headers, models }`。
  - `model` 解析：自定义 Provider 必须是目录内模型，否则
    `CUSTOM_PROVIDER_MODEL_UNKNOWN`（400，消息列出可用模型 ID）；未传时用 `models[0].id`。
  - 内置 Provider 的 `baseUrl` 覆盖逻辑不变。
- `send()`：API 分支允许图片，但仅当所选自定义模型 `input` 含 `image`；否则
  `PROVIDER_IMAGE_UNSUPPORTED`。把 `images` 传给 `completeJson`。
- `plan()` / `productionPlan()` / `netlist()`：把 `protocol/auth/headers/maxTokens` 透传给
  `completeJson`；其余证据/门禁逻辑保持不变。
- `maxTokens`：取 `min(4000, 模型 maxOutputTokens)`（只为成本上限，不改变现有默认值）。
  上下文窗口用于校验与界面展示，不在本轮做激进截断。

### 2.6 `runtime/server.mjs`

1. 构造注册表（`stateDir` 下 `custom-providers.json`，`reservedIds = Object.keys(PROVIDERS)`），
   创建 `ChatManager({ ..., customProviders })`。
2. `GET /api/providers` → `[...await providerStatuses(keychain), ...await registry.statuses(keychain)]`。
3. 新增路由：
   - `PUT /api/custom-providers/:id`
     body `{ label, protocol, baseUrl, models }`（可带 `id`，须与路径一致）
     → `{ ok:true, customProvider: { ...配置, configured, ready } }`
   - `DELETE /api/custom-providers/:id`
     → `{ ok:true, removed:true, credential:{ configured:false } }`，同时删除钥匙串条目；未知 id → 404
     `CUSTOM_PROVIDER_NOT_FOUND`。
   - `POST /api/custom-providers/:id/models`
     → 用钥匙串 Key + 注册表地址/协议请求 `{base}/models`，返回
     `{ ok:true, models:[{ id, label?, contextWindow? }] }`；未存 Key →
     `CUSTOM_PROVIDER_KEY_REQUIRED`(409)，消息提示"先保存 API 密钥"；未知 id → 404。
4. `POST|DELETE /api/providers/:id/key` 与 `POST /api/providers/:id/test`：id 若不在内置表，
   必须先在注册表存在，否则 404 `CUSTOM_PROVIDER_NOT_FOUND`；test 走注册表解析后的 Provider。
5. 密钥/请求体日志沿用现有脱敏：不得把 `key`/`apiKey` 写进日志或响应。

> 路由必须能被 `runtime/__tests__/route-contract.test.mjs` 认可：前端 `runtimeClient` 要有对应
> 方法且被 `SettingsPage` 实际调用（或测试/脚本里出现完整路径）。

## 3. `/api/providers` 中自定义 Provider 的摘要形状

```json
{
  "id": "acme-gateway",
  "label": "Acme 网关",
  "kind": "api",
  "configured": true,
  "ready": true,
  "custom": true,
  "editable": true,
  "protocol": "openai",
  "baseUrl": "https://gateway.example/v1",
  "models": [{ "id": "gpt-5.6-sol", "label": "GPT-5.6 Sol", "contextWindow": 256000, "maxOutputTokens": 32000, "input": ["text", "image"], "reasoning": false }]
}
```

内置 `custom_api` 仍返回 `{ custom: true }`（无 `editable`/`models`），前端据此区分"快捷自定义槽"
与"注册表自定义 Provider"。

## 4. 前端契约

### 4.1 `src/types.ts`

```ts
export type CustomProviderProtocol = 'openai' | 'anthropic';
export interface CustomModelConfig {
  id: string; label?: string; contextWindow: number; maxOutputTokens: number;
  input: Array<'text' | 'image'>; reasoning: boolean;
}
export interface CustomProviderConfig {
  id: string; label: string; protocol: CustomProviderProtocol; baseUrl: string;
  models: CustomModelConfig[]; createdAt?: string; updatedAt?: string;
  configured?: boolean; ready?: boolean;
}
// ProviderId 放宽为可容纳注册表 id（保留字面量补全）：
export type ProviderId = 'demo' | AccountProviderId | ApiProviderId | (string & {});
// ProviderSummary 追加：custom?: boolean; editable?: boolean;
// protocol?: CustomProviderProtocol; baseUrl?: string; models?: CustomModelConfig[];
```

### 4.2 `src/services/runtimeClient.ts`

```ts
async saveCustomProvider(id: string, input: { label: string; protocol: CustomProviderProtocol; baseUrl: string; models: CustomModelConfig[] })
  // PUT /api/custom-providers/:id → { customProvider: CustomProviderConfig }
async deleteCustomProvider(id: string)
  // DELETE /api/custom-providers/:id → { removed: boolean }
async probeCustomProviderModels(id: string)
  // POST /api/custom-providers/:id/models → { models: Array<{ id: string; label?: string; contextWindow?: number }> }
```

### 4.3 `src/data/providerCatalog.ts`

- `providerOptions` 的合成条目：`item.custom === true` 归入分组 `自定义 API`（内置 `custom_api` 已在
  目录中，保持不动）；`summary` 说明"由你在「自定义模型 API」页签配置"。
- 新增导出 `customModelOptions(summary: ProviderSummary | undefined, current: string): string[]`
  （或等价 helper）：返回该 Provider 模型目录 id + 当前值去重；无目录时退回 `modelOptions`。

### 4.4 `src/pages/SettingsPage.tsx` + 新组件

- Panel「02 · AI PROVIDER」用 `SegmentedTabs` 分两个页签，**默认页签保持 `平台 Provider`**，
  现有 e2e/交互测试（Provider/模型/API URL/安全保存/去平台申请Key/测试连接）不得回归：
  - `平台 Provider`：现有表单不变。若当前选中的是注册表 Provider（`editable === true`）：
    模型字段改为从模型目录选择；隐藏可编辑 Base URL 与 API Key（提示到自定义页签管理凭据），
    显示协议/地址/模型数摘要 + 状态。
  - `自定义模型 API`：新增可复用组件 `src/components/CustomProviderEditor.tsx`：
    - 左/上：已定义 Provider 列表（显示 label/id/模型数/就绪状态），可新建、选中、删除。
    - 编辑区字段（label 文案需与参考图一致，便于定位）：`Provider ID`、`显示名称`、`API 地址`、
      `API 协议`（`OpenAI Chat Completions` / `Anthropic Messages`）、`API 密钥`（密码框 +
      「安全保存」「撤销 Key」）、`模型目录` + 「获取可用模型」。
    - 模型行字段：`模型 ID`、`显示名称`、`上下文窗口`、`最大输出 token 数`、`输入类型`
      （文本/图片复选框，文本勾选禁用）、`推理等级`（Toggle）、行删除；「添加模型」。
    - 动作：「保存配置」（PUT；若填了密钥再 `storeKey`）、「测试连接」（`testProvider`）、
      「删除该自定义模型」（DELETE）、「设为当前 Provider」。
    - 「获取可用模型」：先保存再探测；探测结果合并进模型目录（缺省 contextWindow 128000、
      maxOutputTokens 8192、input=['text']、reasoning=false，已存在的不覆盖）。
    - 空态/无 Runtime 时给出可操作提示（与现有 `.inline-alert` 风格一致）。
- 新增样式只**追加**到 `src/styles.css`（复用 `--paper/--line/--ink` 设计变量与现有卡片节奏），
  不重排现有规则。
- `AppContext` 持久化无需改结构；切换注册表 Provider 时 `settings.baseUrl` 置空，模型取目录首项。

## 5. 测试与验收

### Runtime（`node --test runtime/**/*.test.mjs`）

- 新增 `runtime/__tests__/custom-providers.test.mjs`：
  校验（id/保留 id/URL/模型边界）、CRUD 落盘与重载、损坏文件 fail-closed、
  `statuses` 不含敏感字段、`testProvider` 自定义地址与鉴权头、`resolve` 描述符。
- 新增 `runtime/__tests__/custom-providers-http.test.mjs`（仿 `server.test.mjs` 起临时 server +
  fake keychain + 临时 `CIRCUITPILOT_STATE_DIR`）：
  PUT 创建 → GET `/api/providers` 含 `editable` → POST models（fake fetch）→ DELETE 清理 →
  未授权 401 / 未知 id 404 / 非法体 400。
- 新增 `runtime/__tests__/apiChat-anthropic.test.mjs`：Anthropic 请求形状（URL/头/body/图片）与
  OpenAI 自定义 `max_tokens`。
- 既有 `providers.test.mjs`、`server.test.mjs`、`chat*` 测试必须全绿。

### 前端（vitest）

- 扩充 `src/data/__tests__/providerCatalog.test.ts`：自定义 Provider 分组、`editable` 摘要、
  模型目录选项 helper。
- 新增 `src/pages/__tests__/settings-custom-provider.test.tsx`（可复用现有 jsdom + 假 fetch 模式）：
  切到「自定义模型 API」→ 填 ID/名称/地址 → 添加模型 → 保存（断言 PUT body）→ 获取可用模型
  （断言 POST 路由）→ 删除（断言 DELETE 路由）。
- `npm run typecheck`、`npx vitest run`、`npm run build` 必须通过。

### 手动验收（Lead 最终执行）

1. `npm run dev:runtime` + `npm run dev`，打开系统设置 →「自定义模型 API」新建 Provider
   （含图片输入模型）→ 保存 → 获取模型 → 测试连接（允许失败但必须可读）→ 平台页签选中并保存。
2. `curl` 校验 `GET /api/providers` 无密钥字段；`custom-providers.json` 原子写入且不含 Key。

## 6. 写入边界（避免并发冲突）

| 范围 | 负责人 | 文件 |
| --- | --- | --- |
| Runtime | `runtime-engineer` | `runtime/customProviders.mjs`(新)、`config.mjs`、`keychain.mjs`、`providers.mjs`、`apiChat.mjs`、`chat.mjs`、`server.mjs`、`runtime/__tests__/custom-*`、`runtime/__tests__/apiChat-anthropic.test.mjs` |
| 前端 | `frontend-engineer` | `src/types.ts`、`src/services/runtimeClient.ts`、`src/data/providerCatalog.ts`、`src/data/__tests__/providerCatalog.test.ts`、`src/pages/SettingsPage.tsx`、`src/components/CustomProviderEditor.tsx`(新)、`src/styles.css`、`src/pages/__tests__/settings-custom-provider.test.tsx`(新)、`src/pages/AiTasksPage.tsx`(仅标签兜底) |
| 集成/文档/验收 | Lead | `docs/implementation/custom-model-provider-contract.md`、`README.md`、`docs/implementation/*`、全量 typecheck/build/测试、真实 Runtime 冒烟 |

其它既有未提交改动（`.gitignore`、`README.md` 等）属于仓库当前工作集，**不要回滚**。
