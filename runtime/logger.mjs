const SECRET_KEYS = /authorization|api[-_]?key|token|secret|password|credential/i;
const SECRET_VALUE = /(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{8,}|x-api-key\s*[:=]\s*\S+)/gi;
const events = [];

export function redact(value, depth = 0) {
  if (depth > 6) return '[DEPTH_LIMIT]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) ? '[REDACTED]' : redact(item, depth + 1)]));
  }
  return value;
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
