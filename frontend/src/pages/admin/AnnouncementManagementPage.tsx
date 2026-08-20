import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Megaphone,
  Pencil,
  Pin,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { AdminLayout } from '@/modules/admin/components/AdminLayout';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';
import { formatDateOrFallback } from '@/libs/utils/dateFormat';
import { announcementService } from '@/modules/announcement/announcementService';
import { AnnouncementEditorModal } from '@/modules/announcement/AnnouncementEditorModal';
import type {
  AnnouncementAudience,
  SaveAnnouncementRequest,
  SystemAnnouncement,
} from '@/modules/announcement/types';
import {
  getAdminErrorToast,
  isAdminRequestCancelled,
  toAdminAppError,
} from '@/modules/admin/utils/errorFeedback';

const audienceLabels: Record<AnnouncementAudience, string> = {
  student: '学生',
  teacher: '教师',
  all: '学生与教师',
};

function payloadFromAnnouncement(
  announcement: SystemAnnouncement,
  isActive = announcement.is_active
): SaveAnnouncementRequest {
  return {
    title: announcement.title,
    content: announcement.content,
    content_format: announcement.content_format,
    audience: announcement.audience,
    append: announcement.append,
    persistent: announcement.persistent,
    is_active: isActive,
  };
}

export function AnnouncementManagementPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<SystemAnnouncement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SystemAnnouncement | null>(null);
  const loadGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  const loadItems = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    const response = await announcementService.listForAdmin(signal);
    if (!signal?.aborted && mountedRef.current && generation === loadGenerationRef.current) {
      setItems(response.items);
      setError(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void loadItems(controller.signal)
      .catch((loadError) => {
        if (!controller.signal.aborted) {
          if (!isAdminRequestCancelled(loadError)) {
            setError(toAdminAppError(loadError, '获取公告列表失败'));
          }
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, [loadItems]);

  const activeCount = useMemo(() => items.filter((item) => item.is_active).length, [items]);

  const handleRefresh = async () => {
    if (isMutating || isSaving) return;
    setIsRefreshing(true);
    try {
      await loadItems();
    } catch (refreshError) {
      const feedback = getAdminErrorToast(refreshError, '刷新公告失败', '刷新失败');
      if (feedback) toast(feedback);
    } finally {
      if (mountedRef.current) setIsRefreshing(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (announcement: SystemAnnouncement) => {
    setEditing(announcement);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    if (isSaving) return;
    setEditorOpen(false);
    setEditing(null);
  };

  const handleSave = async (payload: SaveAnnouncementRequest) => {
    if (isSaving || isMutating) return;
    setIsSaving(true);
    try {
      if (editing) {
        await announcementService.update(editing.id, payload);
      } else {
        await announcementService.create(payload);
      }
      await loadItems();
      if (!mountedRef.current) return;
      setEditorOpen(false);
      setEditing(null);
      toast({ type: 'success', title: editing ? '公告已更新' : '公告已发布' });
    } catch (saveError) {
      const feedback = getAdminErrorToast(
        saveError,
        editing ? '更新公告失败' : '发布公告失败',
        editing ? '更新失败' : '发布失败',
      );
      if (feedback) toast(feedback);
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  };

  const handleToggleActive = async (announcement: SystemAnnouncement) => {
    if (isMutating || isSaving) return;
    setIsMutating(true);
    try {
      await announcementService.update(
        announcement.id,
        payloadFromAnnouncement(announcement, !announcement.is_active)
      );
      await loadItems();
      toast({ type: 'success', title: announcement.is_active ? '公告已停用' : '公告已启用' });
    } catch (toggleError) {
      const feedback = getAdminErrorToast(toggleError, '更新公告状态失败', '状态更新失败');
      if (feedback) toast(feedback);
    } finally {
      if (mountedRef.current) setIsMutating(false);
    }
  };

  const handleDelete = async (announcement: SystemAnnouncement) => {
    if (isMutating || isSaving) return;
    if (!window.confirm(`确定删除公告“${announcement.title}”吗？`)) return;
    setIsMutating(true);
    try {
      await announcementService.delete(announcement.id);
      if (mountedRef.current) {
        setItems((current) => current.filter((item) => item.id !== announcement.id));
      }
      toast({ type: 'success', title: '公告已删除' });
    } catch (deleteError) {
      const feedback = getAdminErrorToast(deleteError, '删除公告失败', '删除失败');
      if (feedback) toast(feedback);
    } finally {
      if (mountedRef.current) setIsMutating(false);
    }
  };

  return (
    <AdminLayout>
      <div className="container mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <Megaphone className="h-7 w-7 text-primary-600 dark:text-primary-400" />
              <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100">系统公告</h1>
            </div>
            <p className="mt-2 text-sm text-surface-500 dark:text-surface-400">
              {`共 ${items.length} 条，${activeCount} 条生效中`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void handleRefresh()}
              disabled={isRefreshing || isMutating || isSaving}
              aria-label="刷新公告"
              title="刷新公告"
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Button type="button" onClick={openCreate} disabled={isRefreshing || isMutating || isSaving}>
              <Plus className="mr-2 h-4 w-4" />
              发布公告
            </Button>
          </div>
        </header>

        {error ? (
          <RequestErrorNotice
            error={error}
            onRetry={() => void handleRefresh()}
            onRefresh={() => void handleRefresh()}
          />
        ) : null}

        <div className="overflow-hidden rounded-lg border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-224 text-left text-sm">
              <thead className="border-b border-surface-200 bg-surface-50 text-xs uppercase text-surface-500 dark:border-surface-800 dark:bg-surface-950 dark:text-surface-400">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">公告</th>
                  <th scope="col" className="px-4 py-3 font-semibold">受众</th>
                  <th scope="col" className="px-4 py-3 font-semibold">格式</th>
                  <th scope="col" className="px-4 py-3 font-semibold">策略</th>
                  <th scope="col" className="px-4 py-3 font-semibold">状态</th>
                  <th scope="col" className="px-4 py-3 font-semibold">发布时间</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200 dark:divide-surface-800">
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-surface-500">加载中...</td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-surface-500">暂无公告</td>
                  </tr>
                ) : (
                  items.map((announcement) => (
                    <tr key={announcement.id} className="hover:bg-surface-50 dark:hover:bg-surface-800/50">
                      <td className="max-w-80 px-4 py-3">
                        <div className="truncate font-medium text-surface-900 dark:text-surface-100" title={announcement.title}>
                          {announcement.title}
                        </div>
                        <div className="mt-1 text-xs text-surface-500">{`修订 ${announcement.revision}`}</div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-surface-700 dark:text-surface-300">
                        {audienceLabels[announcement.audience]}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-surface-700 dark:text-surface-300">
                        {announcement.content_format === 'markdown' ? 'Markdown' : 'HTML'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {announcement.append ? (
                            <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">追加</span>
                          ) : (
                            <span className="rounded-full bg-surface-100 px-2 py-1 text-xs font-medium text-surface-600 dark:bg-surface-800 dark:text-surface-300">替换</span>
                          )}
                          {announcement.persistent ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                              <Pin className="h-3 w-3" />常驻
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                          announcement.is_active
                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                            : 'bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-400'
                        }`}>
                          {announcement.is_active ? '生效中' : '已停用'}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-surface-600 dark:text-surface-400">
                        {formatDateOrFallback(announcement.published_at, 'yyyy-MM-dd HH:mm')}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={isMutating || isSaving} onClick={() => openEdit(announcement)} aria-label="编辑公告" title="编辑公告">
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={isMutating || isSaving} onClick={() => void handleToggleActive(announcement)} aria-label={announcement.is_active ? '停用公告' : '启用公告'} title={announcement.is_active ? '停用公告' : '启用公告'}>
                            {announcement.is_active ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                          </Button>
                          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-red-600 hover:text-red-700 dark:text-red-400" disabled={isMutating || isSaving} onClick={() => void handleDelete(announcement)} aria-label="删除公告" title="删除公告">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <AnnouncementEditorModal
        key={`${editorOpen ? 'open' : 'closed'}:${editing?.id ?? 'new'}`}
        isOpen={editorOpen}
        announcement={editing}
        isSaving={isSaving}
        onClose={closeEditor}
        onSubmit={(payload) => void handleSave(payload)}
      />
    </AdminLayout>
  );
}
