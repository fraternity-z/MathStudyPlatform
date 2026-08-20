import axios, { type AxiosError, type GenericAbortSignal, type InternalAxiosRequestConfig } from 'axios';
import { logger } from '../utils/logger';
import { handle401Error } from './tokenRefresh';
import { emitAuthExpired } from '../auth/authEvents';
import { csrfHeader } from '../auth/csrfToken';
import { authTokenStorage } from '../auth/tokenStorage';
import { emitRateLimited } from './rateLimitEvents';
import {
  formatAppErrorDescription,
  parseRetryAfterSeconds,
  toAppError,
} from './appError';

export {
  formatAppErrorDescription,
  getAppErrorTitle,
  isAppError,
  isAppErrorKind,
  isRequestCancelled,
  parseRetryAfterSeconds,
  toAppError,
  toAppErrorFeedback,
} from './appError';
export type { AppError, AppErrorFeedback, AppErrorKind } from './appError';

/**
 * Normalize API error detail to a single string for display.
 * FastAPI uses string for HTTPException.detail, or array of { loc, msg, type } for 422 validation.
 * Using detail as string directly can show "[object Object]" when it's an array.
 */
export function getApiErrorMessage(
  err: unknown,
  fallback = '请求失败，请稍后重试'
): string {
  return formatAppErrorDescription(toAppError(err, fallback));
}

// 创建 API 客户端专用日志记录器
const apiLogger = logger.createContextLogger('API');

// 扩展 axios 配置类型，添加重试标记
interface CustomAxiosRequestConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
  _rateLimitRetryCount?: number;
}

function canAutomaticallyRetry(config: CustomAxiosRequestConfig): boolean {
  const method = (config.method ?? 'get').toLowerCase();
  return method === 'get' || method === 'head' || method === 'options';
}

// 429 重试配置
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_BASE_DELAY_MS = 1000;

export function waitForRetryDelay(delayMs: number, signal?: GenericAbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new axios.CanceledError('Request canceled during rate limit retry'));
  }
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(new axios.CanceledError('Request canceled during rate limit retry'));
    };
    signal?.addEventListener?.('abort', handleAbort, { once: true });
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}

// Base axios instance
export const apiClient = axios.create({
  baseURL: '/api/v1', // Proxy in Vite will handle this
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // 允许发送 Cookie
});

// Request interceptor for Auth token
apiClient.interceptors.request.use(
  (config) => {
    const token = authTokenStorage.get();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
      apiLogger.debug('Request with auth token', {
        method: config.method,
        url: config.url,
      });
    }
    if (['post', 'put', 'patch', 'delete'].includes((config.method ?? '').toLowerCase())) {
      Object.assign(config.headers, csrfHeader());
    }
    return config;
  },
  (error) => {
    apiLogger.error('Request interceptor error', error);
    return Promise.reject(error);
  }
);

// Response interceptor for global error handling
apiClient.interceptors.response.use(
  (response) => {
    apiLogger.debug('Response received', {
      status: response.status,
      url: response.config.url,
    });
    return response;
  },
  async (error: AxiosError) => {
    // 请求被取消（如导航离开），静默忽略
    if (axios.isCancel(error)) {
      return Promise.reject(error);
    }

    const originalRequest = error.config as CustomAxiosRequestConfig;
    const isCaptchaEndpoint = originalRequest?.url?.includes('/auth/captcha') ?? false;

    // Handle 429 Too Many Requests — 自动重试（对用户透明）
    if (error.response?.status === 429 && originalRequest) {
      if (isCaptchaEndpoint) {
        const retryAfter = parseRetryAfterSeconds(error.response.headers['retry-after']) ?? 60;
        emitRateLimited({ retryAfter, url: originalRequest.url });
        return Promise.reject(error);
      }
      const retryCount = originalRequest._rateLimitRetryCount ?? 0;

      if (retryCount < RATE_LIMIT_MAX_RETRIES && canAutomaticallyRetry(originalRequest)) {
        originalRequest._rateLimitRetryCount = retryCount + 1;

        // 优先使用服务端 Retry-After 头，否则指数退避
        const retryAfterHeader = error.response.headers['retry-after'];
        const retryAfterSec = parseRetryAfterSeconds(retryAfterHeader) ?? 0;
        const delayMs = retryAfterSec > 0
          ? retryAfterSec * 1000
          : RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, retryCount);

        apiLogger.warn(`429 限流，${delayMs}ms 后重试 (${retryCount + 1}/${RATE_LIMIT_MAX_RETRIES})`, {
          url: originalRequest.url,
        });

        await waitForRetryDelay(delayMs, originalRequest.signal);
        return apiClient(originalRequest);
      }

      // 重试耗尽，通知用户
      const retryAfter = parseRetryAfterSeconds(error.response.headers['retry-after']) ?? 60;
      apiLogger.warn('429 限流重试耗尽，通知用户', { url: originalRequest.url });
      emitRateLimited({ retryAfter, url: originalRequest.url });
      return Promise.reject(error);
    }

    // Handle 401 Unauthorized
    if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
      apiLogger.security('Unauthorized access attempt', {
        url: error.config?.url,
        method: error.config?.method,
      });

      // 排除登录和刷新接口本身
      const isAuthEndpoint =
        originalRequest.url?.includes('/auth/login') ||
        originalRequest.url?.includes('/auth/refresh');

      if (!isAuthEndpoint) {
        // 标记为已重试，避免无限循环
        originalRequest._retry = true;

        // 尝试刷新 token
        const result = await handle401Error(async (newToken) => {
          // 更新请求头
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          // 重试原始请求
          return apiClient(originalRequest);
        });

        if (result.success) {
          return result.data;
        }

        // 刷新失败，清除认证状态并跳转登录页
        apiLogger.warn('Token 刷新失败，跳转登录页');
        authTokenStorage.clear();
        emitAuthExpired();

        // 根据当前路径决定跳转目标
        const isAdminRoute = window.location.pathname.startsWith('/admin');
        const loginPath = isAdminRoute ? '/admin' : '/welcome';

        // 避免重复跳转
        if (window.location.pathname !== loginPath) {
          window.location.href = loginPath;
        }
      }
    } else if (error.response) {
      // 服务器返回错误响应
      apiLogger.error('API error response', {
        status: error.response.status,
        url: error.config?.url,
        message: (error.response.data as { message?: string })?.message || error.message,
      });
    } else if (error.request) {
      // 请求已发送但没有收到响应
      apiLogger.error('No response from server', {
        url: error.config?.url,
        timeout: error.config?.timeout,
      });
    } else {
      // 请求配置错误
      apiLogger.error('Request configuration error', error);
    }
    return Promise.reject(error);
  }
);
