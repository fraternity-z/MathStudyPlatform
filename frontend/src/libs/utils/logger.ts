/**
 * 统一日志管理系统
 *
 * 功能：
 * - 统一的日志接口
 * - 环境区分（开发/生产）
 * - 日志级别控制
 * - 安全日志记录（不记录敏感信息）
 * - 可扩展的日志输出（控制台、远程服务器等）
 */

import { hasUnsafeUrlCharacters } from '@/libs/utils/safeUrl';

export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4,
} as const;

export type LogLevel = typeof LogLevel[keyof typeof LogLevel];

interface LogConfig {
  level: LogLevel;
  enableConsole: boolean;
  enableRemote: boolean;
  remoteEndpoint?: string;
}

const remoteLogEndpoint = normalizeRemoteLogEndpoint(import.meta.env.VITE_LOG_REMOTE_ENDPOINT);
const REDACTED = '[REDACTED]';
const CIRCULAR_REFERENCE = '[Circular]';
const MAX_SANITIZE_DEPTH = 8;

const sensitiveKeyPatterns = [
  /password/i,
  /passphrase/i,
  /token/i,
  /secret/i,
  /api[_-]?key/i,
  /authorization/i,
  /cookie/i,
  /credential/i,
  /session/i,
  /csrf/i,
];

const sensitiveQueryPattern =
  /([?&](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret|password|authorization|cookie|csrf)[^=]*=)([^&#\s]+)/gi;
const sensitiveAssignmentPattern =
  /\b((?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret|password|cookie|csrf)\s*[:=]\s*)(["']?)[^"',;&\s]+/gi;
const bearerPattern = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const jwtPattern = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g;

function isSensitiveKey(key: string): boolean {
  return sensitiveKeyPatterns.some((pattern) => pattern.test(key));
}

function sanitizeString(value: string): string {
  return value
    .replace(bearerPattern, `$1${REDACTED}`)
    .replace(jwtPattern, REDACTED)
    .replace(sensitiveQueryPattern, `$1${REDACTED}`)
    .replace(sensitiveAssignmentPattern, `$1$2${REDACTED}`);
}

export function normalizeRemoteLogEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const endpoint = value.trim();
  if (!endpoint) {
    return undefined;
  }
  if (!endpoint.startsWith('/api/') || endpoint.startsWith('//')) {
    return undefined;
  }
  if (hasUnsafeUrlCharacters(endpoint)) {
    return undefined;
  }
  try {
    const parsed = new URL(endpoint, window.location.origin);
    if (parsed.origin !== window.location.origin) {
      return undefined;
    }
    return parsed.pathname + parsed.search;
  } catch {
    return undefined;
  }
}

export function sanitizeLogData(
  data: unknown,
  options: { includeStack?: boolean } = {}
): unknown {
  return sanitizeLogDataInternal(data, {
    includeStack: options.includeStack ?? false,
    seen: new WeakSet<object>(),
    depth: 0,
  });
}

function sanitizeLogDataInternal(
  data: unknown,
  context: { includeStack: boolean; seen: WeakSet<object>; depth: number }
): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return sanitizeString(data);
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return data;
  }

  if (typeof data === 'bigint') {
    return data.toString();
  }

  if (typeof data === 'symbol' || typeof data === 'function') {
    return `[${typeof data}]`;
  }

  if (context.depth > MAX_SANITIZE_DEPTH) {
    return '[MaxDepth]';
  }

  if (data instanceof Error) {
    return {
      name: sanitizeString(data.name),
      message: sanitizeString(data.message),
      stack: context.includeStack && data.stack ? sanitizeString(data.stack) : undefined,
    };
  }

  if (typeof data === 'object') {
    if (context.seen.has(data)) {
      return CIRCULAR_REFERENCE;
    }

    context.seen.add(data);

    if (Array.isArray(data)) {
      return data.map((item) =>
        sanitizeLogDataInternal(item, { ...context, depth: context.depth + 1 })
      );
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      sanitized[key] = isSensitiveKey(key)
        ? REDACTED
        : sanitizeLogDataInternal(value, { ...context, depth: context.depth + 1 });
    }

    return sanitized;
  }

  return data;
}

class Logger {
  private config: LogConfig;
  private isDevelopment: boolean;

  constructor() {
    this.isDevelopment = import.meta.env.DEV;
    this.config = {
      level: this.isDevelopment ? LogLevel.DEBUG : LogLevel.WARN,
      enableConsole: true,
      enableRemote: !this.isDevelopment && !!remoteLogEndpoint,
      remoteEndpoint: remoteLogEndpoint,
    };
  }

  /**
   * 配置日志系统
   */
  configure(config: Partial<LogConfig>) {
    this.config = { ...this.config, ...config };
  }

  /**
   * 调试日志
   */
  debug(message: string, data?: unknown) {
    this.log(LogLevel.DEBUG, message, data);
  }

  /**
   * 信息日志
   */
  info(message: string, data?: unknown) {
    this.log(LogLevel.INFO, message, data);
  }

  /**
   * 警告日志
   */
  warn(message: string, data?: unknown) {
    this.log(LogLevel.WARN, message, data);
  }

  /**
   * 错误日志
   */
  error(message: string, error?: unknown) {
    this.log(LogLevel.ERROR, message, error);
  }

  /**
   * 安全事件日志（登录失败、异常访问等）
   */
  security(event: string, details?: Record<string, unknown>) {
    const sanitizedDetails = this.sanitizeData(details);
    this.log(LogLevel.WARN, `[SECURITY] ${event}`, sanitizedDetails);

    // 安全事件总是发送到远程服务器
    if (this.config.enableRemote) {
      this.sendToRemote('security', event, sanitizedDetails);
    }
  }

  /**
   * 性能日志
   */
  performance(metric: string, value: number, unit = 'ms') {
    this.log(LogLevel.INFO, `[PERFORMANCE] ${metric}: ${value}${unit}`);
  }

  /**
   * 获取日志级别名称
   */
  private getLevelName(level: LogLevel): string {
    return Object.keys(LogLevel).find(
      key => LogLevel[key as keyof typeof LogLevel] === level
    ) || 'UNKNOWN';
  }

  /**
   * 核心日志方法
   */
  private log(level: LogLevel, message: string, data?: unknown) {
    if (level < this.config.level) {
      return;
    }

    const levelName = this.getLevelName(level);
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: levelName,
      message,
      data: this.sanitizeData(data),
    };

    if (this.config.enableConsole) {
      this.logToConsole(level, levelName, logEntry);
    }

    if (this.config.enableRemote && level >= LogLevel.WARN) {
      this.sendToRemote('log', message, logEntry);
    }
  }

  /**
   * 输出到控制台
   */
  private logToConsole(
    level: LogLevel,
    levelName: string,
    logEntry: { timestamp: string; message: string; data: unknown }
  ) {
    const prefix = `[${levelName}]`;
    const output = logEntry.data === undefined
      ? [prefix, logEntry.message]
      : [prefix, logEntry.message, logEntry.data];

    switch (level) {
      case LogLevel.DEBUG:
        console.debug(...output);
        break;
      case LogLevel.INFO:
        console.info(...output);
        break;
      case LogLevel.WARN:
        console.warn(...output);
        break;
      case LogLevel.ERROR:
        console.error(...output);
        break;
    }
  }

  /**
   * 发送日志到远程服务器
   */
  private async sendToRemote(type: string, message: string, data: unknown) {
    if (!this.config.remoteEndpoint) {
      return;
    }

    try {
      // 使用 sendBeacon API（不阻塞页面）或 fetch
      if (navigator.sendBeacon) {
        const blob = new Blob(
          [JSON.stringify({ type, message, data, timestamp: new Date().toISOString() })],
          { type: 'application/json' }
        );
        navigator.sendBeacon(this.config.remoteEndpoint, blob);
      } else {
        // 降级到 fetch（不等待响应）
        fetch(this.config.remoteEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, message, data, timestamp: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {
          // 忽略远程日志发送失败
        });
      }
    } catch {
      // 忽略远程日志发送失败，避免影响应用
    }
  }

  /**
   * 清理敏感数据
   */
  private sanitizeData(data: unknown): unknown {
    return sanitizeLogData(data, { includeStack: this.isDevelopment });
  }

  /**
   * 创建带上下文的日志记录器
   */
  createContextLogger(context: string) {
    return {
      debug: (message: string, data?: unknown) => this.debug(`[${context}] ${message}`, data),
      info: (message: string, data?: unknown) => this.info(`[${context}] ${message}`, data),
      warn: (message: string, data?: unknown) => this.warn(`[${context}] ${message}`, data),
      error: (message: string, error?: unknown) => this.error(`[${context}] ${message}`, error),
      security: (event: string, details?: Record<string, unknown>) =>
        this.security(`[${context}] ${event}`, details),
      performance: (metric: string, value: number, unit?: string) =>
        this.performance(`[${context}] ${metric}`, value, unit),
    };
  }
}

// 导出单例实例
export const logger = new Logger();

// 导出类型
export type ContextLogger = ReturnType<typeof logger.createContextLogger>;
