/**
 * Structured logger for Source platform
 * Uses pino in production, console wrapper in development
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
  level: LogLevel;
  msg: string;
  timestamp: string;
  [key: string]: unknown;
}

function formatEntry(level: LogLevel, msg: string, data?: Record<string, unknown>): LogEntry {
  return {
    level,
    msg,
    timestamp: new Date().toISOString(),
    ...data,
  };
}

const isProduction = process.env.NODE_ENV === 'production';

function log(level: LogLevel, msg: string, data?: Record<string, unknown>) {
  const entry = formatEntry(level, msg, data);

  if (isProduction) {
    // Structured JSON output for log aggregators (PM2, Docker, etc.)
    const output = JSON.stringify(entry);
    if (level === 'error' || level === 'fatal') {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  } else {
    // Human-readable dev output
    const prefix = { debug: '🔍', info: 'ℹ️', warn: '⚠️', error: '🔴', fatal: '💀' }[level];
    const extra = data ? ` ${JSON.stringify(data)}` : '';
    console[level === 'fatal' ? 'error' : level](`${prefix} [${level.toUpperCase()}] ${msg}${extra}`);
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => log('fatal', msg, data),

  /** Create a child logger with default context */
  child: (context: Record<string, unknown>) => ({
    debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, { ...context, ...data }),
    info: (msg: string, data?: Record<string, unknown>) => log('info', msg, { ...context, ...data }),
    warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, { ...context, ...data }),
    error: (msg: string, data?: Record<string, unknown>) => log('error', msg, { ...context, ...data }),
    fatal: (msg: string, data?: Record<string, unknown>) => log('fatal', msg, { ...context, ...data }),
  }),
};
