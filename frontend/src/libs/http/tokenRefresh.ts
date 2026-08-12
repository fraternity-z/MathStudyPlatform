/**
 * Token 刷新服务
 *
 * 处理 access token 刷新逻辑，包括并发请求的竞态处理
 */

import axios from 'axios';
import { logger } from '../utils/logger';
import { csrfHeader } from '../auth/csrfToken';
import { authTokenStorage } from '../auth/tokenStorage';

const refreshLogger = logger.createContextLogger('TokenRefresh');

// 所有并发调用共享同一个刷新请求
let refreshRequest: Promise<string | null> | null = null;

/**
 * 刷新 access token
 *
 * @returns 新的 access token，如果刷新失败返回 null
 */
async function requestAccessToken(): Promise<string | null> {
  try {
    // 使用独立的 axios 实例避免触发拦截器循环
    const response = await axios.post<{ access_token: string }>(
      '/api/v1/auth/refresh',
      {},
      {
        withCredentials: true, // 发送 HttpOnly Cookie
        headers: csrfHeader(),
      }
    );

    const newToken = response.data.access_token;
    refreshLogger.info('Token 刷新成功');
    return newToken;
  } catch (error) {
    refreshLogger.error('Token 刷新失败', error);
    return null;
  }
}

export function refreshAccessToken(): Promise<string | null> {
  if (refreshRequest) {
    return refreshRequest;
  }

  const request = requestAccessToken();
  refreshRequest = request;

  void request.finally(() => {
    // 只清理当前请求，避免旧请求清除后续刷新状态
    if (refreshRequest === request) {
      refreshRequest = null;
    }
  });

  return request;
}

/**
 * 处理 401 错误，尝试刷新 token
 *
 * @param retryRequest 重试原始请求的函数
 * @returns 是否成功刷新并重试
 */
export async function handle401Error<T>(
  retryRequest: (newToken: string) => Promise<T>
): Promise<{ success: boolean; data?: T }> {
  const newToken = await refreshAccessToken();

  if (!newToken) {
    return { success: false };
  }

  // 更新本地存储
  authTokenStorage.set(newToken);

  try {
    // 重试原始请求
    const data = await retryRequest(newToken);
    return { success: true, data };
  } catch {
    return { success: false };
  }
}

/**
 * 检查是否正在刷新 token
 */
export function isTokenRefreshing(): boolean {
  return refreshRequest !== null;
}
