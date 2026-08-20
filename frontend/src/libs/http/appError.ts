import axios, { type AxiosError } from 'axios';

export type AppErrorKind =
  | 'cancelled'
  | 'network'
  | 'timeout'
  | 'unauthenticated'
  | 'forbidden'
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'unavailable'
  | 'server'
  | 'unknown';

export interface AppError {
  kind: AppErrorKind;
  code?: string;
  status?: number;
  message: string;
  requestId?: string;
  retryAfter?: number;
  retryable: boolean;
  source: 'http' | 'sse' | 'ui';
}

export interface AppErrorFeedback {
  type: 'error' | 'info' | 'warning';
  title: string;
  description: string;
  dedupeKey?: string;
}

const APP_ERROR_KINDS = new Set<AppErrorKind>([
  'cancelled',
  'network',
  'timeout',
  'unauthenticated',
  'forbidden',
  'validation',
  'not_found',
  'conflict',
  'rate_limited',
  'unavailable',
  'server',
  'unknown',
]);

interface ErrorPayload {
  code?: unknown;
  detail?: unknown;
  error?: ErrorPayload;
  message?: unknown;
  request_id?: unknown;
  requestId?: unknown;
  retry_after?: unknown;
  retryAfter?: unknown;
}

interface StructuredErrorLike {
  code?: unknown;
  detail?: unknown;
  error?: StructuredErrorLike;
  message?: unknown;
  requestId?: unknown;
  request_id?: unknown;
  retryAfter?: unknown;
  retry_after?: unknown;
  retryable?: unknown;
  source?: unknown;
  status?: unknown;
}

const CONFLICT_CODES = new Set([
  'DAILY_QUESTION_STRATEGY_CHANGED',
  'FIRST_CHAT_IN_PROGRESS',
  'FIRST_CHAT_NOT_RESUMABLE',
  'SESSION_ID_CONFLICT',
  'STALE',
  'STALE_REVISION',
  'UNIFORM_SCHEDULE_CHANGED',
  'EXERCISE_CHANGED',
  'PORTRAIT_CHANGED',
  'REVIEW_TASK_STALE',
  'SUBMISSION_ID_CONFLICT',
  'DAILY_ASSIGNMENT_INVALID',
  'DAILY_ASSIGNMENT_COMPLETED',
  'MISTAKE_RECORD_ARCHIVED',
]);

const FORBIDDEN_CODES = new Set(['AI_ACCESS_BLOCKED', 'FORBIDDEN']);
const NOT_FOUND_CODES = new Set(['NOT_FOUND', 'SESSION_NOT_FOUND']);
const SERVER_CODES = new Set(['INTERNAL_ERROR', 'PROCESSING_ERROR']);
const TIMEOUT_CODES = new Set([
  'AI_GENERATION_TIMEOUT',
  'MATH_SOLVER_TIMEOUT',
  'OCR_TIMEOUT',
  'REQUEST_TIMEOUT',
  'TIMEOUT',
]);
const UNAUTHENTICATED_CODES = new Set(['UNAUTHENTICATED', 'UNAUTHORIZED']);
const UNAVAILABLE_CODES = new Set([
  'AI_GENERATION_UNAVAILABLE',
  'AI_GUARD_UNAVAILABLE',
  'MATH_SOLVER_UNAVAILABLE',
  'OCR_UNAVAILABLE',
]);
const VALIDATION_CODES = new Set([
  'AI_CONTENT_BLOCKED',
  'BAD_REQUEST',
  'FILE_TOO_LARGE',
  'INVALID_CONTENT_TYPE',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_ERROR',
]);

const ADDITIONAL_VALIDATION_CODES = new Set([
  'ANSWER_PARSE_FAILED',
  'CAPTCHA_INVALID',
  'CAPTCHA_REQUIRED',
  'CSRF_TOKEN_INVALID',
  'CSRF_TOKEN_MISSING',
  'INVALID_RANGE',
  'MATH_UNSUPPORTED',
  'OCR_UNREADABLE',
  'VERIFICATION_REQUIRED',
]);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function isAppError(error: unknown): error is AppError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Partial<AppError>;
  return typeof candidate.kind === 'string'
    && APP_ERROR_KINDS.has(candidate.kind as AppErrorKind)
    && typeof candidate.message === 'string'
    && typeof candidate.retryable === 'boolean'
    && (candidate.source === 'http' || candidate.source === 'sse' || candidate.source === 'ui');
}

export function getAppErrorTitle(
  kind: AppErrorKind,
  source?: AppError['source'],
): string {
  if (source === 'sse' && (kind === 'network' || kind === 'timeout')) {
    return '连接中断';
  }
  switch (kind) {
    case 'cancelled':
      return '操作已取消';
    case 'network':
      return '网络连接异常';
    case 'timeout':
      return '请求超时';
    case 'unauthenticated':
      return '登录状态已失效';
    case 'forbidden':
      return '无法访问此内容';
    case 'validation':
      return '请检查输入内容';
    case 'not_found':
      return '内容不存在';
    case 'conflict':
      return '内容已发生变化';
    case 'rate_limited':
      return '操作过于频繁';
    case 'unavailable':
      return '服务暂时不可用';
    case 'server':
      return '服务出现异常';
    default:
      return '操作未完成';
  }
}

export function formatAppErrorDescription(error: AppError): string {
  const details = [error.message];
  if (error.retryAfter !== undefined && error.retryAfter > 0) {
    details.push(`请等待 ${error.retryAfter} 秒后重试`);
  }
  if (error.requestId) details.push(`请求编号：${error.requestId}`);
  return details.join('\n');
}

export function toAppErrorFeedback(
  error: unknown,
  fallback = '请求失败，请稍后重试'
): AppErrorFeedback | null {
  const appError = toAppError(error, fallback);
  if (appError.kind === 'cancelled') return null;

  const isWarning = appError.kind === 'conflict' || appError.kind === 'rate_limited';
  const dedupeKey = appError.kind === 'rate_limited'
    ? 'api-rate-limited'
    : appError.requestId
      ? `app-error:${appError.requestId}`
      : undefined;
  return {
    type: isWarning ? 'warning' : 'error',
    title: getAppErrorTitle(appError.kind, appError.source),
    description: formatAppErrorDescription(appError),
    ...(dedupeKey ? { dedupeKey } : {}),
  };
}

function finiteInteger(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
}

function detailMessage(detail: unknown): string | undefined {
  const direct = nonEmptyString(detail);
  if (direct) return direct;
  if (!Array.isArray(detail)) return undefined;

  for (const item of detail) {
    if (typeof item !== 'object' || item === null) continue;
    const message = nonEmptyString((item as { msg?: unknown }).msg);
    if (message) return message;
  }
  return undefined;
}

function headerValue(error: AxiosError, name: string): string | undefined {
  const headers = error.response?.headers;
  if (!headers) return undefined;
  const value = typeof headers.get === 'function'
    ? headers.get(name)
    : (() => {
      const record = headers as Record<string, unknown>;
      const normalizedName = name.toLowerCase();
      const direct = record[normalizedName] ?? record[name];
      if (direct !== undefined) return direct;
      const matchingKey = Object.keys(record).find((key) => key.toLowerCase() === normalizedName);
      return matchingKey ? record[matchingKey] : undefined;
    })();
  return nonEmptyString(value);
}

export function parseRetryAfterSeconds(value: unknown, now = Date.now()): number | undefined {
  if (typeof value === 'number') return finiteInteger(value);
  const raw = nonEmptyString(value);
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return finiteInteger(raw);

  const deadline = Date.parse(raw);
  if (Number.isNaN(deadline)) return undefined;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

function kindFor(status: number | undefined, code: string | undefined): AppErrorKind {
  const normalizedCode = code?.toUpperCase();
  if (normalizedCode === 'CANCELLED' || normalizedCode === 'ERR_CANCELED') return 'cancelled';
  if (normalizedCode === 'CONNECTION_ERROR' || normalizedCode === 'NETWORK_ERROR') return 'network';
  if (normalizedCode && TIMEOUT_CODES.has(normalizedCode)) return 'timeout';
  if (normalizedCode && UNAUTHENTICATED_CODES.has(normalizedCode)) return 'unauthenticated';
  if (normalizedCode && FORBIDDEN_CODES.has(normalizedCode)) return 'forbidden';
  if (normalizedCode && NOT_FOUND_CODES.has(normalizedCode)) return 'not_found';
  if (normalizedCode && VALIDATION_CODES.has(normalizedCode)) return 'validation';
  if (normalizedCode && ADDITIONAL_VALIDATION_CODES.has(normalizedCode)) return 'validation';
  if (normalizedCode && UNAVAILABLE_CODES.has(normalizedCode)) return 'unavailable';
  if (normalizedCode && (
    CONFLICT_CODES.has(normalizedCode)
    || normalizedCode === 'CONFLICT'
    || normalizedCode.endsWith('_CHANGED')
    || normalizedCode.endsWith('_CONFLICT')
    || normalizedCode.endsWith('_STALE')
    || normalizedCode.endsWith('_LOCKED')
    || normalizedCode.endsWith('_SCHEDULED')
    || normalizedCode.endsWith('_NOT_DUE')
    || normalizedCode.endsWith('_NOT_PUBLISHED')
    || normalizedCode.endsWith('_IN_USE')
    || normalizedCode.endsWith('_IN_PROGRESS')
  )) return 'conflict';
  if (
    normalizedCode?.includes('RATE_LIMIT')
    || normalizedCode === 'AI_DAILY_QUOTA_EXCEEDED'
    || normalizedCode === 'AI_CONCURRENCY_LIMIT'
  ) {
    return 'rate_limited';
  }
  if (normalizedCode && SERVER_CODES.has(normalizedCode)) return 'server';

  if (normalizedCode?.endsWith('_NOT_FOUND')) return 'not_found';
  if (normalizedCode?.endsWith('_INVALID') || normalizedCode?.endsWith('_REQUIRED')) return 'validation';
  if (normalizedCode?.endsWith('_UNAVAILABLE') || normalizedCode?.endsWith('_NOT_CONFIGURED')) return 'unavailable';

  switch (status) {
    case 400:
    case 413:
    case 415:
    case 422:
      return 'validation';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 408:
    case 504:
      return 'timeout';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    case 502:
    case 503:
      return 'unavailable';
    default:
      return status !== undefined && status >= 500 ? 'server' : 'unknown';
  }
}

function retryableFor(kind: AppErrorKind): boolean {
  return kind === 'network'
    || kind === 'timeout'
    || kind === 'rate_limited'
    || kind === 'unavailable'
    || kind === 'server';
}

function isAbortError(error: unknown): boolean {
  return axios.isCancel(error)
    || (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError');
}

function fromAxiosError(error: AxiosError<ErrorPayload>, fallback: string): AppError {
  if (isAbortError(error)) {
    return { kind: 'cancelled', message: '请求已取消', retryable: false, source: 'http' };
  }

  const payload = error.response?.data;
  const nestedPayload = payload?.error;
  const code = nonEmptyString(payload?.code) ?? nonEmptyString(nestedPayload?.code);
  const status = error.response?.status;
  const requestId = headerValue(error, 'x-request-id')
    ?? nonEmptyString(payload?.request_id)
    ?? nonEmptyString(payload?.requestId)
    ?? nonEmptyString(nestedPayload?.request_id)
    ?? nonEmptyString(nestedPayload?.requestId);
  const retryAfter = parseRetryAfterSeconds(headerValue(error, 'retry-after'))
    ?? parseRetryAfterSeconds(payload?.retry_after ?? payload?.retryAfter)
    ?? parseRetryAfterSeconds(nestedPayload?.retry_after ?? nestedPayload?.retryAfter);

  if (!error.response) {
    const timedOut = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return {
      kind: timedOut ? 'timeout' : 'network',
      ...(nonEmptyString(error.code) ? { code: nonEmptyString(error.code) } : {}),
      message: timedOut
        ? '请求超时，请稍后重试'
        : offline
          ? '网络连接已断开，请检查网络'
          : '无法连接到服务器，请检查网络',
      retryable: true,
      source: 'http',
    };
  }

  const kind = kindFor(status, code);
  return {
    kind,
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    message: nonEmptyString(payload?.message)
      ?? detailMessage(payload?.detail)
      ?? nonEmptyString(nestedPayload?.message)
      ?? fallback,
    ...(requestId ? { requestId } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    retryable: retryableFor(kind),
    source: 'http',
  };
}

function fromStructuredError(error: StructuredErrorLike, fallback: string): AppError {
  const nested = error.error;
  const code = nonEmptyString(error.code) ?? nonEmptyString(nested?.code);
  const status = finiteInteger(error.status) ?? finiteInteger(nested?.status);
  const kind = kindFor(status, code);
  const source = error.source === 'http' || error.source === 'sse' ? error.source : 'ui';
  const requestId = nonEmptyString(error.requestId)
    ?? nonEmptyString(error.request_id)
    ?? nonEmptyString(nested?.requestId)
    ?? nonEmptyString(nested?.request_id);
  const retryAfter = parseRetryAfterSeconds(error.retryAfter ?? error.retry_after)
    ?? parseRetryAfterSeconds(nested?.retryAfter ?? nested?.retry_after);
  const retryable = typeof error.retryable === 'boolean'
    ? error.retryable
    : typeof nested?.retryable === 'boolean'
      ? nested.retryable
    : retryableFor(kind);

  return {
    kind,
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    message: nonEmptyString(error.message)
      ?? detailMessage(error.detail)
      ?? nonEmptyString(nested?.message)
      ?? detailMessage(nested?.detail)
      ?? fallback,
    ...(requestId ? { requestId } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    retryable,
    source,
  };
}

export function toAppError(error: unknown, fallback = '请求失败，请稍后重试'): AppError {
  if (isAppError(error)) return error;
  if (axios.isAxiosError<ErrorPayload>(error)) return fromAxiosError(error, fallback);
  if (isAbortError(error)) {
    return { kind: 'cancelled', message: '请求已取消', retryable: false, source: 'ui' };
  }
  if (typeof error === 'object' && error !== null) {
    return fromStructuredError(error as StructuredErrorLike, fallback);
  }
  return {
    kind: 'unknown',
    message: nonEmptyString(error) ?? fallback,
    retryable: false,
    source: 'ui',
  };
}

export function isAppErrorKind(error: unknown, kind: AppErrorKind): boolean {
  return toAppError(error).kind === kind;
}

export function isRequestCancelled(error: unknown): boolean {
  return isAppErrorKind(error, 'cancelled');
}
