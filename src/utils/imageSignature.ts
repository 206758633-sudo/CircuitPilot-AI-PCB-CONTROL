/**
 * 图片魔数（文件签名）校验。
 *
 * 浏览器上报的 `File.type` 完全由客户端控制，可以伪造成 `image/png` 而内容其实是任意文本。
 * Runtime 会在服务端拒绝伪造图片，但客户端必须“失败关闭”（fail closed）：
 * 只有真实签名与声明 MIME 一致时才接受附件，避免把伪造载荷送进对话链路。
 *
 * 该模块只做纯字节比较，不读取、不返回任何文件正文，因此错误信息可以安全地对外展示。
 */

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type ImageMime = typeof IMAGE_MIME_TYPES[number];

export type ImageSignatureVerdict =
  | { ok: true; detected: ImageMime }
  | { ok: false; detected: ImageMime | null; reason: string };

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]; // 89 50 4E 47
const JPEG_MAGIC = [0xff, 0xd8, 0xff]; // FF D8 FF
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38]; // GIF8
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46]; // RIFF
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50]; // WEBP（WebP为RIFF容器，偏移8字节）

function startsWith(bytes: Uint8Array, offset: number, magic: number[]): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[offset + index] !== magic[index]) return false;
  }
  return true;
}

/** 仅根据字节判断真实图片类型；无法识别时返回 null。不会读取文件正文以外的任何信息。 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (startsWith(bytes, 0, PNG_MAGIC)) return 'image/png';
  if (startsWith(bytes, 0, JPEG_MAGIC)) return 'image/jpeg';
  if (startsWith(bytes, 0, GIF_MAGIC)) return 'image/gif';
  if (startsWith(bytes, 0, RIFF_MAGIC) && startsWith(bytes, 8, WEBP_MAGIC)) return 'image/webp';
  return null;
}

export function isSupportedImageMime(mime: string): mime is ImageMime {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mime.trim().toLowerCase());
}

/**
 * 校验声明 MIME 与真实文件签名是否一致。
 * 返回的 `reason` 只包含声明类型 / 识别出的类型，绝不包含文件内容片段。
 */
export function verifyImageSignature(bytes: Uint8Array, declaredMime: string): ImageSignatureVerdict {
  const declared = declaredMime.trim().toLowerCase();
  const detected = sniffImageMime(bytes);
  if (!detected) {
    return { ok: false, detected: null, reason: '文件内容不含PNG/JPEG/GIF/WebP文件签名，已按失败关闭拒绝' };
  }
  if (!isSupportedImageMime(declared)) {
    return { ok: false, detected, reason: `声明类型 ${declared || '（空）'} 不是受支持的图片类型` };
  }
  if (detected !== declared) {
    return { ok: false, detected, reason: `声明类型为 ${declared}，但文件签名是 ${detected}` };
  }
  return { ok: true, detected };
}
