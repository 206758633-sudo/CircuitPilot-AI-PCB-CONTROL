import { describe, expect, it } from 'vitest';
import { sniffImageMime, verifyImageSignature } from '../imageSignature';

// 真实图片字节（由 Pillow 生成后取 base64），用于证明校验对真实 PNG/JPEG/GIF/WebP 放行。
const REAL = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM8ISfHwMDAxAAGAA0EAQijE05aAAAAAElFTkSuQmCC',
  jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDkKKKK8U/TD//Z',
  gif: 'R0lGODdhAgACAIEAAMgeHgAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7',
  webp: 'UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoCAAIAAUAmJaACdLoABDAAAP7x3I/4DdfFtMv/vYL/3YL/3YL/WwAA',
} as const;

// 用 atob 解码而不是 Node 的 Buffer：被测代码运行在浏览器/WebView 里，
// 而且前端 tsconfig 不包含 node 类型，引用 Buffer 会让 `tsc -b` 直接失败。
const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
const declaredMimeOf = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;

describe('sniffImageMime', () => {
  it.each(Object.keys(REAL) as Array<keyof typeof REAL>)('detects real %s bytes', (kind) => {
    const bytes = bytesOf(REAL[kind]);
    expect(bytes.length).toBeGreaterThan(0);
    expect(sniffImageMime(bytes)).toBe(declaredMimeOf[kind]);
  });

  it('returns null for text bytes masquerading as an image', () => {
    expect(sniffImageMime(new TextEncoder().encode('PK\u0003\u0004 not an image at all'))).toBeNull();
  });

  it('returns null for empty and truncated buffers', () => {
    expect(sniffImageMime(new Uint8Array([]))).toBeNull();
    expect(sniffImageMime(new Uint8Array([0x89, 0x50]))).toBeNull();
    // RIFF 缺少偏移8的 WEBP 标记时不能判定为 WebP
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]))).toBeNull();
  });
});

describe('verifyImageSignature', () => {
  it('accepts every real image whose declared MIME matches its signature', () => {
    for (const kind of Object.keys(REAL) as Array<keyof typeof REAL>) {
      expect(verifyImageSignature(bytesOf(REAL[kind]), declaredMimeOf[kind])).toEqual({ ok: true, detected: declaredMimeOf[kind] });
    }
  });

  it('rejects a fake .png that only declares image/png but contains text', () => {
    const spoofed = new TextEncoder().encode('<?php echo "not an image"; ?>');
    const verdict = verifyImageSignature(spoofed, 'image/png');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.detected).toBeNull();
    // 错误信息只说明签名不匹配，不回显任何文件内容片段
    expect(verdict.reason).not.toContain('php');
    expect(verdict.reason).not.toContain('not an image');
  });

  it('rejects a real PNG declared as JPEG (signature/declaration mismatch)', () => {
    const verdict = verifyImageSignature(bytesOf(REAL.png), 'image/jpeg');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.detected).toBe('image/png');
    expect(verdict.reason).toContain('image/jpeg');
    expect(verdict.reason).toContain('image/png');
  });

  it('rejects an unsupported declared MIME even when the bytes look like an image', () => {
    const verdict = verifyImageSignature(bytesOf(REAL.gif), 'text/plain');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.detected).toBe('image/gif');
  });

  it('tolerates surrounding whitespace and casing in the declared MIME', () => {
    expect(verifyImageSignature(bytesOf(REAL.jpeg), ' IMAGE/JPEG ')).toEqual({ ok: true, detected: 'image/jpeg' });
  });
});
