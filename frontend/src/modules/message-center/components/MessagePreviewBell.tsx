import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Bell,
  ChevronRight,
  Loader2,
  MessageSquare,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/libs/utils/cn';
import { formatRelativeTime } from '@/libs/utils/dateFormat';
import { RequestErrorNotice } from '@/components/feedback';
import type { MessagePreviewItem } from '@/modules/message-center/services/messageCenterService';
import { useMessageCenterSummary } from '@/modules/message-center/components/useMessageCenterSummary';

type PreviewType = MessagePreviewItem['type'];

const previewTypeStyle: Record<PreviewType, { label: string; dot: string; labelClass: string }> = {
  conversation: { label: '私信', dot: 'bg-blue-600', labelClass: 'text-blue-600 dark:text-blue-400' },
  notice: { label: '通知', dot: 'bg-orange-500', labelClass: 'text-orange-600 dark:text-orange-400' },
  thread: { label: '答疑', dot: 'bg-fuchsia-600', labelClass: 'text-fuchsia-600 dark:text-fuchsia-400' },
  forum: { label: '论坛', dot: 'bg-emerald-600', labelClass: 'text-emerald-600 dark:text-emerald-400' },
};

const stripPreviewType = (summary: string) => summary.replace(/^(私信|通知|答疑|论坛)\s*·\s*/, '');

function previewTab(type: PreviewType, isTeacher: boolean): string {
  if (type === 'conversation') return 'private';
  if (type === 'notice') return 'notices';
  if (type === 'thread') return isTeacher ? 'answers' : 'questions';
  return 'forum';
}

function previewTargetID(item: MessagePreviewItem): string {
  if (item.type !== 'forum') return item.navigation_id ?? item.target_id ?? item.id;
  return item.navigation_id ?? item.post_id ?? item.target_id ?? item.id;
}

function previewItemKey(item: MessagePreviewItem): string {
  return [item.type, item.id, item.navigation_id, item.target_id, item.post_id, item.reply_id, item.occurred_at]
    .filter(Boolean)
    .join(':');
}

interface MessagePreviewBellProps {
  cacheKey: string;
  isTeacher: boolean;
}

export const MessagePreviewBell: React.FC<MessagePreviewBellProps> = ({ cacheKey, isTeacher }) => {
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const {
    summary,
    isLoading,
    isRefreshing,
    error,
    refresh,
  } = useMessageCenterSummary({ cacheKey });
  const messagesPath = isTeacher ? '/teacher/messages' : '/messages';
  const unread = summary
    ? summary.conversation_count + summary.notice_count + summary.thread_count + (summary.forum_count ?? 0)
    : 0;
  const items = useMemo(() => [...(summary?.items ?? [])]
    .sort((left, right) => {
      if (left.pending !== right.pending) return left.pending ? -1 : 1;
      return Date.parse(right.occurred_at) - Date.parse(left.occurred_at);
    })
    .slice(0, 3), [summary]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const openCenter = () => {
    setOpen(false);
    navigate(messagesPath);
  };

  const openItem = (item: MessagePreviewItem) => {
    const query = new URLSearchParams({
      tab: previewTab(item.type, isTeacher),
      id: previewTargetID(item),
    });
    setOpen(false);
    navigate(`${messagesPath}?${query.toString()}`);
  };

  const retry = () => {
    void refresh().catch(() => undefined);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={unread > 0 ? `消息预览，${unread} 条待处理` : '消息预览'}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        className="relative grid h-9 w-9 place-items-center rounded-full text-surface-600 transition hover:bg-surface-100 hover:text-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-surface-300 dark:hover:bg-surface-800"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[9px] font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="消息预览"
          className="absolute right-0 top-full z-50 mt-2 w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-surface-200 bg-white shadow-lg dark:border-surface-700 dark:bg-surface-900"
        >
          <div className="flex items-center justify-between border-b border-surface-100 px-3 py-2 dark:border-surface-800">
            <span className="text-sm font-semibold">最新消息</span>
            <span className="flex items-center gap-1 text-[11px] text-surface-400">
              {isRefreshing && summary && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
              最近 3 条
            </span>
          </div>

          {error && summary ? (
            <RequestErrorNotice
              error={error}
              onRetry={isRefreshing ? undefined : retry}
              onRefresh={isRefreshing ? undefined : retry}
              className="rounded-none border-x-0 border-t-0 px-3 py-2 text-xs"
            />
          ) : null}

          {isLoading ? (
            <div className="grid h-24 place-items-center" role="status" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span className="sr-only">正在加载消息</span>
            </div>
          ) : error && !summary ? (
            <RequestErrorNotice
              error={error}
              onRetry={isRefreshing ? undefined : retry}
              onRefresh={isRefreshing ? undefined : retry}
              className="rounded-none border-x-0 border-t-0 px-3 py-4"
            />
          ) : items.length ? (
            <div>
              {items.map((item) => {
                const type = previewTypeStyle[item.type];
                return (
                  <button
                    key={previewItemKey(item)}
                    type="button"
                    onClick={() => openItem(item)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:hover:bg-surface-800"
                  >
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', type.dot)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      <span className="block truncate text-[11px]">
                        <span className={type.labelClass}>{type.label}</span>
                        <span className="text-surface-500"> · {stripPreviewType(item.summary)}</span>
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1 text-[11px] text-surface-400">
                      <span>{formatRelativeTime(item.occurred_at)}</span>
                      {item.pending && <span className="h-1.5 w-1.5 rounded-full bg-red-600" />}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="px-3 py-6 text-center text-sm text-surface-500">
              <MessageSquare className="mx-auto mb-1 h-4 w-4" />
              暂无消息
            </div>
          )}

          <button
            type="button"
            onClick={openCenter}
            className="flex w-full items-center justify-center gap-1 border-t border-surface-100 px-3 py-2 text-sm font-medium text-primary-600 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:border-surface-800 dark:hover:bg-primary-950/30"
          >
            进入消息中心 <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
};
