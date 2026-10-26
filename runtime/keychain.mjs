import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICES, customKeychainService } from './config.mjs';
import { runProcess } from './process.mjs';

// 自定义 Provider 的 id 规则与 customProviders.mjs 的校验一致（小写字母开头，2~40 字符）。
// 只有形状合法的 id 才允许派生钥匙串服务名：否则任意字符串都能被拼进 -s 参数，
// 让"未知 Provider"变成一个能探测钥匙串的通道。
const CUSTOM_PROVIDER_ID = /^[a-z][a-z0-9._-]{1,39}$/;

/** Provider id → 钥匙串服务名。内置平台查声明表；其余按自定义 Provider 规则派生。 */
export function serviceFor(provider) {
  const service = KEYCHAIN_SERVICES[provider];
  if (service) return service;
  if (typeof provider === 'string' && CUSTOM_PROVIDER_ID.test(provider)) return customKeychainService(provider);
  throw Object.assign(new Error('Unsupported keychain provider'), { code: 'KEYCHAIN_PROVIDER_UNSUPPORTED' });
}

export class MacKeychain {
  /**
   * @param {{ run?: typeof runProcess }} options 仅测试注入（真实调用必须走 runProcess）。
   */
  constructor({ run = runProcess } = {}) {
    this.run = run;
  }

  async configured(provider) {
    const result = await this.run('/usr/bin/security', ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', serviceFor(provider)]);
    return result.ok;
  }

  /**
   * 写入钥匙串，并且**回读自证**成功。
   *
   * 真实故障（macOS 26）：`security add-generic-password ... -w` 在非 tty 环境下会用两次
   * 交互式提示读取密码（"password data for new item:" + "retype password"）。只喂一行时第二次
   * 读到 EOF，于是要么报 "passwords don't match"、要么把空密码写进条目；接口却返回成功。
   * 之后每次读取都是 KEY_NOT_CONFIGURED —— 用户看到的就是"我明明配了 Key，还说没配"。
   *
   * 因此：两次提示喂同一份密码 → 失败再退回 argv 直传（密码短暂出现在进程参数里，
   * 但远好过"存了个空密码还以为成功"）→ 最后回读比对；比对不上就删掉重来一次。
   */
  async store(provider, secret) {
    if (process.platform !== 'darwin') throw Object.assign(new Error('macOS Keychain is unavailable'), { code: 'KEYCHAIN_UNAVAILABLE' });
    if (typeof secret !== 'string' || secret.trim().length < 12 || secret.length > 512) {
      throw Object.assign(new Error('API Key格式无效'), { code: 'KEY_FORMAT_INVALID' });
    }
    const value = secret.trim();
    const service = serviceFor(provider);
    const addWithStdin = () => this.run('/usr/bin/security', ['add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service, '-U', '-w'], { stdin: `${value}\n${value}`, timeoutMs: 15_000 });
    const addWithArgv = () => this.run('/usr/bin/security', ['add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service, '-U', '-w', value], { timeoutMs: 15_000 });
    const verify = async () => {
      try { return (await this.read(provider)) === value; } catch { return false; }
    };

    for (const add of [addWithStdin, addWithArgv]) {
      const result = await add();
      if (result.ok && await verify()) return { configured: true, hint: `••••${value.slice(-4)}` };
    }
    // 典型情况：条目已存在但密码为空（历史版本写坏的），需要用删除后重建来修好。
    try { await this.remove(provider); } catch { /* 删除失败也要继续尝试重建 */ }
    for (const add of [addWithStdin, addWithArgv]) {
      const result = await add();
      if (result.ok && await verify()) return { configured: true, hint: `••••${value.slice(-4)}` };
    }
    throw Object.assign(new Error('无法写入macOS Keychain：写入后回读校验失败（可能存成了空密码），请重试或在“钥匙串访问”里删除该条目'), { code: 'KEYCHAIN_WRITE_FAILED' });
  }

  async read(provider) {
    const result = await this.run('/usr/bin/security', ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', serviceFor(provider), '-w']);
    const value = result.stdout || '';
    if (!result.ok || !value) {
      // 条目存在但密码为空 = 历史版本写入失败，必须说清楚"重新保存一次"，否则用户只会看到
      // "密钥未配置"而以为自己没配。
      const empty = result.ok && !value;
      throw Object.assign(new Error(empty ? 'Provider密钥为空（钥匙串条目存在但内容为空，请重新保存一次 API 密钥）' : 'Provider密钥未配置'), { code: 'KEY_NOT_CONFIGURED' });
    }
    return value;
  }

  async remove(provider) {
    const result = await this.run('/usr/bin/security', ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', serviceFor(provider)]);
    if (!result.ok && !/could not be found/i.test(result.stderr || '')) {
      throw Object.assign(new Error('无法删除Keychain密钥'), { code: 'KEYCHAIN_DELETE_FAILED' });
    }
    return { configured: false };
  }
}
