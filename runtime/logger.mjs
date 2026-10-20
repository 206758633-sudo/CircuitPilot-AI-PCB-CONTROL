import { redactSecrets as redactLogValue } from './log-redaction.mjs';

const events = [];

/**
 * C8：日志统一走 `log-redaction`（敏感键整值替换、自由文本擦 Bearer/JWT/sk-/邮箱/本机路径、
 * 循环引用与超深/超长安全降级）。保留 `redact` 导出是为既有调用方/测试兼容。
 */
export function redact(value, _depth = 0) {
  return redactLogValue(value);
}

function write(level, module, message, data) {
  const event = {
    id: `runtime-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    ...(data === undefined ? {} : { data: redact(data) }),
  };
  events.unshift(event);
  events.length = Math.min(events.length, 300);
  const line = `${event.timestamp} [${level.toUpperCase()}] ${module}: ${message}`;
  const output = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  output(line, event.data ?? '');
  return event;
}

export const logger = {
  info: (module, message, data) => write('info', module, message, data),
  warn: (module, message, data) => write('warn', module, message, data),
  error: (module, message, data) => write('error', module, message, data),
};

export function listEvents() {
  return events.map((event) => redact(event));
}

export function clearEventsForTest() {
  events.length = 0;
}
