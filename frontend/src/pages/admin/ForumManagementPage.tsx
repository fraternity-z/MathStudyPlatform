import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
  Trash2,
  XCircle,
} from 'lucide-react';

import { AdminLayout } from '@/modules/admin/components/AdminLayout';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconTooltip } from '@/components/ui/IconTooltip';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { MarkdownContent } from '@/components/chat/MarkdownContent';
import { MessageAttachments } from '@/modules/message-center/MessageAttachments';
import { getApiErrorMessage } from '@/libs/http/apiClient';
import { cn } from '@/libs/utils/cn';
import { formatDateOrFallback } from '@/libs/utils/dateFormat';
import { forumAdminService } from '@/modules/admin/services/forumAdminService';
import type {
  ForumModerationPost,
  ForumModerationPostStatusFilter,
  ForumModerationReport,
  ForumReportStatus,
} from '@/modules/admin/types/forumAdmin';
import type { ForumPost, ForumSort } from '@/modules/forum/types';

type ViewMode = 'posts' | 'reports';
type PostActionTarget = Pick<ForumPost, 'id' | 'title'>;

const pageSize = 15;

const reportStatusOptions: Array<{ value: 'all' | ForumReportStatus; label: string }> = [
  { value: 'all', label: '全部举报' },
  { value: 'pending', label: '待处理' },
  { value: 'resolved', label: '已处理' },
  { value: 'dismissed', label: '已驳回' },
];

const postStatusOptions: Array<{ value: ForumModerationPostStatusFilter; label: string }> = [
  { value: 'all', label: '全部帖子' },
  { value: 'visible', label: '可见帖子' },
  { value: 'open', label: '讨论中' },
  { value: 'resolved', label: '已解决' },
  { value: 'hidden', label: '不可见' },
  { value: 'deleted', label: '已删除' },
];

function postStatusLabel(status: string): string {
  if (status === 'resolved') return '已解决';
  if (status === 'hidden') return '不可见';
  if (status === 'deleted') return '已删除';
  return '讨论中';
}

function postStatusVariant(status: string): 'success' | 'warning' | 'destructive' | 'secondary' {
  if (status === 'resolved') return 'success';
  if (status === 'hidden') return 'warning';
  if (status === 'deleted') return 'destructive';
  return 'secondary';
}

const sortOptions: Array<{ value: ForumSort; label: string }> = [
  { value: 'latest', label: '最近更新' },
  { value: 'hot', label: '互动最多' },
];

const reportReasonLabels: Record<string, string> = {
  spam: '广告/灌水',
  abuse: '辱骂/骚扰',
  answer_leak: '答案泄露',
  misinformation: '错误信息',
  copyright: '版权问题',
  other: '其他',
};

const roleLabels: Record<string, string> = {
  student: '学生',
  teacher: '教师',
  admin: '管理员',
};

function reportStatusLabel(status: ForumReportStatus): string {
  return status === 'pending' ? '待处理' : status === 'resolved' ? '已处理' : '已驳回';
}

function reportStatusVariant(status: ForumReportStatus): 'warning' | 'success' | 'secondary' {
  return status === 'pending' ? 'warning' : status === 'resolved' ? 'success' : 'secondary';
}

function reportTargetLabel(report: ForumModerationReport): string {
  return report.targetType === 'reply' ? '回复' : '帖子';
}

function PageEmpty({ icon: Icon, title }: { icon: typeof FileText; title: string }) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-6 text-center text-surface-500 dark:text-surface-400">
      <Icon className="h-9 w-9 text-surface-300 dark:text-surface-600" />
      <p className="text-sm">{title}</p>
    </div>
  );
}

interface PostDetailModalProps {
  post: ForumModerationPost | null;
  report: ForumModerationReport | null;
  loading: boolean;
  error: string;
  mutation: string;
  onClose: () => void;
  onHide: () => void;
  onRestore: () => void;
  onHardDelete: () => void;
  onDeleteReply: (replyId: string) => void;
  onResolve: (status: 'resolved' | 'dismissed') => void;
}

function PostDetailModal({
  post,
  report,
  loading,
  error,
  mutation,
  onClose,
  onHide,
  onRestore,
  onHardDelete,
  onDeleteReply,
  onResolve,
}: PostDetailModalProps) {
  const highlightedReplyID = report?.targetType === 'reply' ? report.targetId : '';

  return (
    <Modal isOpen={Boolean(post || report || loading || error)} title="论坛内容详情" onClose={mutation ? () => undefined : onClose} className="max-w-4xl">
      {loading ? (
        <div className="flex min-h-64 items-center justify-center" role="status">
          <Loader2 className="h-7 w-7 animate-spin text-primary-600" />
        </div>
      ) : error ? (
        <div className="space-y-4">
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">{error}</div>
          {report ? (
            <div className="rounded-md border border-surface-200 px-3 py-3 text-sm dark:border-surface-700">
              <div className="flex items-center gap-2 font-medium"><TriangleAlert className="h-4 w-4 text-amber-600" />举报信息</div>
              <p className="mt-2 text-surface-600 dark:text-surface-300">{reportReasonLabels[report.reason] ?? report.reason}：{report.detail || '未补充说明'}</p>
            </div>
          ) : null}
        </div>
      ) : post ? (
        <div className="space-y-5">
          {report ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              <div className="flex flex-wrap items-center gap-2">
                <TriangleAlert className="h-4 w-4" />
                <span className="font-semibold">{reportTargetLabel(report)}举报</span>
                <Badge variant={reportStatusVariant(report.status)}>{reportStatusLabel(report.status)}</Badge>
                <span>{reportReasonLabels[report.reason] ?? report.reason}</span>
              </div>
              <p className="mt-1 break-words">{report.detail || '举报人未补充说明'}</p>
              {report.status !== 'pending' && report.reviewedAt ? (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                  审核人 {report.reviewedBy || '未知管理员'} · {formatDateOrFallback(report.reviewedAt, 'yyyy-MM-dd HH:mm')}
                </p>
              ) : null}
            </div>
          ) : null}

          <header className="border-b border-surface-200 pb-4 dark:border-surface-700">
            <div className="flex flex-wrap items-center gap-2 text-xs text-surface-500 dark:text-surface-400">
              <Badge variant="outline">{post.board.name}</Badge>
              <span>{roleLabels[post.author.role] ?? post.author.role}</span>
              <span>·</span>
              <span>{post.author.name}</span>
              <span>·</span>
              <span>{formatDateOrFallback(post.createdAt, 'yyyy-MM-dd HH:mm')}</span>
            </div>
            <h2 className="mt-3 break-words text-xl font-semibold text-surface-900 dark:text-surface-100">{post.title}</h2>
          </header>

          <div className="max-h-[42vh] overflow-y-auto overscroll-contain pr-1">
            <div className="break-words text-sm leading-7 text-surface-700 dark:text-surface-300">
              <MarkdownContent content={post.content} />
            </div>
            <MessageAttachments attachments={post.attachments} />
            {post.replies.length > 0 ? (
              <section className="mt-6" aria-label="帖子回复">
                <h3 className="mb-2 text-sm font-semibold text-surface-900 dark:text-surface-100">回复（{post.replies.length}）</h3>
                <div className="divide-y divide-surface-200 border-y border-surface-200 dark:divide-surface-700 dark:border-surface-700">
                  {post.replies.map((reply) => (
                    <article key={reply.id} className={cn('py-3', reply.id === highlightedReplyID && 'rounded-md bg-red-50 px-3 dark:bg-red-950/30')}>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-surface-500 dark:text-surface-400">
                        <span className="font-medium text-surface-800 dark:text-surface-100">{reply.author.name}</span>
                        <span>{roleLabels[reply.author.role] ?? reply.author.role}</span>
                        <time className="ml-auto">{formatDateOrFallback(reply.createdAt, 'yyyy-MM-dd HH:mm')}</time>
                        {reply.id === highlightedReplyID ? <Badge variant="destructive">被举报回复</Badge> : null}
                      </div>
                      <div className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-surface-700 dark:text-surface-300">{reply.content}</div>
                      <MessageAttachments attachments={reply.attachments} />
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-200 pt-4 dark:border-surface-700">
            <div className="text-xs text-surface-500 dark:text-surface-400">浏览 {post.viewCount} · 回复 {post.replyCount} · 点赞 {post.likeCount} · 星标 {post.favoriteCount}</div>
            <div className="flex flex-wrap items-center gap-2">
              {report?.status === 'pending' && report.targetType === 'reply' && post.replies.some((reply) => reply.id === report.targetId) ? (
                <Button variant="destructive" size="sm" onClick={() => onDeleteReply(report.targetId)} disabled={Boolean(mutation)} title="将被举报回复设为不可见并处理举报">
                  {mutation === 'delete-reply' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <EyeOff className="mr-1.5 h-4 w-4" />}
                  设为不可见
                </Button>
              ) : null}
              {post.status !== 'hidden' && post.status !== 'deleted' && post.canDelete ? (
                <IconTooltip label="设为不可见" side="top">
                  <Button variant="ghost" size="icon" onClick={onHide} disabled={Boolean(mutation)} aria-label="设为不可见">
                    {mutation === 'hide' ? <Loader2 className="h-4 w-4 animate-spin" /> : <EyeOff className="h-4 w-4 text-amber-600" />}
                  </Button>
                </IconTooltip>
              ) : null}
              {post.status === 'hidden' ? (
                <IconTooltip label="重新设为可见" side="top">
                  <Button variant="ghost" size="icon" onClick={onRestore} disabled={Boolean(mutation)} aria-label="重新设为可见">
                    {mutation === 'restore' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4 text-emerald-600" />}
                  </Button>
                </IconTooltip>
              ) : null}
              <IconTooltip label="永久删除" side="top">
                <Button variant="ghost" size="icon" onClick={onHardDelete} disabled={Boolean(mutation)} aria-label="永久删除">
                  {mutation === 'hard-delete' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 text-red-600" />}
                </Button>
              </IconTooltip>
              {report?.status === 'pending' ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => onResolve('dismissed')} disabled={Boolean(mutation)}>
                    {mutation === 'dismissed' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <XCircle className="mr-1.5 h-4 w-4" />}
                    驳回举报
                  </Button>
                  <Button size="sm" onClick={() => onResolve('resolved')} disabled={Boolean(mutation)}>
                    {mutation === 'resolved' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
                    标记已处理
                  </Button>
                </>
              ) : null}
            </div>
          </footer>
        </div>
      ) : (
        <PageEmpty icon={FileText} title="暂无可显示的内容" />
      )}
    </Modal>
  );
}

export const ForumManagementPage: React.FC = () => {
  const { toast } = useToast();
  const [view, setView] = useState<ViewMode>('posts');
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [postTotal, setPostTotal] = useState(0);
  const [postPage, setPostPage] = useState(1);
  const [postStatus, setPostStatus] = useState<ForumModerationPostStatusFilter>('all');
  const [postSort, setPostSort] = useState<ForumSort>('latest');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [postLoading, setPostLoading] = useState(true);
  const [postError, setPostError] = useState('');
  const [reports, setReports] = useState<ForumModerationReport[]>([]);
  const [reportTotal, setReportTotal] = useState(0);
  const [reportPage, setReportPage] = useState(1);
  const [reportStatus, setReportStatus] = useState<'all' | ForumReportStatus>('pending');
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState('');
  const [selectedPost, setSelectedPost] = useState<ForumModerationPost | null>(null);
  const [selectedReport, setSelectedReport] = useState<ForumModerationReport | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [mutation, setMutation] = useState('');
  const [hideTarget, setHideTarget] = useState<PostActionTarget | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<PostActionTarget | null>(null);
  const [hardDeleteTarget, setHardDeleteTarget] = useState<PostActionTarget | null>(null);
  const [deleteReplyID, setDeleteReplyID] = useState('');
  const detailAbortRef = useRef<AbortController | null>(null);
  const postRequest = useRef(0);
  const reportRequest = useRef(0);

  const loadPosts = useCallback(async (signal?: AbortSignal) => {
    const request = ++postRequest.current;
    setPostLoading(true);
    setPostError('');
    try {
      const response = await forumAdminService.listPosts({
        search,
        status: postStatus,
        sort: postSort,
        page: postPage,
        pageSize,
      }, signal);
      if (signal?.aborted || request !== postRequest.current) return;
      setPosts(response.items);
      setPostTotal(response.total);
      const lastPage = Math.max(1, Math.ceil(response.total / pageSize));
      if (postPage > lastPage) setPostPage(lastPage);
    } catch (error) {
      if (!signal?.aborted && request === postRequest.current) {
        setPostError(getApiErrorMessage(error, '获取帖子列表失败'));
      }
    } finally {
      if (!signal?.aborted && request === postRequest.current) setPostLoading(false);
    }
  }, [postPage, postSort, postStatus, search]);

  const loadReports = useCallback(async (signal?: AbortSignal) => {
    const request = ++reportRequest.current;
    setReportLoading(true);
    setReportError('');
    try {
      const response = await forumAdminService.listReports({ status: reportStatus, page: reportPage, pageSize }, signal);
      if (signal?.aborted || request !== reportRequest.current) return;
      setReports(response.items);
      setReportTotal(response.total);
      const lastPage = Math.max(1, Math.ceil(response.total / pageSize));
      if (reportPage > lastPage) setReportPage(lastPage);
    } catch (error) {
      if (!signal?.aborted && request === reportRequest.current) {
        setReportError(getApiErrorMessage(error, '获取举报列表失败'));
      }
    } finally {
      if (!signal?.aborted && request === reportRequest.current) setReportLoading(false);
    }
  }, [reportPage, reportStatus]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchDraft.trim());
      setPostPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPosts(controller.signal);
    return () => controller.abort();
  }, [loadPosts]);

  useEffect(() => {
    if (view !== 'reports') return;
    const controller = new AbortController();
    void loadReports(controller.signal);
    return () => controller.abort();
  }, [loadReports, view]);

  useEffect(() => () => detailAbortRef.current?.abort(), []);

  const openPost = useCallback(async (postID: string, report: ForumModerationReport | null = null) => {
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setSelectedReport(report);
    setSelectedPost(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const post = await forumAdminService.getPost(postID, controller.signal);
      if (!controller.signal.aborted) setSelectedPost(post);
    } catch (error) {
      if (!controller.signal.aborted) setDetailError(getApiErrorMessage(error, '获取帖子详情失败'));
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }, []);

  const closeDetail = () => {
    detailAbortRef.current?.abort();
    setSelectedPost(null);
    setSelectedReport(null);
    setDetailError('');
    setDetailLoading(false);
    setDeleteReplyID('');
  };

  const hidePost = async () => {
    if (!hideTarget || mutation) return;
    const target = hideTarget;
    setMutation('hide');
    try {
      await forumAdminService.hidePost(target.id);
      toast({
        type: 'success',
        title: '帖子已设为不可见',
        description: '可在“不可见”筛选中重新设为可见',
      });
      setHideTarget(null);
      setPosts((current) => postStatus === 'all'
        ? current.map((post): ForumPost => post.id === target.id ? { ...post, status: 'hidden', featured: false } : post)
        : current.filter((post) => post.id !== target.id));
      if (selectedPost?.id === target.id) closeDetail();
      await loadPosts();
      if (view === 'reports') await loadReports();
    } catch (error) {
      toast({ type: 'error', title: getApiErrorMessage(error, '设置帖子不可见失败') });
    } finally {
      setMutation('');
    }
  };

  const hardDeletePost = async () => {
    if (!hardDeleteTarget || mutation) return;
    const target = hardDeleteTarget;
    setMutation('hard-delete');
    try {
      await forumAdminService.permanentlyDeletePost(target.id);
      toast({ type: 'success', title: '帖子已永久删除' });
      setHardDeleteTarget(null);
      setPosts((current) => current.filter((post) => post.id !== target.id));
      setReports((current) => current.filter((report) => report.postId !== target.id));
      if (selectedPost?.id === target.id) closeDetail();
      await loadPosts();
      if (view === 'reports') await loadReports();
    } catch (error) {
      toast({ type: 'error', title: getApiErrorMessage(error, '永久删除帖子失败') });
    } finally {
      setMutation('');
    }
  };

  const restorePost = async () => {
    if (!restoreTarget || mutation) return;
    const target = restoreTarget;
    setMutation('restore');
    try {
      await forumAdminService.restorePost(target.id);
      toast({ type: 'success', title: '帖子已重新设为可见' });
      setRestoreTarget(null);
      setPosts((current) => postStatus === 'all'
        ? current.map((post): ForumPost => post.id === target.id
          ? { ...post, status: post.acceptedReplyId ? 'resolved' : 'open' }
          : post)
        : current.filter((post) => post.id !== target.id));
      if (selectedPost?.id === target.id) closeDetail();
      await loadPosts();
    } catch (error) {
      toast({ type: 'error', title: getApiErrorMessage(error, '恢复帖子可见状态失败') });
    } finally {
      setMutation('');
    }
  };

  const deleteReply = async () => {
    if (!selectedPost || !deleteReplyID || mutation) return;
    const replyId = deleteReplyID;
    setMutation('delete-reply');
    try {
      await forumAdminService.deleteReply(selectedPost.id, replyId);
      toast({ type: 'success', title: '回复已设为不可见，举报已处理' });
      setDeleteReplyID('');
      closeDetail();
      await loadPosts();
      if (view === 'reports') await loadReports();
    } catch (error) {
      toast({ type: 'error', title: getApiErrorMessage(error, '设置回复不可见失败') });
    } finally {
      setMutation('');
    }
  };

  const resolveReport = async (status: 'resolved' | 'dismissed') => {
    if (!selectedReport || mutation) return;
    setMutation(status);
    try {
      const resolved = await forumAdminService.resolveReport(selectedReport.id, status);
      setSelectedReport(resolved);
      toast({ type: 'success', title: status === 'resolved' ? '举报已标记为已处理' : '举报已驳回' });
      await loadReports();
    } catch (error) {
      toast({ type: 'error', title: getApiErrorMessage(error, '处理举报失败') });
    } finally {
      setMutation('');
    }
  };

  const resolveListReport = async (report: ForumModerationReport, status: 'resolved' | 'dismissed') => {
    if (mutation) return;
    const action = `report:${status}:${report.id}`;
    setMutation(action);
    try {
      await forumAdminService.resolveReport(report.id, status);
      toast({ type: 'success', title: status === 'resolved' ? '举报已处理' : '举报已驳回' });
      await loadReports();
    } catch (error) {
      toast({ type: 'error', title: getApiErrorMessage(error, '处理举报失败') });
    } finally {
      setMutation('');
    }
  };

  const postPages = Math.max(1, Math.ceil(postTotal / pageSize));
  const reportPages = Math.max(1, Math.ceil(reportTotal / pageSize));
  return (
    <AdminLayout>
      <div className="container mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-7 w-7 text-primary-600 dark:text-primary-400" />
              <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100">论坛管理</h1>
            </div>
            <p className="mt-2 text-sm text-surface-500 dark:text-surface-400">管理全站帖子和社区举报</p>
          </div>
          <IconTooltip label="刷新" side="bottom">
            <Button variant="outline" size="icon" onClick={() => { if (view === 'posts') void loadPosts(); else void loadReports(); }} aria-label="刷新" disabled={view === 'posts' ? postLoading : reportLoading}>
              <RefreshCw className={cn('h-4 w-4', (postLoading || reportLoading) && 'animate-spin')} />
            </Button>
          </IconTooltip>
        </header>

        <div className="flex items-center gap-1 border-b border-surface-200 dark:border-surface-800" role="tablist" aria-label="论坛管理视图">
          <button type="button" role="tab" aria-selected={view === 'posts'} onClick={() => setView('posts')} className={cn('border-b-2 px-4 py-2.5 text-sm font-medium', view === 'posts' ? 'border-primary-600 text-primary-600 dark:text-primary-400' : 'border-transparent text-surface-500 hover:text-surface-800 dark:hover:text-surface-200')}>
            帖子管理
          </button>
          <button type="button" role="tab" aria-selected={view === 'reports'} onClick={() => setView('reports')} className={cn('border-b-2 px-4 py-2.5 text-sm font-medium', view === 'reports' ? 'border-primary-600 text-primary-600 dark:text-primary-400' : 'border-transparent text-surface-500 hover:text-surface-800 dark:hover:text-surface-200')}>
            举报审核
          </button>
        </div>

        {view === 'posts' ? (
          <section className="overflow-hidden rounded-lg border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900" aria-label="帖子管理">
            <div className="flex flex-col gap-3 border-b border-surface-200 p-4 sm:flex-row sm:items-center dark:border-surface-800">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400" />
                <Input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="搜索帖子标题、正文或标签" aria-label="搜索帖子" className="pl-9" />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:w-64">
                <Select value={postStatus} onChange={(value) => { setPostStatus(value as ForumModerationPostStatusFilter); setPostPage(1); }} options={postStatusOptions} aria-label="帖子状态" />
                <Select value={postSort} onChange={(value) => { setPostSort(value as ForumSort); setPostPage(1); }} options={sortOptions} aria-label="帖子排序" />
              </div>
            </div>
            {postError ? <div className="m-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300" role="alert">{postError}</div> : null}
            {postLoading ? <div className="flex min-h-56 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary-600" /></div> : posts.length === 0 ? <PageEmpty icon={FileText} title="暂无帖子" /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="border-b border-surface-200 bg-surface-50 text-xs text-surface-500 dark:border-surface-800 dark:bg-surface-950 dark:text-surface-400"><tr><th className="px-4 py-3 font-semibold">帖子</th><th className="px-4 py-3 font-semibold">作者</th><th className="px-4 py-3 font-semibold">互动</th><th className="px-4 py-3 font-semibold">更新时间</th><th className="px-4 py-3 text-right font-semibold">操作</th></tr></thead>
                  <tbody className="divide-y divide-surface-200 dark:divide-surface-800">
                    {posts.map((post) => (
                      <tr key={post.id} className="hover:bg-surface-50 dark:hover:bg-surface-800/50">
                        <td className="max-w-[30rem] px-4 py-3"><button type="button" className="block max-w-full text-left" onClick={() => void openPost(post.id)}><div className="truncate font-medium text-surface-900 hover:text-primary-600 dark:text-surface-100 dark:hover:text-primary-400">{post.title}</div><div className="mt-1 flex items-center gap-1.5 text-xs text-surface-500"><span>{post.board.name}</span><Badge variant={postStatusVariant(post.status)}>{postStatusLabel(post.status)}</Badge></div></button></td>
                        <td className="whitespace-nowrap px-4 py-3"><div className="text-surface-800 dark:text-surface-200">{post.author.name}</div><div className="mt-0.5 text-xs text-surface-500">{roleLabels[post.author.role] ?? post.author.role}</div></td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-surface-500">{post.replyCount} 回复 · {post.likeCount} 赞</td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-surface-500">{formatDateOrFallback(post.updatedAt, 'yyyy-MM-dd HH:mm')}</td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            <IconTooltip label="查看帖子" side="left">
                              <Button variant="ghost" size="icon" onClick={() => void openPost(post.id)} aria-label="查看帖子" disabled={Boolean(mutation)}>
                                <FileText className="h-4 w-4" />
                              </Button>
                            </IconTooltip>
                            {post.status !== 'hidden' && post.status !== 'deleted' && post.canDelete ? (
                              <IconTooltip label="设为不可见" side="left">
                                <Button variant="ghost" size="icon" onClick={() => setHideTarget(post)} aria-label="设为不可见" disabled={Boolean(mutation)}>
                                  <EyeOff className="h-4 w-4 text-amber-600" />
                                </Button>
                              </IconTooltip>
                            ) : null}
                            {post.status === 'hidden' ? (
                              <IconTooltip label="重新设为可见" side="left">
                                <Button variant="ghost" size="icon" onClick={() => setRestoreTarget(post)} aria-label="重新设为可见" disabled={Boolean(mutation)}>
                                  <Eye className="h-4 w-4 text-emerald-600" />
                                </Button>
                              </IconTooltip>
                            ) : null}
                            <IconTooltip label="永久删除" side="left">
                              <Button variant="ghost" size="icon" onClick={() => setHardDeleteTarget(post)} aria-label="永久删除" disabled={Boolean(mutation)}>
                                <Trash2 className="h-4 w-4 text-red-600" />
                              </Button>
                            </IconTooltip>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {postPages > 1 ? (
              <div className="flex items-center justify-between border-t border-surface-200 px-4 py-3 text-xs text-surface-500 dark:border-surface-800">
                <span>共 {postTotal} 条</span>
                <div className="flex items-center gap-2">
                  <IconTooltip label="上一页">
                    <Button variant="ghost" size="icon" disabled={postPage <= 1} onClick={() => setPostPage((value) => value - 1)} aria-label="上一页">
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </IconTooltip>
                  <span>{postPage}/{postPages}</span>
                  <IconTooltip label="下一页">
                    <Button variant="ghost" size="icon" disabled={postPage >= postPages} onClick={() => setPostPage((value) => value + 1)} aria-label="下一页">
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </IconTooltip>
                </div>
              </div>
            ) : null}
          </section>
        ) : (
          <section className="overflow-hidden rounded-lg border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900" aria-label="举报审核">
            <div className="flex flex-col gap-3 border-b border-surface-200 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-surface-800"><div className="flex items-center gap-2 text-sm font-medium text-surface-800 dark:text-surface-200"><TriangleAlert className="h-4 w-4 text-amber-500" />社区举报</div><Select value={reportStatus} onChange={(value) => { setReportStatus(value as 'all' | ForumReportStatus); setReportPage(1); }} options={reportStatusOptions} aria-label="举报状态" /></div>
            {reportError ? <div className="m-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300" role="alert">{reportError}</div> : null}
            {reportLoading ? (
              <div className="flex min-h-56 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary-600" />
              </div>
            ) : reports.length === 0 ? (
              <PageEmpty icon={TriangleAlert} title="暂无举报记录" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="border-b border-surface-200 bg-surface-50 text-xs text-surface-500 dark:border-surface-800 dark:bg-surface-950 dark:text-surface-400">
                    <tr>
                      <th className="px-4 py-3 font-semibold">举报目标</th>
                      <th className="px-4 py-3 font-semibold">举报人</th>
                      <th className="px-4 py-3 font-semibold">原因</th>
                      <th className="px-4 py-3 font-semibold">时间</th>
                      <th className="px-4 py-3 font-semibold">状态</th>
                      <th className="px-4 py-3 text-right font-semibold">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-200 dark:divide-surface-800">
                    {reports.map((report) => {
                      const action = mutation.startsWith('report:') && mutation.endsWith(`:${report.id}`) ? mutation : '';
                      return (
                        <tr key={report.id} className="hover:bg-surface-50 dark:hover:bg-surface-800/50">
                          <td className="max-w-[22rem] px-4 py-3">
                            <button type="button" className="flex max-w-full items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60" onClick={() => report.postId && void openPost(report.postId, report)} disabled={Boolean(mutation) || !report.postId}>
                              <span className="shrink-0 rounded bg-surface-100 px-1.5 py-0.5 text-[11px] text-surface-600 dark:bg-surface-800 dark:text-surface-300">{reportTargetLabel(report)}</span>
                              <span className="truncate text-surface-800 hover:text-primary-600 dark:text-surface-200">{report.targetId}</span>
                            </button>
                            <p className="mt-1 truncate text-xs text-surface-500">{report.detail || '未补充说明'}</p>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-surface-700 dark:text-surface-300">{report.reporter.name}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-surface-500">{reportReasonLabels[report.reason] ?? report.reason}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-surface-500">{formatDateOrFallback(report.createdAt, 'yyyy-MM-dd HH:mm')}</td>
                          <td className="px-4 py-3">
                            <Badge variant={reportStatusVariant(report.status)}>{reportStatusLabel(report.status)}</Badge>
                            {report.status !== 'pending' && report.reviewedAt ? (
                              <div className="mt-1 whitespace-nowrap text-[11px] text-surface-500">
                                {report.reviewedBy || '未知管理员'} · {formatDateOrFallback(report.reviewedAt, 'MM-dd HH:mm')}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-1">
                              <IconTooltip label="查看被举报内容" side="left">
                                <Button variant="ghost" size="icon" onClick={() => report.postId && void openPost(report.postId, report)} aria-label="查看被举报内容" disabled={Boolean(mutation) || !report.postId}>
                                  <Eye className="h-4 w-4" />
                                </Button>
                              </IconTooltip>
                              {report.status === 'pending' ? (
                                <>
                                  <IconTooltip label="驳回举报" side="left">
                                    <Button variant="ghost" size="icon" onClick={() => void resolveListReport(report, 'dismissed')} aria-label="驳回举报" disabled={Boolean(mutation)}>
                                      {action === `report:dismissed:${report.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4 text-surface-500" />}
                                    </Button>
                                  </IconTooltip>
                                  <IconTooltip label="标记已处理" side="left">
                                    <Button variant="ghost" size="icon" onClick={() => void resolveListReport(report, 'resolved')} aria-label="标记已处理" disabled={Boolean(mutation)}>
                                      {action === `report:resolved:${report.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                                    </Button>
                                  </IconTooltip>
                                </>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {reportPages > 1 ? (
              <div className="flex items-center justify-between border-t border-surface-200 px-4 py-3 text-xs text-surface-500 dark:border-surface-800">
                <span>共 {reportTotal} 条</span>
                <div className="flex items-center gap-2">
                  <IconTooltip label="上一页">
                    <Button variant="ghost" size="icon" disabled={reportPage <= 1} onClick={() => setReportPage((value) => value - 1)} aria-label="上一页">
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </IconTooltip>
                  <span>{reportPage}/{reportPages}</span>
                  <IconTooltip label="下一页">
                    <Button variant="ghost" size="icon" disabled={reportPage >= reportPages} onClick={() => setReportPage((value) => value + 1)} aria-label="下一页">
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </IconTooltip>
                </div>
              </div>
            ) : null}
          </section>
        )}
      </div>

      {(selectedPost || selectedReport || detailLoading || detailError) ? (
        <PostDetailModal
          post={selectedPost}
          report={selectedReport}
          loading={detailLoading}
          error={detailError}
          mutation={mutation}
          onClose={closeDetail}
          onHide={() => selectedPost && setHideTarget(selectedPost)}
          onRestore={() => selectedPost && setRestoreTarget(selectedPost)}
          onHardDelete={() => selectedPost && setHardDeleteTarget(selectedPost)}
          onDeleteReply={setDeleteReplyID}
          onResolve={(status) => void resolveReport(status)}
        />
      ) : null}
      <ConfirmDialog isOpen={Boolean(deleteReplyID)} onClose={() => { if (!mutation) setDeleteReplyID(''); }} onConfirm={() => void deleteReply()} loading={mutation === 'delete-reply'} title="设为不可见" message="回复将不再显示，对应待处理举报将一并标记为已处理。确认继续吗？" confirmText="设为不可见" showIcon={false} />
      <ConfirmDialog
        isOpen={Boolean(hideTarget)}
        onClose={() => { if (!mutation) setHideTarget(null); }}
        onConfirm={() => void hidePost()}
        loading={mutation === 'hide'}
        title="设为不可见"
        message={<>帖子《<strong className="break-all">{hideTarget?.title}</strong>》及其回复将不再对其他用户显示，但内容仍会保留。确认继续吗？</>}
        confirmText="设为不可见"
        showIcon={false}
      />
      <ConfirmDialog
        isOpen={Boolean(hardDeleteTarget)}
        onClose={() => { if (!mutation) setHardDeleteTarget(null); }}
        onConfirm={() => void hardDeletePost()}
        loading={mutation === 'hard-delete'}
        title="永久删除帖子"
        message={<>该操作会永久删除帖子《<strong className="break-all">{hardDeleteTarget?.title}</strong>》的正文、回复及相关互动记录，无法恢复；附件文件由存储回收流程另行清理。确认继续吗？</>}
        confirmText="永久删除"
      />
      <ConfirmDialog
        isOpen={Boolean(restoreTarget)}
        onClose={() => { if (!mutation) setRestoreTarget(null); }}
        onConfirm={() => void restorePost()}
        loading={mutation === 'restore'}
        title="重新设为可见"
        message={<>帖子《<strong className="break-all">{restoreTarget?.title}</strong>》及其中仍有效的回复将重新对论坛用户显示；已设为不可见或已删除的回复不会恢复。确认继续吗？</>}
        confirmText="设为可见"
        confirmVariant="primary"
        showIcon={false}
      />
    </AdminLayout>
  );
};

export default ForumManagementPage;
