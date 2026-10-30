import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 语音输入（Web Speech API）。
 *
 * 这里的规则是给"不懂技术的板卡设计者"定的，所以刻意保守：
 * 1. 识别结果只**追加**到用户已经打的字后面，永远不清空输入框；
 * 2. 中间的临时识别结果单独显示，不写进输入框，避免把半句话留在正式内容里；
 * 3. 浏览器不支持、或用户拒绝麦克风权限时，给一句中文人话说明，输入框照常可用；
 *    "不支持"绝不能抛异常——Firefox、部分 WebView 里 window.SpeechRecognition 就是 undefined。
 * 4. 识别完成不会自动发送，用户仍可手改后再点发送。
 */

type SpeechAlternative = { transcript: string };
type SpeechResult = ArrayLike<SpeechAlternative> & { isFinal?: boolean };
type SpeechResultList = ArrayLike<SpeechResult> & { length: number };
export type SpeechRecognitionEventLike = { resultIndex: number; results: SpeechResultList };
export type SpeechRecognitionErrorEventLike = { error?: string };

export type SpeechRecognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognizer;

export const VOICE_UNSUPPORTED_MESSAGE = '当前浏览器不支持语音输入，请改用 Chrome 或 Edge，或直接手动输入。';
export const VOICE_PERMISSION_DENIED_MESSAGE = '没有拿到麦克风权限，请在浏览器地址栏允许麦克风后重试；也可以直接手动输入。';
export const VOICE_FAILED_MESSAGE = '语音识别没能完成，请再试一次，或直接手动输入。';
export const VOICE_LISTENING_MESSAGE = '正在听…说完会自动结束，识别结果可以手改。';

/** 从 window 上取识别器构造函数；缺失时返回 null，绝不抛异常。 */
export function resolveSpeechRecognition(target: unknown = typeof window === 'undefined' ? undefined : window): SpeechRecognitionConstructor | null {
  if (!target || typeof target !== 'object') return null;
  const scope = target as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const candidate = scope.SpeechRecognition || scope.webkitSpeechRecognition;
  return typeof candidate === 'function' ? (candidate as SpeechRecognitionConstructor) : null;
}

/**
 * 把一段识别结果追加到已有文本后面。
 * 已有文本为空时不留前导空格；否则用一个空格分隔，保证中英文混排也不会粘在一起。
 */
export function mergeSpeechTranscript(existing: string, transcript: string): string {
  const addition = transcript.trim();
  if (!addition) return existing;
  if (!existing) return addition;
  if (!existing.trim()) return addition;
  return /\s$/.test(existing) ? `${existing}${addition}` : `${existing} ${addition}`;
}

/** 把一次 onresult 事件里 resultIndex 之后的片段拼成文本。 */
export function joinSpeechResults(results: SpeechResultList, resultIndex = 0): { interim: string; final: string } {
  let interim = '';
  let final = '';
  const start = Math.max(0, Math.min(resultIndex, results.length));
  for (let index = start; index < results.length; index += 1) {
    const result = results[index];
    const transcript = result?.[0]?.transcript ?? '';
    if (result?.isFinal) final += transcript;
    else interim += transcript;
  }
  return { interim, final };
}

export function voiceErrorMessage(code?: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') return VOICE_PERMISSION_DENIED_MESSAGE;
  return VOICE_FAILED_MESSAGE;
}

export interface UseVoiceInputResult {
  supported: boolean;
  listening: boolean;
  /** 说的过程中的临时结果，只用于回显，不写进输入框。 */
  interimText: string;
  /** 已确认的最终识别结果；组件消费后应调用 clearFinalText，避免重复追加。 */
  finalText: string;
  /** 给用户看的中文状态/错误说明，空字符串表示没什么要说的。 */
  message: string;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  clearFinalText: () => void;
}

export interface UseVoiceInputOptions {
  lang?: string;
  /** 依赖注入点，便于测试；默认从 window 取。 */
  recognitionCtor?: SpeechRecognitionConstructor | null;
}

export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputResult {
  const { lang = 'zh-CN' } = options;
  const [listening, setListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [finalText, setFinalText] = useState('');
  const [message, setMessage] = useState('');
  const [supported, setSupported] = useState(() =>
    options.recognitionCtor !== undefined ? Boolean(options.recognitionCtor) : Boolean(resolveSpeechRecognition()),
  );
  const recognizerRef = useRef<SpeechRecognizer | null>(null);
  const ctorRef = useRef(options.recognitionCtor);
  ctorRef.current = options.recognitionCtor;

  const detect = useCallback(
    () => (ctorRef.current !== undefined ? ctorRef.current : resolveSpeechRecognition()),
    [],
  );

  const stop = useCallback(() => {
    const recognizer = recognizerRef.current;
    recognizerRef.current = null;
    if (recognizer) {
      // stop() 在部分实现里会同步抛错（例如已经开始结束），这里不能再把用户操作变成崩溃。
      try { recognizer.stop(); } catch { /* 已经停止，忽略 */ }
    }
    setListening(false);
    setInterimText('');
  }, []);

  const start = useCallback(() => {
    const ctor = detect();
    if (!ctor) {
      setSupported(false);
      setMessage(VOICE_UNSUPPORTED_MESSAGE);
      return;
    }
    setSupported(true);
    stop();
    let recognizer: SpeechRecognizer;
    try {
      recognizer = new ctor();
    } catch {
      setSupported(false);
      setMessage(VOICE_UNSUPPORTED_MESSAGE);
      return;
    }
    recognizer.lang = lang;
    recognizer.continuous = false;
    recognizer.interimResults = true;
    recognizer.onresult = (event) => {
      const { interim, final } = joinSpeechResults(event?.results ?? [], event?.resultIndex ?? 0);
      setInterimText(interim);
      if (final.trim()) {
        setFinalText((current) => (current ? `${current}${final}` : final));
        setMessage('');
      }
    };
    recognizer.onerror = (event) => {
      setMessage(voiceErrorMessage(event?.error));
      setInterimText('');
      setListening(false);
      recognizerRef.current = null;
    };
    recognizer.onend = () => {
      setListening(false);
      setInterimText('');
    };
    recognizerRef.current = recognizer;
    setMessage(VOICE_LISTENING_MESSAGE);
    setInterimText('');
    setListening(true);
    try {
      recognizer.start();
    } catch {
      setListening(false);
      recognizerRef.current = null;
      setMessage(VOICE_FAILED_MESSAGE);
    }
  }, [detect, lang, stop]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  const clearFinalText = useCallback(() => setFinalText(''), []);

  useEffect(() => () => {
    const recognizer = recognizerRef.current;
    recognizerRef.current = null;
    if (recognizer) {
      try { recognizer.stop(); } catch { /* 卸载时的清理失败不影响任何 UI */ }
    }
  }, []);

  return { supported, listening, interimText, finalText, message, start, stop, toggle, clearFinalText };
}
