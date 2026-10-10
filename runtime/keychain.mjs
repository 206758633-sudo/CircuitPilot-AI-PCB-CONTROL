import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICES } from './config.mjs';
import { runProcess } from './process.mjs';

function serviceFor(provider) {
  const service = KEYCHAIN_SERVICES[provider];
  if (!service) throw Object.assign(new Error('Unsupported keychain provider'), { code: 'KEYCHAIN_PROVIDER_UNSUPPORTED' });
  return service;
}

export class MacKeychain {
  async configured(provider) {
    const result = await runProcess('/usr/bin/security', ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', serviceFor(provider)]);
    return result.ok;
  }

  async store(provider, secret) {
    if (process.platform !== 'darwin') throw Object.assign(new Error('macOS Keychain is unavailable'), { code: 'KEYCHAIN_UNAVAILABLE' });
    if (typeof secret !== 'string' || secret.trim().length < 12 || secret.length > 512) {
      throw Object.assign(new Error('API Key格式无效'), { code: 'KEY_FORMAT_INVALID' });
    }
    const result = await runProcess('/usr/bin/security', ['add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', serviceFor(provider), '-U', '-w'], { stdin: secret.trim(), timeoutMs: 15_000 });
    if (!result.ok) throw Object.assign(new Error('无法写入macOS Keychain'), { code: 'KEYCHAIN_WRITE_FAILED' });
    return { configured: true, hint: `••••${secret.trim().slice(-4)}` };
  }

  async read(provider) {
    const result = await runProcess('/usr/bin/security', ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', serviceFor(provider), '-w']);
    if (!result.ok || !result.stdout) throw Object.assign(new Error('Provider密钥未配置'), { code: 'KEY_NOT_CONFIGURED' });
    return result.stdout;
  }

  async remove(provider) {
    const result = await runProcess('/usr/bin/security', ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', serviceFor(provider)]);
    if (!result.ok && !/could not be found/i.test(result.stderr || '')) {
      throw Object.assign(new Error('无法删除Keychain密钥'), { code: 'KEYCHAIN_DELETE_FAILED' });
    }
    return { configured: false };
  }
}
