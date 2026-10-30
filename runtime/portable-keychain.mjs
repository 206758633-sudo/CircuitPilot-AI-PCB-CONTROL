/**
 * Windows/Linux 的凭据存储（MVP 回退实现）。
 *
 * 为什么不是直接调用 OS 凭据库：macOS Keychain 有稳定 CLI；Windows Credential Manager /
 * Linux Secret Service 的读写需要额外原生依赖或系统工具，当前仓库尚未做真机验证。
 * 这里用 AES-256-GCM + 独立密钥文件做**加密本地存储**，至少不落明文，并保持 fail-closed。
 *
 * 重要边界（不得混淆）：
 * - 这不是 Windows DPAPI、也不是 Linux Secret Service；
 * - 安全性低于 OS 凭据库，只作为跨平台可用性回退，不能宣称"与 macOS Keychain 等同"；
 * - 真正发布前应替换为各平台原生凭据库并做真机验证。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { appDataDir } from './platform.mjs';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

function assertSecret(secret) {
  if (typeof secret !== 'string' || secret.trim().length < 12 || secret.length > 512) {
    throw fail('API Key格式无效', 'KEY_FORMAT_INVALID');
  }
  return secret.trim();
}

export class PortableKeychain {
  constructor({ file = path.join(appDataDir(), 'credentials.enc.json'), keyFile = path.join(appDataDir(), 'credentials.key'), platform = process.platform } = {}) {
    this.file = file;
    this.keyFile = keyFile;
    this.platform = platform;
  }

  ensureDir() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
  }

  ensureKey() {
    this.ensureDir();
    if (!existsSync(this.keyFile)) {
      writeFileSync(this.keyFile, randomBytes(KEY_BYTES), { mode: 0o600 });
      if (this.platform !== 'win32') chmodSync(this.keyFile, 0o600);
    }
    const key = readFileSync(this.keyFile);
    if (key.length !== KEY_BYTES) throw fail('凭据密钥文件损坏', 'KEYCHAIN_CORRUPT');
    return key;
  }

  load() {
    if (!existsSync(this.file)) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
        throw fail('凭据文件结构非法', 'KEYCHAIN_CORRUPT');
      }
      return parsed;
    } catch (error) {
      if (error.code === 'KEYCHAIN_CORRUPT') throw error;
      throw fail('凭据文件无法解析', 'KEYCHAIN_CORRUPT');
    }
  }

  save(store) {
    this.ensureDir();
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(store)}\n`, { mode: 0o600 });
    if (this.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    if (this.platform !== 'win32') chmodSync(this.file, 0o600);
  }

  async configured(provider) {
    return Boolean(this.load().entries[provider]);
  }

  async store(provider, secret) {
    const value = assertSecret(secret);
    const key = this.ensureKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const record = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    const store = this.load();
    store.entries[provider] = record;
    this.save(store);
    if (await this.read(provider) !== value) throw fail('凭据写入后回读校验失败', 'KEYCHAIN_WRITE_FAILED');
    return { configured: true, hint: `••••${value.slice(-4)}` };
  }

  async read(provider) {
    const record = this.load().entries[provider];
    if (!record) throw fail('Provider密钥未配置', 'KEY_NOT_CONFIGURED');
    try {
      const key = this.ensureKey();
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      const value = Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
      if (!value) throw fail('Provider密钥为空（请重新保存一次 API 密钥）', 'KEY_NOT_CONFIGURED');
      return value;
    } catch (error) {
      if (error.code === 'KEY_NOT_CONFIGURED' || error.code === 'KEYCHAIN_CORRUPT') throw error;
      throw fail('Provider密钥无法解密（密钥文件可能已更换）', 'KEYCHAIN_READ_FAILED');
    }
  }

  async remove(provider) {
    const store = this.load();
    delete store.entries[provider];
    this.save(store);
    return { configured: false };
  }
}

