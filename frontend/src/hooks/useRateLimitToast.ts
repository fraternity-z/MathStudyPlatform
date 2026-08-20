/**
 * useRateLimitToast - 监听限流事件并显示友好提示
 *
 * 在应用根组件中使用一次即可。当 apiClient 的 429 重试耗尽时，
 * 会通过 rateLimitEvents 发射事件，本 hook 捕获后显示 Toast。
 *
 * 设计原则：
 * - 单一职责: 只负责限流事件 → Toast 的桥接
 * - 防抖: 短时间内多个 429 只显示一次提示
 */

import { useEffect } from 'react';
import { useToast } from '@/components/ui/Toast';
import { subscribeRateLimited } from '@/libs/http/rateLimitEvents';
import { toAppErrorFeedback } from '@/libs/http/appError';

export function useRateLimitToast() {
  const { toast } = useToast();

  useEffect(() => {
    const unsubscribe = subscribeRateLimited((detail) => {
      const feedback = toAppErrorFeedback({
        code: 'RATE_LIMITED',
        message: '请求次数已超过当前限制',
        retryAfter: detail.retryAfter,
        source: 'http',
      });
      if (feedback) toast({ ...feedback, duration: 5000 });
    });

    return unsubscribe;
  }, [toast]);
}
