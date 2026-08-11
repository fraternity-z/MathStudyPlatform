/**
 * 请求去重工具
 *
 * 防止相同的 API 请求在完成前重复发送
 * 遵循 KISS 原则，使用简单的 Map 实现
 */

interface PendingRequest<T> {
  promise: Promise<T>;
}

/**
 * 请求去重管理器
 */
class RequestDeduplicationManager {
  // 存储正在进行的请求
  private pendingRequests = new Map<string, PendingRequest<unknown>>();

  /**
   * 生成请求的唯一键
   */
  private generateKey(url: string, params?: Record<string, unknown>): string {
    const paramsStr = params ? JSON.stringify(params) : '';
    return `${url}:${paramsStr}`;
  }

  /**
   * 执行去重请求
   *
   * @param url - 请求 URL
   * @param requestFn - 实际的请求函数
   * @param params - 请求参数（用于生成唯一键）
   * @returns Promise<T>
   *
   * @example
   * ```ts
   * const data = await requestDeduplication.dedupe(
   *   '/api/v1/knowledge/stats',
   *   () => apiClient.get('/api/v1/knowledge/stats'),
   *   {}
   * );
   * ```
   */
  async dedupe<T>(
    url: string,
    requestFn: () => Promise<T>,
    params?: Record<string, unknown>
  ): Promise<T> {
    const key = this.generateKey(url, params);

    // 如果已有相同的请求正在进行，直接返回该 Promise
    const existing = this.pendingRequests.get(key);
    if (existing) {
      return existing.promise as Promise<T>;
    }

    const entry: PendingRequest<T> = {
      promise: requestFn(),
    };
    this.pendingRequests.set(key, entry);

    try {
      return await entry.promise;
    } finally {
      // A slow expired request must not remove a newer request using the same key.
      if (this.pendingRequests.get(key) === entry) {
        this.pendingRequests.delete(key);
      }
    }
  }

  /** 清除所有进行中的请求记录。 */
  clear(): void {
    this.pendingRequests.clear();
  }

  /** 清除指定 URL 的进行中请求记录。 */
  clearByUrl(url: string): void {
    for (const key of this.pendingRequests.keys()) {
      if (key.startsWith(`${url}:`)) {
        this.pendingRequests.delete(key);
      }
    }
  }

  /** 获取当前进行中的请求数量。 */
  get size(): number {
    return this.pendingRequests.size;
  }
}

/**
 * 全局请求去重管理器实例
 */
export const requestDeduplication = new RequestDeduplicationManager();
