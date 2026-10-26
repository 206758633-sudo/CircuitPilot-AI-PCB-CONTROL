import { act, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  joinSpeechResults,
  mergeSpeechTranscript,
  resolveSpeechRecognition,
  useVoiceInput,
  VOICE_PERMISSION_DENIED_MESSAGE,
  VOICE_UNSUPPORTED_MESSAGE,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionEventLike,
  type SpeechRecognizer,
} from '../useVoiceInput';

/**
 * 语音输入的单元测试。
 *
 * 项目里没有 @testing-library/react（也不能为此加依赖），所以这里用 react-dom 自带的
 * createRoot + React.act 挂载一个最小宿主组件：宿主组件只做一件事——把 hook 的输出
 * 接到真实 DOM 上（输入框、临时结果、错误提示），断言全部打在 DOM 上，
 * 而不是打在 hook 的返回值上，避免"逻辑对了但界面没接上"这种假通过。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  started: number;
  stopped: number;
};

let instances: FakeRecognitionInstance[] = [];
/** 构造识别器时是否抛错，用来验证"环境异常也不能崩"。 */
let constructThrows = false;

class FakeSpeechRecognition implements SpeechRecognizer {
  static latest(): FakeRecognitionInstance {
    const instance = instances.at(-1);
    if (!instance) throw new Error('识别器还没有被创建');
    return instance;
  }

  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;

  constructor() {
    if (constructThrows) throw new Error('SpeechRecognition 不可用');
    instances.push(this as unknown as FakeRecognitionInstance);
  }

  start(): void { this.started += 1; }
  stop(): void { this.stopped += 1; }
}

function installRecognition(): void {
  const scope = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  scope.SpeechRecognition = FakeSpeechRecognition;
  scope.webkitSpeechRecognition = FakeSpeechRecognition;
}

function removeRecognition(): void {
  const scope = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  delete scope.SpeechRecognition;
  delete scope.webkitSpeechRecognition;
}

function resultsOf(items: Array<{ transcript: string; isFinal?: boolean }>) {
  return items.map((item) => Object.assign([{ transcript: item.transcript }], { isFinal: item.isFinal })) as unknown as SpeechRecognitionEventLike['results'];
}

/** 最小宿主组件：验证 hook 真的能驱动界面，并复现产品里的"追加而非覆盖"接线方式。 */
function VoiceHost() {
  const voice = useVoiceInput({ lang: 'zh-CN' });
  const [typed, setTyped] = useState('');
  const { finalText, clearFinalText } = voice;
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!finalText) return;
    setTyped((current) => mergeSpeechTranscript(current, finalText));
    clearFinalText();
  }, [finalText, clearFinalText]);

  return <div>
    <textarea aria-label="需求输入" ref={boxRef} value={typed} onChange={(event) => setTyped(event.target.value)} />
    <button type="button" data-testid="mic" aria-label={voice.listening ? '停止语音输入' : '语音输入（中文）'} aria-pressed={voice.listening} onClick={voice.toggle}>
      {voice.listening ? '停止语音' : '语音输入'}
    </button>
    {voice.listening && <div data-testid="interim">{voice.interimText}</div>}
    {voice.message && <p data-testid="voice-message">{voice.message}</p>}
  </div>;
}

let container: HTMLDivElement;
let root: Root;

const flush = async () => {
  await act(async () => { await Promise.resolve(); });
};

const box = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="需求输入"]')!;
const mic = () => container.querySelector<HTMLButtonElement>('[data-testid="mic"]')!;
const interim = () => container.querySelector<HTMLElement>('[data-testid="interim"]');
const message = () => container.querySelector<HTMLElement>('[data-testid="voice-message"]')?.textContent ?? '';

async function typeIntoBox(value: string): Promise<void> {
  const element = box();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function clickMic(): Promise<void> {
  await act(async () => { mic().click(); });
}

/** 触发识别器回调；产品代码的 onresult/onerror/onend 都是同步 setState，包一层 act 即可。 */
async function emitResult(event: SpeechRecognitionEventLike): Promise<void> {
  await act(async () => { FakeSpeechRecognition.latest().onresult?.(event); });
}

async function emitError(code: string): Promise<void> {
  await act(async () => { FakeSpeechRecognition.latest().onerror?.({ error: code }); });
}

async function emitEnd(): Promise<void> {
  await act(async () => { FakeSpeechRecognition.latest().onend?.(); });
}

beforeEach(() => {
  instances = [];
  constructThrows = false;
  installRecognition();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  removeRecognition();
  vi.restoreAllMocks();
});

describe('useVoiceInput（语音输入）', () => {
  it('detects the browser API, defaulting to webkitSpeechRecognition when needed', () => {
    expect(resolveSpeechRecognition(window)).toBe(FakeSpeechRecognition);
    removeRecognition();
    expect(resolveSpeechRecognition(window)).toBeNull();
    expect(resolveSpeechRecognition(undefined)).toBeNull();
    const scope = window as unknown as { webkitSpeechRecognition?: unknown };
    scope.webkitSpeechRecognition = FakeSpeechRecognition;
    expect(resolveSpeechRecognition(window)).toBe(FakeSpeechRecognition);
  });

  it('appends the final transcript to what the user already typed instead of wiping it', async () => {
    await act(async () => { root.render(<VoiceHost />); });
    await typeIntoBox('板子尺寸60x40');
    await clickMic();
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    expect(mic().getAttribute('aria-label')).toBe('停止语音输入');

    await emitResult({ resultIndex: 0, results: resultsOf([{ transcript: '五伏供电带USB', isFinal: true }]) });
    expect(box().value).toBe('板子尺寸60x40 五伏供电带USB');

    // 第二次识别继续往后追加，仍然不动用户手打的内容
    await clickMic();
    await emitResult({ resultIndex: 0, results: resultsOf([{ transcript: '和CH32V003', isFinal: true }]) });
    expect(box().value).toBe('板子尺寸60x40 五伏供电带USB 和CH32V003');
    expect(box().disabled).toBe(false);
  });

  it('shows the live interim transcript without writing it into the input box', async () => {
    await act(async () => { root.render(<VoiceHost />); });
    await clickMic();

    await emitResult({ resultIndex: 0, results: resultsOf([{ transcript: '做一个' }]) });
    expect(interim()?.textContent).toBe('做一个');
    expect(box().value).toBe('');

    // 临时结果被后续临时结果替换，输入框始终为空
    await emitResult({ resultIndex: 0, results: resultsOf([{ transcript: '做一个双层板' }]) });
    expect(interim()?.textContent).toBe('做一个双层板');
    expect(box().value).toBe('');

    // 变成最终结果后：进输入框、临时回显消失
    await emitResult({ resultIndex: 0, results: resultsOf([{ transcript: '做一个双层板', isFinal: true }]) });
    expect(box().value).toBe('做一个双层板');
    await emitEnd();
    expect(interim()).toBeNull();
    expect(mic().getAttribute('aria-pressed')).toBe('false');
  });

  it('falls back to a plain Chinese notice when SpeechRecognition is missing, and never throws', async () => {
    removeRecognition();
    await act(async () => { root.render(<VoiceHost />); });

    await expect(clickMic()).resolves.toBeUndefined();
    expect(instances).toHaveLength(0);
    expect(message()).toBe(VOICE_UNSUPPORTED_MESSAGE);
    expect(message()).toMatch(/不支持/);
    expect(message()).toMatch(/[\u4e00-\u9fa5]/);
    // 按钮保持可点（点了只是解释原因），输入框完全可用
    expect(mic().disabled).toBe(false);
    expect(box().disabled).toBe(false);
    await typeIntoBox('手打的需求');
    expect(box().value).toBe('手打的需求');
  });

  it('explains a denied microphone permission and leaves the input usable', async () => {
    await act(async () => { root.render(<VoiceHost />); });
    await clickMic();
    await emitError('not-allowed');

    expect(message()).toBe(VOICE_PERMISSION_DENIED_MESSAGE);
    expect(message()).toMatch(/麦克风权限/);
    expect(mic().getAttribute('aria-pressed')).toBe('false');
    expect(box().disabled).toBe(false);
    await typeIntoBox('权限被拒后仍然可以打字');
    expect(box().value).toBe('权限被拒后仍然可以打字');
  });

  it('treats a service-not-allowed error as a permission problem too', async () => {
    await act(async () => { root.render(<VoiceHost />); });
    await clickMic();
    await emitError('service-not-allowed');
    expect(message()).toBe(VOICE_PERMISSION_DENIED_MESSAGE);
  });

  it('survives a constructor that throws and reports it as unsupported', async () => {
    constructThrows = true;
    await act(async () => { root.render(<VoiceHost />); });
    await expect(clickMic()).resolves.toBeUndefined();
    expect(message()).toBe(VOICE_UNSUPPORTED_MESSAGE);
    expect(box().disabled).toBe(false);
  });

  it('stops listening when the mic button is clicked again', async () => {
    await act(async () => { root.render(<VoiceHost />); });
    await clickMic();
    expect(FakeSpeechRecognition.latest().started).toBe(1);

    await clickMic();
    expect(FakeSpeechRecognition.latest().stopped).toBe(1);
    expect(mic().getAttribute('aria-pressed')).toBe('false');
  });

  it('joins resultIndex-onward segments and keeps only final ones for the input box', () => {
    const results = resultsOf([
      { transcript: '已忽略前缀', isFinal: true },
      { transcript: '最终段', isFinal: true },
      { transcript: '临时段' },
    ]);
    expect(joinSpeechResults(results, 1)).toEqual({ interim: '临时段', final: '最终段' });
    expect(mergeSpeechTranscript('', '  ')).toBe('');
    expect(mergeSpeechTranscript('已有内容', ' 追加内容 ')).toBe('已有内容 追加内容');
    expect(mergeSpeechTranscript('已有内容 ', '追加内容')).toBe('已有内容 追加内容');
  });
});
