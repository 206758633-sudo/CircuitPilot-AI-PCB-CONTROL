import { expect, test, type Page } from '@playwright/test';

/**
 * 语音输入的 E2E（PCBA 需求输入框）。
 *
 * 无头 Chromium 里没有麦克风，所以这里在页面加载前用 page.addInitScript 注入一个
 * **受控假识别器**（只替换浏览器 API，不碰产品代码），再真跑产品自己的
 * onresult / onerror / onend 分支，验证：
 *   ① 临时结果实时回显，且不写进输入框；② 最终结果**追加**到已输入内容后面（不覆盖）；
 *   ③ 识别完不自动发送；④ aria-pressed 反映录制状态；
 *   ⑤ 没有 API（Firefox/部分 WebView）和用户拒绝麦克风时的中文降级提示。
 *
 * 注意：注入脚本用**字符串形式**而不是 `addInitScript(fn, arg)`——后者会序列化参数，
 * 数组上的自定义属性（isFinal）会在传递中丢失，识别结果就会被误判成临时结果。
 * "对着麦克风说中文真的能转文字"必须在有麦克风的真实浏览器里由人验收，这里不假装测过。
 */
test.describe.configure({ timeout: 120_000 });

/**
 * 生成注入用的自包含脚本（字符串形式，避免参数序列化丢属性）。
 *
 * 事件结构必须和真实 Web Speech API 一致，两层含义缺一不可：
 *   results[i].isFinal        —— 这一段是不是最终结果
 *   results[i][0].transcript  —— 这一段的文本
 * 所以用 Object.assign 把 isFinal 挂在**结果数组**上（写成 [[{...,isFinal}]] 是错的：
 * 那样 isFinal 会落在内层数组的 0 号元素上，产品代码读 results[i].isFinal 会读到 undefined，
 * 最终结果就会被误判成临时结果）。
 * `error` 为空时按"临时结果 → 最终结果 → onend"走；给了 error 就模拟识别失败/权限被拒。
 */
function speechRecognitionScript(transcript: string, error?: string): string {
  return `(() => {
  const transcript = ${JSON.stringify(transcript)};
  const errorCode = ${error === undefined ? 'null' : JSON.stringify(error)};
  const segment = (text, isFinal) => Object.assign([{ transcript: text }], { isFinal });
  class FakeRecognition {
    constructor() {
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
    }
    start() {
      if (errorCode) {
        window.setTimeout(() => { if (this.onerror) this.onerror({ error: errorCode }); if (this.onend) this.onend(); }, 20);
        return;
      }
      // 前 6 个字符当作临时结果，随后补全成最终结果——真实识别器就是这个行为。
      window.setTimeout(() => {
        if (this.onresult) this.onresult({ resultIndex: 0, results: [segment(transcript.slice(0, 6), false)] });
      }, 120);
      window.setTimeout(() => {
        if (this.onresult) this.onresult({ resultIndex: 0, results: [segment(transcript, true)] });
        if (this.onend) this.onend();
      }, 400);
    }
    stop() { if (this.onend) this.onend(); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
})();`;
}

/** 生成"浏览器没有语音识别 API"的注入脚本（Firefox、部分 WebView）。 */
function removeSpeechRecognitionScript(): string {
  return `(() => {
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
})();`;
}

/** 打开应用并停留在“AI 需求对话”页；返回需求输入框。 */
async function openRequirementComposer(page: Page) {
  // 与其它 e2e 一致：把前端默认的 4178 让给开发用运行时（4179），避免和打包版 Runtime 抢端口。
  await page.route('**/api/**', (route) => route.continue());
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.getByTestId('nav-design').click();

  const box = page.getByLabel('发送给Codex的PCBA需求');
  await expect(box).toBeVisible();
  return box;
}

test.describe('语音输入（PCBA 需求输入框）', () => {
  test('识别结果追加到已输入内容后面，临时结果实时回显，且不会自动发送', async ({ page }) => {
    const spoken = '做一个60x40的双层STM32板，5V供电，带USB';
    await page.addInitScript(speechRecognitionScript(spoken));
    const box = await openRequirementComposer(page);

    await box.fill('补充需求：');
    const mic = page.getByRole('button', { name: /语音输入/ });
    await expect(mic).toBeEnabled();
    await expect(mic).toHaveAttribute('aria-pressed', 'false');

    await mic.click();

    // 临时结果：只回显在 live region 里，不写进输入框
    const interim = page.getByLabel('语音识别临时结果');
    await expect(interim).toBeVisible();
    await expect(interim).toContainText('做一个60x');
    await expect(box).toHaveValue('补充需求：');
    await expect(page.getByRole('button', { name: /停止语音输入/ })).toHaveAttribute('aria-pressed', 'true');

    // 最终结果：追加，不覆盖
    await expect(box).toHaveValue(`补充需求： ${spoken}`, { timeout: 20_000 });
    await expect(page.getByRole('button', { name: /语音输入/ })).toHaveAttribute('aria-pressed', 'false');

    // 绝不自动发送：空态文案还在，也没有生成用户消息气泡
    await expect(page.getByText('先告诉我你准备设计什么板')).toBeVisible();
    await expect(page.locator('.chat-message--user')).toHaveCount(0);
  });

  test('没有 SpeechRecognition 的浏览器：按钮不禁用，点击后给中文提示且输入框照常可用', async ({ page }) => {
    await page.addInitScript(removeSpeechRecognitionScript());
    const box = await openRequirementComposer(page);

    expect(await page.evaluate(() => typeof (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition)).toBe('undefined');
    expect(await page.evaluate(() => typeof (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition)).toBe('undefined');

    const mic = page.getByRole('button', { name: /语音输入/ });
    await expect(mic).toBeEnabled();
    await mic.click();

    await expect(page.getByText(/不支持语音输入/)).toBeVisible();
    await box.fill('手打的需求');
    await expect(box).toHaveValue('手打的需求');
    await expect(box).toBeEnabled();
  });

  test('用户拒绝麦克风权限：给中文提示、不写入输入框、已有内容不被清空', async ({ page }) => {
    await page.addInitScript(speechRecognitionScript('', 'not-allowed'));
    const box = await openRequirementComposer(page);

    await box.fill('用户已经打的字');
    await page.getByRole('button', { name: /语音输入/ }).click();

    await expect(page.getByText(/麦克风权限/)).toBeVisible();
    await expect(box).toHaveValue('用户已经打的字');
    await expect(box).toBeEnabled();
    await expect(page.getByRole('button', { name: /语音输入/ })).toHaveAttribute('aria-pressed', 'false');
  });
});
