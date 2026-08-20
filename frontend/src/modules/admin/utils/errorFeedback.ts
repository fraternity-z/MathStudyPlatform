import type { ToastOptions } from '@/components/ui/Toast';
import { toAppError, type AppError } from '@/libs/http/apiClient';

const errorTitles: Record<AppError['kind'], string> = {
  cancelled: '请求已取消',
  network: '网络连接异常',
  timeout: '请求超时',
  unauthenticated: '登录状态已失效',
  forbidden: '无权执行此操作',
  validation: '请检查输入内容',
  not_found: '内容不存在',
  conflict: '内容已发生变化',
  rate_limited: '操作过于频繁',
  unavailable: '服务暂时不可用',
  server: '服务出现异常',
  unknown: '操作未完成',
};

export function toAdminAppError(error: unknown, fallback: string): AppError {
  return toAppError(error, fallback);
}

export function isAdminRequestCancelled(error: unknown): boolean {
  return toAppError(error).kind === 'cancelled';
}

export function getAdminErrorTitle(error: AppError, fallback?: string): string {
  return error.kind === 'unknown' && fallback ? fallback : errorTitles[error.kind];
}

export function getAdminErrorDescription(error: AppError): string {
  const details = [error.message];
  if (error.retryAfter !== undefined && error.retryAfter > 0) {
    details.push(`请等待 ${error.retryAfter} 秒后重试`);
  }
  if (error.requestId) details.push(`请求编号：${error.requestId}`);
  return details.join('\n');
}

export function getAdminErrorToast(
  error: unknown,
  fallback: string,
  fallbackTitle?: string,
): ToastOptions | null {
  const appError = toAdminAppError(error, fallback);
  if (appError.kind === 'cancelled') return null;

  return {
    type: appError.kind === 'conflict' || appError.kind === 'rate_limited' ? 'warning' : 'error',
    title: getAdminErrorTitle(appError, fallbackTitle),
    description: getAdminErrorDescription(appError),
    ...(appError.kind === 'rate_limited' ? { dedupeKey: 'api-rate-limited' } : {}),
  };
}
