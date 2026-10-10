type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private formatTimestamp() {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];
    const ms = now.getMilliseconds().toString().padStart(3, '0');
    return `${date} ${time}.${ms}`;
  }

  private log(level: LogLevel, module: string, message: string, data?: unknown) {
    const prefix = `${this.formatTimestamp()} [${level.toUpperCase()}] [${module}]`;
    const method = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
    if (data === undefined) method(prefix, message);
    else method(prefix, message, data);
  }

  debug(module: string, message: string, data?: unknown) {
    if (import.meta.env.DEV) this.log('debug', module, message, data);
  }

  info(module: string, message: string, data?: unknown) {
    this.log('info', module, message, data);
  }

  warn(module: string, message: string, data?: unknown) {
    this.log('warn', module, message, data);
  }

  error(module: string, message: string, data?: unknown) {
    this.log('error', module, message, data);
  }
}

export const logger = new Logger();

export function safeError(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
}
