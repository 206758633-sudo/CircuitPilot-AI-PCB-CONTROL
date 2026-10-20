/**
 * 执行器适配层（Phase 0 内核）。
 *
 * 把三条通道收成统一签名，供配方引擎调用：
 *   - api   → bridge.execute（69 条 eda.* 命令，默认只读；写命令必须 allowWrite=true）
 *   - gui   → eda-gui 的 CDP 受信任输入（15 个白名单动作）
 *   - human → 人工兜底（DFM 上传/下单这类不可自动化的环节）
 *
 * 安全校验在这里再做一遍（runner 已经做预检），因为执行器是最后一道闸：
 * eval 默认拒绝、危险文案拒绝、危险快捷键拒绝、可选目标锁定。
 */
import { assertEdaTarget, assertGuiActionAllowed, assertNotCheckoutTarget, assertSafeText, assertShortcutAllowed } from './safety.mjs';
import { join } from 'node:path';
import { captureEdaWindow } from '../eda-window-capture.mjs';

const code = (message, name, extra = {}) => Object.assign(new Error(message), { code: name, ...extra });

/**
 * @param {object} options
 * @param {{execute:Function}} options.bridge
 * @param {{execute:Function}} options.gui
 * @param {Function|null} [options.human] (context) => Promise<{done:boolean, evidence?:any}>
 * @param {boolean} [options.allowEval] 调试用：放行 eval（默认 false）
 * @param {boolean} [options.targetLock] 目标锁定：非 EDA 页面直接拒绝（默认 true）
 */
export function createExecutors({ bridge = null, gui = null, human = null, allowEval = false, targetLock = true, windowCapture = captureEdaWindow } = {}) {
  const api = async ({ command, params = {}, allowWrite = false } = {}) => {
    if (!bridge || typeof bridge.execute !== 'function') throw code('bridge 未就绪，api 执行器不可用', 'AUTOMATION_BRIDGE_UNAVAILABLE');
    if (!command) throw code('api 执行器需要 command', 'AUTOMATION_API_COMMAND_REQUIRED');
    return bridge.execute(command, params || {}, { allowWrite: allowWrite === true });
  };

  const guiAction = async ({ action, params = {} } = {}) => {
    if (!gui || typeof gui.execute !== 'function') throw code('EDA GUI 通道未就绪，gui 执行器不可用', 'AUTOMATION_GUI_UNAVAILABLE');
    assertGuiActionAllowed(action, { allowEval });
    if (action === 'clickText') assertSafeText(params.text);
    if (action === 'shortcut' || action === 'key') assertShortcutAllowed({ key: params.key, modifiers: params.modifiers });
    if (targetLock && params.target !== undefined) assertEdaTarget(params.target);
    if (params.target !== undefined) assertNotCheckoutTarget(params.target);
    // E6 菜单文案漂移：clickText 允许按顺序尝试 alternatives（同一动作的已知文案变体）。
    // 每个候选文案都要过危险文案检查；全部找不到时把尝试过的文案带进诊断，不盲试无关动作。
    const alternatives = action === 'clickText' && Array.isArray(params.alternatives) ? params.alternatives.map(String).filter((item) => item && item !== params.text) : [];
    if (action === 'clickText' && alternatives.length) {
      const texts = [String(params.text ?? ''), ...alternatives];
      // 先校验全部候选文案：即使主文案点了成功，也不能让危险变体留在配方里"以后某次漂移才用到"。
      for (const text of texts) assertSafeText(text);
      const attempted = [];
      let lastError = null;
      for (const text of texts) {
        try {
          return await gui.execute('clickText', { ...params, text });
        } catch (error) {
          if (error?.code !== 'EDA_GUI_ELEMENT_NOT_FOUND') throw error;
          lastError = error;
          attempted.push(text);
        }
      }
      throw Object.assign(lastError || code('GUI 兜底找不到目标元素', 'EDA_GUI_ELEMENT_NOT_FOUND'), {
        details: {
          ...(lastError?.details && typeof lastError.details === 'object' ? lastError.details : {}),
          attemptedTexts: attempted,
          hint: 'EDA 版本升级常改菜单文案：先做能力探测/截图确认当前菜单，再更新配方 alternatives；不要靠盲点未知位置绕过。',
        },
      });
    }
    try {
      return await gui.execute(action, params || {});
    } catch (error) {
      // E9/E11：CDP `Page.captureScreenshot` 在本机 EDA 3.2.186 上会超时（Page.captureScreenshot）。
      // 截图是"证据"不是"写动作"：CDP 挂了改用 macOS 窗口区域截图兜底，并明确标注 kind/fallbackFrom；
      // 两种通道都失败则抛结构化错误，绝不返回空证据冒充成功。
      if (action !== 'screenshot') throw error;
      try {
        const shot = await windowCapture({ outDir: process.env.CIRCUITPILOT_GUI_EVIDENCE_DIR || join(process.cwd(), 'artifacts/gui-evidence') });
        return {
          ok: true,
          kind: shot.kind || 'os-window-capture',
          path: shot.path || null,
          sha256: shot.sha256 || null,
          bytes: shot.bytes ?? null,
          bounds: shot.bounds ?? null,
          note: shot.note || null,
          fallbackFrom: error?.code || error?.message || String(error),
        };
      } catch (fallbackError) {
        throw Object.assign(new Error(`CDP 截图失败，窗口截图兜底也失败：${String(error?.message || error).slice(0, 160)} / ${String(fallbackError?.message || fallbackError).slice(0, 160)}`), {
          code: 'EDA_SCREENSHOT_UNAVAILABLE',
          details: { cdpError: String(error?.message || error).slice(0, 200), fallbackError: String(fallbackError?.message || fallbackError).slice(0, 200) },
        });
      }
    }
  };

  const humanRunner = typeof human === 'function' ? human : null;

  return { api, gui: guiAction, human: humanRunner };
}

/** 运行时默认执行器：桥 + GUI 通道；人工步骤默认没有执行器（会安全地停在 needs_human）。 */
export function createRuntimeExecutors({ bridge, gui, allowEval = process.env.CIRCUITPILOT_GUI_DEBUG === '1' } = {}) {
  return createExecutors({ bridge, gui, allowEval });
}
