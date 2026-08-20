import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  Filter,
  Loader2,
  MessagesSquare,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { RequestErrorNotice } from '@/components/feedback';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconTooltip } from '@/components/ui/IconTooltip';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { MessageCenterListPagination } from '@/modules/message-center/MessageCenterListPagination';
import { toAppError, toAppErrorFeedback, type AppError } from '@/libs/http/apiClient';
import { cn } from '@/libs/utils/cn';
import { formatRelativeTime } from '@/libs/utils/dateFormat';

import { ForumComposerModal } from './ForumComposerModal';
import { ForumPostDetailPane } from './ForumPostDetail';
import { forumService } from './services/forumService';
import type {
  CreateForumReplyPayload,
  ForumPost,
  ForumPostDetail,
  ForumReportReason,
  ForumReportTargetType,
  ForumScope,
  ForumSort,
  SaveForumPostPayload,
  UpdateForumReplyPayload,
} from './types';

interface ForumCenterProps {
  role: 'student' | 'teacher';
  postId?: string;
  onPostChange?: (id: string) => void;
  onUnreadChange?: () => void;
}

const pageSize = 20;
const sortOptions = [
  { value: 'latest', label: '最新更新' },
  { value: 'hot', label: '热门讨论' },
  { value: 'featured', label: '精选置顶' },
];

const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'open', label: '未解决' },
  { value: 'resolved', label: '已解决' },
];

const scopeOptions: Array<{ value: ForumScope; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'mine', label: '我的帖子' },
  { value: 'replied', label: '我参与的' },
  { value: 'favorites', label: '我的收藏' },
];

function ForumPostListItem({ post, active, unread, onClick }: { post: ForumPost; active: boolean; unread: boolean; onClick: () => void }) {
  const excerpt = post.excerpt.trim() || post.content.trim() || '暂无正文';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'w-full border-b border-surface-100 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:border-surface-800 dark:hover:bg-surface-800/80',
        active && 'bg-primary-50/80 dark:bg-primary-950/30',
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" title="有新的论坛互动" aria-label="有新的论坛互动" /> : null}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-surface-900 dark:text-surface-100" title={post.title}>{post.title}</span>
          {post.status === 'resolved' ? <Badge variant="success" className="shrink-0 px-1.5 py-0 text-[10px]">已解决</Badge> : null}
          {post.featured ? <Badge variant="warning" className="shrink-0 px-1.5 py-0 text-[10px]">精选</Badge> : null}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-surface-500 dark:text-surface-400" title={excerpt}>{excerpt}</span>
          <span className="max-w-20 shrink-0 truncate text-surface-500 dark:text-surface-400" title={post.author.name}>{post.author.name}</span>
          <time
            className="w-20 shrink-0 truncate text-right text-[11px] text-surface-400"
            dateTime={post.updatedAt || post.createdAt}
            title={formatRelativeTime(post.updatedAt || post.createdAt)}
          >
            {formatRelativeTime(post.updatedAt || post.createdAt)}
          </time>
        </div>
      </div>
    </button>
  );
}

function ForumListEmpty({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-100 text-surface-400 dark:bg-surface-800">
        <MessagesSquare className="h-6 w-6" />
      </span>
      <p className="mt-3 text-sm font-medium text-surface-700 dark:text-surface-200">{filtered ? '没有匹配的帖子' : '论坛还没有帖子'}</p>
      <p className="mt-1 text-xs text-surface-400">{filtered ? '试试更换关键词或筛选条件' : '发布第一个帖子，开启讨论'}</p>
    </div>
  );
}

export function ForumCenter({ role, postId = '', onPostChange, onUnreadChange }: ForumCenterProps) {
  const { toast } = useToast();
  const externalPostId = useRef(postId);
  const [status, setStatus] = useState<'' | 'open' | 'resolved'>('');
  const [sort, setSort] = useState<ForumSort>('latest');
  const [scope, setScope] = useState<ForumScope>('all');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ForumPost[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<AppError | null>(null);
  const [activePostId, setActivePostId] = useState(postId);
  const [detail, setDetail] = useState<ForumPostDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<AppError | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [composeOpen, setComposeOpen] = useState(false);
  const [editingPost, setEditingPost] = useState<ForumPost | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionKey, setActionKey] = useState('');
  const [hideOpen, setHideOpen] = useState(false);
  const [hiding, setHiding] = useState(false);
  const [unreadPostIDs, setUnreadPostIDs] = useState<Set<string>>(new Set());
  const [unreadError, setUnreadError] = useState<AppError | null>(null);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const unreadRequest = useRef(0);
  const viewedPostIDs = useRef<Set<string>>(new Set());
  const unreadPostIDsRef = useRef<Set<string>>(new Set());

  const notifyUnreadChange = useCallback(() => {
    onUnreadChange?.();
  }, [onUnreadChange]);

  useEffect(() => {
    if (externalPostId.current === postId) return;
    externalPostId.current = postId;
    setActivePostId(postId);
  }, [postId]);

  const loadUnreadPostIDs = useCallback(async (signal?: AbortSignal) => {
    const request = ++unreadRequest.current;
    try {
      const ids = await forumService.unreadPostIDs(signal);
      if (signal?.aborted || request !== unreadRequest.current) return;
      const next = new Set(ids);
      unreadPostIDsRef.current = next;
      setUnreadPostIDs(next);
      setUnreadError(null);
    } catch (error) {
      if (!signal?.aborted && request === unreadRequest.current) {
        setUnreadError(toAppError(error, '论坛未读状态加载失败'));
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadUnreadPostIDs(controller.signal);
    const timer = window.setInterval(() => void loadUnreadPostIDs(controller.signal), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [loadUnreadPostIDs]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchDraft.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const query = useMemo(() => ({
    search,
    status: status || undefined,
    sort,
    scope,
    page,
    pageSize,
  }), [page, scope, search, sort, status]);

  const loadList = useCallback(async (signal?: AbortSignal) => {
    const request = ++listRequest.current;
    setListLoading(true);
    setListError(null);
    try {
      const response = await forumService.list(query, signal);
      if (signal?.aborted || request !== listRequest.current) return;
      setItems(response.items);
      setTotal(response.total);
      const lastPage = Math.max(1, Math.ceil(response.total / pageSize));
      if (query.page > lastPage) setPage(lastPage);
    } catch (error) {
      if (signal?.aborted || request !== listRequest.current) return;
      setListError(toAppError(error, '论坛帖子加载失败，请稍后重试'));
    } finally {
      if (!signal?.aborted && request === listRequest.current) setListLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    void loadList(controller.signal);
    return () => controller.abort();
  }, [loadList, refreshKey]);

  const markPostNotificationsRead = useCallback(async (id: string) => {
    const wasUnread = unreadPostIDsRef.current.has(id);
    try {
      const updatedCount = await forumService.markPostNotificationsRead(id);
      unreadRequest.current += 1;
      setUnreadPostIDs((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        unreadPostIDsRef.current = next;
        return next;
      });
      setUnreadError(null);
      if (updatedCount > 0 || wasUnread) notifyUnreadChange();
    } catch (error) {
      setUnreadError(toAppError(error, '论坛互动标记已读失败'));
    }
  }, [notifyUnreadChange]);

  const loadDetail = useCallback(async (id: string, signal?: AbortSignal): Promise<boolean> => {
    const request = ++detailRequest.current;
    const incrementView = !viewedPostIDs.current.has(id);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const response = await forumService.get(id, signal, incrementView);
      if (signal?.aborted || request !== detailRequest.current || activePostId !== id) return false;
      viewedPostIDs.current.add(id);
      setDetail(response);
      setItems((current) => current.map((item) => item.id === id ? { ...item, ...response, content: item.content, excerpt: item.excerpt } : item));
      void markPostNotificationsRead(id);
      return true;
    } catch (error) {
      if (signal?.aborted || request !== detailRequest.current) return false;
      setDetail((current) => current?.id === id ? current : null);
      setDetailError(toAppError(error, '帖子详情加载失败，请稍后重试'));
      return false;
    } finally {
      if (!signal?.aborted && request === detailRequest.current) setDetailLoading(false);
    }
  }, [activePostId, markPostNotificationsRead]);

  useEffect(() => {
    if (!activePostId) {
      detailRequest.current += 1;
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    setDetail((current) => current?.id === activePostId ? current : null);
    void loadDetail(activePostId, controller.signal);
    return () => controller.abort();
  }, [activePostId, loadDetail]);

  const hasFilter = Boolean(search || status || scope !== 'all');

  const selectPost = useCallback((id: string) => {
    setActivePostId(id);
    onPostChange?.(id);
  }, [onPostChange]);

  const refresh = () => {
    setRefreshKey((current) => current + 1);
    // Keep the detail pane mounted while fetching fresh data. Its composer
    // owns the draft and attachment state, so replacing the pane would lose it.
    if (activePostId) void loadDetail(activePostId);
  };

  const savePost = async (payload: SaveForumPostPayload) => {
    setSaving(true);
    try {
      const saved = editingPost
        ? await forumService.update(editingPost.id, payload)
        : await forumService.create(payload);
      setComposeOpen(false);
      setEditingPost(null);
      setPage(1);
      setSort('latest');
      setScope('all');
      selectPost(saved.id);
      refresh();
      toast({ type: 'success', title: editingPost ? '帖子已更新' : '帖子已发布' });
    } catch (error) {
      const feedback = toAppErrorFeedback(error, editingPost ? '帖子更新失败' : '帖子发布失败');
      if (feedback) toast(feedback);
    } finally {
      setSaving(false);
    }
  };

  const runAction = useCallback(async (key: string, action: () => Promise<void>, success: string, failure: string) => {
    if (!detail || actionKey) return;
    setActionKey(key);
    try {
      await action();
      toast({ type: 'success', title: success });
      setRefreshKey((current) => current + 1);
      if (detail) void loadDetail(detail.id);
      notifyUnreadChange();
    } catch (error) {
      const feedback = toAppErrorFeedback(error, failure);
      if (feedback) toast(feedback);
    } finally {
      setActionKey('');
    }
  }, [actionKey, detail, loadDetail, notifyUnreadChange, toast]);

  const hidePost = async () => {
    if (!detail || hiding) return;
    setHiding(true);
    try {
      await forumService.hide(detail.id);
      setHideOpen(false);
      selectPost('');
      refresh();
      toast({ type: 'success', title: '帖子已设为不可见' });
      notifyUnreadChange();
    } catch (error) {
      const feedback = toAppErrorFeedback(error, '设置帖子不可见失败');
      if (feedback) toast(feedback);
    } finally {
      setHiding(false);
    }
  };

  const submitReply = async (payload: CreateForumReplyPayload): Promise<boolean> => {
    if (!detail) return false;
    try {
      await forumService.createReply(detail.id, payload);
      const reloaded = await loadDetail(detail.id);
      setRefreshKey((current) => current + 1);
      notifyUnreadChange();
      return reloaded;
    } catch (error) {
      const feedback = toAppErrorFeedback(error, '回复发布失败');
      if (feedback) toast(feedback);
      return false;
    }
  };

  const updateReply = async (replyId: string, payload: UpdateForumReplyPayload): Promise<boolean> => {
    if (!detail) return false;
    try {
      await forumService.updateReply(detail.id, replyId, payload);
      const reloaded = await loadDetail(detail.id);
      setRefreshKey((current) => current + 1);
      toast({ type: 'success', title: '回复已更新' });
      return reloaded;
    } catch (error) {
      const feedback = toAppErrorFeedback(error, '回复更新失败');
      if (feedback) toast(feedback);
      return false;
    }
  };

  const deleteReply = async (replyId: string): Promise<boolean> => {
    if (!detail) return false;
    try {
      await forumService.deleteReply(detail.id, replyId);
      const reloaded = await loadDetail(detail.id);
      setRefreshKey((current) => current + 1);
      toast({ type: 'success', title: '回复已删除' });
      return reloaded;
    } catch (error) {
      const feedback = toAppErrorFeedback(error, '回复删除失败');
      if (feedback) toast(feedback);
      return false;
    }
  };

  const submitReport = async (
    targetType: ForumReportTargetType,
    targetId: string,
    reason: ForumReportReason,
    reportDetail: string,
  ): Promise<boolean> => {
    try {
      await forumService.report(targetType, targetId, reason, reportDetail);
      toast({ type: 'success', title: '举报已提交' });
      return true;
    } catch (error) {
      const feedback = toAppErrorFeedback(error, '举报提交失败');
      if (feedback) toast(feedback);
      return false;
    }
  };

  const openCreate = () => {
    setEditingPost(null);
    setComposeOpen(true);
  };

  const openEdit = () => {
    if (!detail) return;
    setEditingPost(detail);
    setComposeOpen(true);
  };

  const visibleItems = useMemo(
    () => items.map((item) => unreadPostIDs.has(item.id) ? { ...item, unread: true } : item),
    [items, unreadPostIDs],
  );

  return (
    <>
      <Card className="h-[680px] overflow-hidden rounded-2xl border-surface-200/80 shadow-sm lg:h-[620px] dark:border-surface-700">
        <div className="flex h-full min-h-0 flex-col">
          <div className="shrink-0 border-b border-surface-100 px-3 py-3 sm:px-4 dark:border-surface-800">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-950/30 dark:text-primary-400">
                  <MessagesSquare className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold text-surface-900 dark:text-surface-100">全站论坛</h2>
                  <p className="truncate text-xs text-surface-500 dark:text-surface-400">{role === 'teacher' ? '全站教学与学习讨论' : '跨学科的学习讨论'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={refresh} disabled={listLoading} title="刷新帖子">
                  <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', listLoading && 'animate-spin')} />刷新
                </Button>
                <Button size="sm" onClick={openCreate}>
                  <Plus className="mr-1.5 h-4 w-4" />发帖
                </Button>
              </div>
            </div>
            {unreadError ? (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                <span className="truncate">{unreadError.message}</span>
                <button type="button" className="shrink-0 font-medium hover:underline" onClick={() => void loadUnreadPostIDs()}>重试</button>
              </div>
            ) : null}
            <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-[minmax(200px,1fr)_130px_112px]">
              <div className="relative col-span-2 min-w-0 xl:col-span-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400" />
                <Input
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  placeholder="搜索帖子、标签或知识点"
                  aria-label="搜索论坛帖子"
                  className="pl-9 pr-9"
                />
                {searchDraft ? (
                  <IconTooltip label="清除搜索" side="bottom" className="absolute right-2 top-1/2 -translate-y-1/2">
                    <button type="button" aria-label="清除搜索" onClick={() => setSearchDraft('')} className="grid h-7 w-7 place-items-center rounded text-surface-400 hover:bg-surface-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:hover:bg-surface-700">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </IconTooltip>
                ) : null}
              </div>
              <Select
                value={sort}
                onChange={(value) => { setSort(value as ForumSort); setPage(1); }}
                options={sortOptions}
                aria-label="帖子排序"
              />
              <Select
                value={status}
                onChange={(value) => { setStatus(value as '' | 'open' | 'resolved'); setPage(1); }}
                options={statusOptions}
                aria-label="按解决状态筛选"
              />
            </div>
            <div className="mt-2 flex items-center gap-2 overflow-x-auto" role="group" aria-label="论坛范围筛选">
              <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-surface-400" />
              {scopeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={scope === option.value}
                  onClick={() => { setScope(option.value); setPage(1); }}
                  className={cn(
                    'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                    scope === option.value
                      ? 'bg-primary-100 text-primary-700 dark:bg-primary-950/50 dark:text-primary-300'
                      : 'text-surface-500 hover:bg-surface-100 dark:text-surface-400 dark:hover:bg-surface-800',
                  )}
                >
                  {option.label}
                </button>
              ))}
              <span className="ml-auto hidden shrink-0 items-center gap-1 text-xs text-surface-400 sm:flex"><Filter className="h-3.5 w-3.5" />{total} 帖</span>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[400px_minmax(0,1fr)]">
            <aside className={cn('flex min-h-0 flex-col border-r border-surface-100 dark:border-surface-800', activePostId && 'hidden lg:flex')}>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {listLoading ? (
                  <div className="divide-y divide-surface-100 dark:divide-surface-800" role="status" aria-label="帖子加载中">
                    {[1, 2, 3, 4, 5, 6].map((item) => <div key={item} className="h-[60px] animate-pulse bg-surface-100/80 dark:bg-surface-800/80" />)}
                  </div>
                ) : listError ? (
                  <div className="flex min-h-64 items-center px-6">
                    <RequestErrorNotice
                      error={listError}
                      onRetry={refresh}
                      onRefresh={refresh}
                      className="w-full"
                    />
                  </div>
                ) : visibleItems.length === 0 ? (
                  <ForumListEmpty filtered={hasFilter} />
                ) : (
                  visibleItems.map((post) => (
                    <ForumPostListItem
                      key={post.id}
                      post={post}
                      active={post.id === activePostId}
                      unread={post.unread}
                      onClick={() => selectPost(post.id)}
                    />
                  ))
                )}
              </div>
              <MessageCenterListPagination
                currentPage={page}
                totalItems={total}
                pageSize={pageSize}
                disabled={listLoading}
                onPageChange={setPage}
              />
            </aside>

            <section className={cn('min-h-0', !activePostId && 'hidden lg:block')}>
              {detail ? (
                <div className="relative h-full min-h-0">
                  {detailError ? (
                    <RequestErrorNotice
                      error={detailError}
                      onRetry={() => void loadDetail(detail.id)}
                      onRefresh={() => void loadDetail(detail.id)}
                      onDismiss={() => setDetailError(null)}
                      className="absolute inset-x-3 top-2 z-10 shadow-sm"
                    />
                  ) : null}
                  <ForumPostDetailPane
                    key={detail.id}
                    post={detail}
                    actionKey={actionKey}
                    onBack={() => selectPost('')}
                    onEdit={openEdit}
                    onHide={() => setHideOpen(true)}
                    onLike={() => runAction('like', () => forumService.likePost(detail.id, !detail.liked), detail.liked ? '已取消点赞' : '已点赞', '点赞操作失败')}
                    onFavorite={() => runAction('favorite', () => forumService.favoritePost(detail.id, !detail.favorited), detail.favorited ? '已取消收藏' : '已收藏', '收藏操作失败')}
                    onFeature={() => runAction('feature', () => forumService.featurePost(detail.id, !detail.featured), detail.featured ? '已取消精选' : '已设为精选', '精选操作失败')}
                    onAccept={(replyId) => runAction(`accept:${replyId}`, () => forumService.acceptAnswer(detail.id, replyId), '已采纳最佳答案', '采纳答案失败')}
                    onReply={submitReply}
                    onUpdateReply={updateReply}
                    onDeleteReply={deleteReply}
                    onReport={submitReport}
                  />
                </div>
              ) : detailLoading ? (
                <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 text-sm text-surface-500" role="status">
                  <Loader2 className="h-7 w-7 animate-spin text-primary-500" />加载帖子
                  <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => selectPost('')}><ChevronLeft className="mr-1 h-4 w-4" />返回列表</Button>
                </div>
              ) : detailError ? (
                <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-6 text-sm text-surface-500">
                  <RequestErrorNotice
                    error={detailError}
                    onRetry={() => void loadDetail(activePostId)}
                    onRefresh={() => void loadDetail(activePostId)}
                    className="w-full max-w-lg"
                  />
                  <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => selectPost('')}>返回列表</Button>
                </div>
              ) : (
                <div className="flex h-full min-h-64 flex-col items-center justify-center px-8 text-center">
                  <span className="grid h-14 w-14 place-items-center rounded-2xl bg-primary-50 text-primary-500 dark:bg-primary-950/30 dark:text-primary-400"><MessagesSquare className="h-7 w-7" /></span>
                  <h3 className="mt-4 text-base font-semibold text-surface-800 dark:text-surface-100">选择一篇帖子</h3>
                  <p className="mt-1 max-w-xs text-sm text-surface-400">查看讨论内容，参与全站学习交流</p>
                </div>
              )}
            </section>
          </div>
        </div>
      </Card>

      {composeOpen ? (
        <ForumComposerModal
          key={editingPost?.id ?? 'new-post'}
          isOpen
          post={editingPost}
          saving={saving}
          onClose={() => { if (!saving) { setComposeOpen(false); setEditingPost(null); } }}
          onSave={savePost}
        />
      ) : null}
      <ConfirmDialog
        isOpen={hideOpen}
        onClose={() => { if (!hiding) setHideOpen(false); }}
        onConfirm={() => void hidePost()}
        loading={hiding}
        title="设为不可见"
        message="帖子和回复将不再对其他用户显示，但内容仍会保留。确认继续吗？"
        confirmText="设为不可见"
        showIcon={false}
      />
    </>
  );
}
