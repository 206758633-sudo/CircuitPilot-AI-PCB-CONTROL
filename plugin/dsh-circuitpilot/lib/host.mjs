/**
 * DSH 宿主适配层（host-independent，不静态依赖任何 DSH 包）。
 *
 * 背景：DSH 0.2.1-rc.5 把 `ctx.tools.register(definition)` 的契约收紧了：
 *  - 新契约：`{ name, description, parameters, output: { schema, render(args,value)->content[] }, execute(args,exec)->value }`；
 *    注册时校验 `output` 必须存在、`output.schema` 属于受支持 JSON Schema 子集、`render` 是函数；
 *  - 旧契约（0.2.0-rc.x）：`{ name, description, inputSchema, execute }`，execute 直接返回 MCP 风格结果。
 *
 * 这里做「能力自适应」注册，避免 DSH 每次升级都要改插件：
 *  1. `createMcpToolDefinition` 可用 → 用官方 MCP 工具定义（与宿主 MCP 工具完全一致）；
 *  2. 否则尝试新契约 native 定义（镜像 createMcpToolDefinition 的产物：execute 返回
 *     `{content, structuredContent}`，output.render 把 content 渲染成 text）；
 *  3. 注册被旧宿主拒绝（典型：TypeError 提到 output/parameters）→ legacy 定义。
 *
 * 注册失败不会让 apply 崩掉：单个工具失败会被记录并继续注册其它工具，最后由 index.mjs 汇总日志。
 */
import { evaluateDshHost, readLocalDshVersion } from './compat.mjs';

/** 三种注册模式，按尝试顺序排列。 */
export const REGISTRATION_MODES = Object.freeze(['mcp', 'native', 'legacy']);

/**
 * 新契约 output.schema：镜像 DSH 0.2.1-rc.x 中 createMcpToolDefinition 生成的 MCP 信封。
 * 该 shape 属于 dsh-tools 支持的 JSON Schema 子集（type/properties/required/items/additionalProperties）。
 */
export const TOOL_RESULT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    content: { type: 'array', items: {} },
    structuredContent: {},
  },
  required: ['content', 'structuredContent'],
  additionalProperties: false,
});

/** 把工具业务返回值包装成 MCP 风格结果（content + structuredContent）。 */
export function toToolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/** 从 MCP 风格结果里提取模型可读文本（优先 content.text）。 */
export function resultText(value) {
  const content = value?.content;
  if (Array.isArray(content) && content.length > 0) {
    const text = content
      .map((block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  return JSON.stringify(value?.structuredContent ?? value ?? null);
}

/**
 * 探测宿主信息。版本来源优先级：显式 version > 环境变量 DSH_RUNTIME_VERSION >
 * $DSH_HOME/dsh-runtimes/dsh-primary-runtime/runtime.json 的 desktopVersion。
 * @param {{version?:string, source?:string, env?:Record<string,string|undefined>, packageVersion?:string}} [options]
 */
export function detectHost(options = {}) {
  const env = options.env ?? process.env;
  const explicit = typeof options.version === 'string' && options.version.trim() ? options.version.trim() : '';
  const detected = explicit
    ? { version: explicit, source: options.source ?? 'argument' }
    : readLocalDshVersion({ env });
  const compat = evaluateDshHost(detected.version);
  return {
    pluginVersion: typeof options.packageVersion === 'string' ? options.packageVersion : null,
    version: detected.version,
    source: detected.source,
    compatible: compat.supported,
    supportedRange: compat.range,
    verified: compat.verified,
    unknown: compat.unknown,
    reason: compat.reason,
    registration: null,
  };
}

/** 一行人类可读的宿主描述，供日志/诊断使用。 */
export function describeHost(host) {
  if (!host) return 'dsh 宿主未知';
  const version = host.version ?? '未知版本';
  const compatible = host.compatible === true ? '兼容' : (host.unknown ? '版本未知' : '不兼容');
  const registration = host.registration ? `, 注册模式=${host.registration}` : '';
  return `dsh ${version}（${compatible}, 支持区间 ${host.supportedRange ?? '?'}${registration}）`;
}

/** 新契约 native 定义：execute 仍返回 MCP 信封，output.render 负责生成模型可见文本。 */
function createNativeDefinition(tool, call) {
  const definition = {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    output: {
      schema: TOOL_RESULT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: resultText(value) }];
      },
    },
    execute: call,
  };
  definition.isConcurrencySafe = () => tool.type !== 'execute';
  return definition;
}

/** 旧契约定义：0.2.0-rc.x 宿主直接接受 inputSchema + execute。 */
function createLegacyDefinition(tool, call) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    isConcurrencySafe: () => tool.type !== 'execute',
    execute: call,
  };
}

/** 官方 MCP 定义；名字对不上或构造失败时返回 null（走降级）。 */
function createOfficialDefinition(ctx, createMcpToolDefinition, tool, call) {
  if (typeof createMcpToolDefinition !== 'function') return null;
  const definition = createMcpToolDefinition(ctx, {
    name: tool.name,
    rawName: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    call,
  });
  if (!definition || typeof definition !== 'object') return null;
  // 契约工具名必须保持 cp_*：被重命名就放弃该定义走降级，避免模型看到对不上的工具名。
  if (typeof definition.name !== 'string' || definition.name !== tool.name) return null;
  try {
    definition.isConcurrencySafe = () => tool.type !== 'execute';
  } catch {
    /* frozen definition: 并发语义交给宿主 */
  }
  return definition;
}

/**
 * 创建自适应工具注册器。
 * @param {object} ctx DSH 插件上下文（只用 ctx.tools.register）
 * @param {{logger?:object, createMcpToolDefinition?:Function, hostVersion?:string, host?:object, env?:Record<string,string|undefined>}} [options]
 */
export function createToolRegistrar(ctx, options = {}) {
  const logger = options.logger ?? null;
  const host = options.host ?? detectHost({ version: options.hostVersion, env: options.env });
  const disposers = [];
  const failed = [];
  const modesUsed = [];
  let mode = null;

  function makeCall(tool) {
    return async (args, exec) => toToolResult(await tool.execute(args ?? {}, { signal: exec?.signal, exec }));
  }

  /**
   * 注册一个工具，返回 disposer（失败返回 undefined）。
   * @param {{name:string, description:string, type:string, inputSchema:object, execute:Function}} tool
   */
  function registerTool(tool) {
    const call = makeCall(tool);
    const attempts = [];
    const candidates = [];

    const official = createOfficialDefinition(ctx, options.createMcpToolDefinition, tool, call);
    if (official) candidates.push({ mode: 'mcp', definition: official });
    candidates.push({ mode: 'native', definition: createNativeDefinition(tool, call) });
    candidates.push({ mode: 'legacy', definition: createLegacyDefinition(tool, call) });

    for (const candidate of candidates) {
      try {
        const dispose = ctx.tools.register(candidate.definition);
        if (!modesUsed.includes(candidate.mode)) modesUsed.push(candidate.mode);
        if (mode === null) mode = candidate.mode;
        if (typeof dispose === 'function') disposers.push(dispose);
        return dispose;
      } catch (error) {
        attempts.push({ mode: candidate.mode, error });
      }
    }

    failed.push({
      name: tool.name,
      attempts: attempts.map(({ mode: attemptMode, error }) => ({
        mode: attemptMode,
        error: error?.message ?? String(error),
      })),
    });
    logger?.warn?.(`dsh-circuitpilot: 工具 ${tool.name} 注册失败（已尝试 ${attempts.map((item) => item.mode).join('/')}）：${attempts.map((item) => item.error?.message ?? item.error).join(' | ')}`);
    return undefined;
  }

  function disposeAll() {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  }

  return {
    registerTool,
    disposeAll,
    /** 首个成功注册使用的模式（mcp/native/legacy），全部失败为 null。 */
    get mode() {
      return mode;
    },
    /** 本次实际用到的模式集合（正常情况下只有一种）。 */
    get modesUsed() {
      return [...modesUsed];
    },
    failed,
    host,
  };
}
