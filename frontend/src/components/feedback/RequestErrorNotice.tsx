import { AlertCircle, RefreshCw, RotateCcw, X } from 'lucide-react';
import { getAppErrorTitle, type AppError } from '@/libs/http/appError';
import { cn } from '@/libs/utils/cn';
import { Button } from '@/components/ui/Button';

export interface RequestErrorNoticeProps {
  error: AppError;
  onRetry?: () => void;
  onRefresh?: () => void;
  onDismiss?: () => void;
  className?: string;
}

export function RequestErrorNotice({
  error,
  onRetry,
  onRefresh,
  onDismiss,
  className,
}: RequestErrorNoticeProps) {
  if (error.kind === 'cancelled') return null;

  const isWarning = error.kind === 'conflict' || error.kind === 'rate_limited';
  const canRetry = error.retryable && error.kind !== 'conflict' && Boolean(onRetry);
  const canRefresh = error.kind === 'conflict' && Boolean(onRefresh);

  return (
    <div
      role="alert"
      aria-atomic="true"
      className={cn(
        'flex items-start gap-3 rounded-md border px-4 py-3 text-sm',
        isWarning
          ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100'
          : 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-100',
        className
      )}
    >
      <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />

      <div className="min-w-0 flex-1">
        <p className="font-medium">{getAppErrorTitle(error.kind, error.source)}</p>
        <p className="mt-1 leading-5 opacity-90">{error.message}</p>
        {error.retryAfter !== undefined && error.retryAfter > 0 ? (
          <p className="mt-1.5 text-xs opacity-75">
            可在 {error.retryAfter} 秒后重试
          </p>
        ) : null}
        {error.requestId ? (
          <p className="mt-1.5 text-xs opacity-75">
            请求编号：<code className="break-all font-mono">{error.requestId}</code>
          </p>
        ) : null}

        {canRetry || canRefresh ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {canRetry ? (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden="true" />
                重试
              </Button>
            ) : null}
            {canRefresh ? (
              <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
                <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
                刷新数据
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md opacity-70 transition-colors hover:bg-black/5 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current dark:hover:bg-white/10"
          aria-label="关闭错误提示"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
