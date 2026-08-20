import { useCallback, useState } from 'react';
import { Megaphone, Pin } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useSerialPolling } from '@/hooks/useSerialPolling';
import { useAppSelector } from '@/store';
import { selectCurrentUser, selectIsAuthenticated } from '@/modules/auth/store/authSlice';
import { toAppErrorFeedback } from '@/libs/http/apiClient';
import { formatDateOrFallback } from '@/libs/utils/dateFormat';
import { AnnouncementContent } from './AnnouncementContent';
import { announcementService } from './announcementService';
import {
  announcementRevisionKey,
  closeAnnouncementForSession,
  loadSessionClosedAnnouncementKeys,
} from './announcementSession';
import type { SystemAnnouncement } from './types';

const pollIntervalMs = 5 * 60 * 1000;

export function SystemAnnouncementDialog() {
  const isAuthenticated = useAppSelector(selectIsAuthenticated);
  const user = useAppSelector(selectCurrentUser);
  const { toast } = useToast();
  const [announcements, setAnnouncements] = useState<SystemAnnouncement[]>([]);
  const [isDismissing, setIsDismissing] = useState(false);
  const canReceive = Boolean(
    isAuthenticated && user && (user.role === 'student' || user.role === 'teacher')
  );

  const fetchAnnouncements = useCallback(async (signal: AbortSignal) => {
    if (!canReceive || !user) {
      setAnnouncements([]);
      return;
    }
    try {
      const response = await announcementService.listForUser(signal);
      if (signal.aborted) return;
      const closedKeys = loadSessionClosedAnnouncementKeys(user.id);
      setAnnouncements(
        response.items.filter((item) => !closedKeys.has(announcementRevisionKey(item)))
      );
    } catch {
      // Keep the last successful list visible during a transient polling failure.
    }
  }, [canReceive, user]);

  useSerialPolling(fetchAnnouncements, canReceive ? pollIntervalMs : 0);

  const current = announcements[0] ?? null;

  const closeCurrent = useCallback(() => {
    if (!current || !user) return;
    closeAnnouncementForSession(user.id, current);
    const key = announcementRevisionKey(current);
    setAnnouncements((items) => items.filter((item) => announcementRevisionKey(item) !== key));
  }, [current, user]);

  const dismissCurrent = useCallback(async () => {
    if (!current || current.persistent || !user) return;
    setIsDismissing(true);
    try {
      await announcementService.dismiss(current.id);
      setAnnouncements((items) => items.filter((item) => item.id !== current.id));
    } catch (error) {
      const feedback = toAppErrorFeedback(error, '暂时无法关闭该公告');
      if (feedback) toast(feedback);
    } finally {
      setIsDismissing(false);
    }
  }, [current, toast, user]);

  if (!current) return null;

  return (
    <Modal
      isOpen
      onClose={closeCurrent}
      title={
        <span className="flex w-full min-w-0 items-center justify-center gap-2 text-center">
          <Megaphone className="h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" />
          <span className="truncate">{current.title}</span>
        </span>
      }
      className="max-h-[calc(100vh-2rem)] max-w-3xl overflow-y-auto rounded-lg p-6"
    >
      <div className="relative z-1 space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-surface-500 dark:text-surface-400">
          <time dateTime={current.published_at}>
            {formatDateOrFallback(current.published_at, 'yyyy-MM-dd HH:mm')}
          </time>
          {current.persistent ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              <Pin className="h-3.5 w-3.5" />
              常驻
            </span>
          ) : null}
          {announcements.length > 1 ? <span>{`1 / ${announcements.length}`}</span> : null}
        </div>

        <div className="max-h-[min(58vh,560px)] overflow-auto rounded-md border border-surface-200 bg-white p-4 dark:border-surface-700 dark:bg-surface-900">
          <AnnouncementContent
            content={current.content}
            format={current.content_format}
            title={`${current.title} HTML 内容`}
          />
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-surface-200 pt-4 dark:border-surface-700 sm:flex-row sm:justify-end">
          {!current.persistent ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => void dismissCurrent()}
              disabled={isDismissing}
            >
              不再弹出
            </Button>
          ) : null}
          <Button type="button" variant="primary" onClick={closeCurrent}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  );
}
