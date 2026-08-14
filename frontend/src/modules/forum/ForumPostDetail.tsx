import { useMemo, useState } from 'react';
import {
  AtSign,
  ArrowLeft,
  CheckCircle2,
  Edit3,
  Eye,
  EyeOff,
  Heart,
  Loader2,
  MessageCircle,
  Reply as ReplyIcon,
  Sparkles,
  Star,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconTooltip } from '@/components/ui/IconTooltip';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { MarkdownContent } from '@/components/chat/MarkdownContent';
import { MessageComposer } from '@/modules/message-center/MessageComposer';
import { MessageAttachments } from '@/modules/message-center/MessageAttachments';
import type { MessageAttachment } from '@/modules/message-center/attachmentTypes';
import { formatRelativeTime } from '@/libs/utils/dateFormat';
import { cn } from '@/libs/utils/cn';

import type {
  CreateForumReplyPayload,
  ForumAuthor,
  ForumPostDetail,
  ForumReportReason,
  ForumReportTargetType,
  ForumReply,
  UpdateForumReplyPayload,
} from './types';
import { ForumReportModal, type ForumReportTarget } from './ForumReportModal';

interface ForumPostDetailProps {
  post: ForumPostDetail;
  actionKey: string;
  onBack: () => void;
  onEdit: () => void;
  onHide: () => void;
  onLike: () => Promise<void>;
  onFavorite: () => Promise<void>;
  onFeature: () => Promise<void>;
  onAccept: (replyId: string) => Promise<void>;
  onReply: (payload: CreateForumReplyPayload) => Promise<boolean>;
  onUpdateReply: (replyId: string, payload: UpdateForumReplyPayload) => Promise<boolean>;
  onDeleteReply: (replyId: string) => Promise<boolean>;
  onReport: (
    targetType: ForumReportTargetType,
    targetId: string,
    reason: ForumReportReason,
    detail: string,
  ) => Promise<boolean>;
}

const roleLabels = {
  student: '学生',
  teacher: '教师',
  admin: '管理员',
} as const;

function ForumMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn(
      'min-w-0 break-words text-sm leading-7 text-surface-700 dark:text-surface-300 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden',
      className,
    )}>
      <MarkdownContent content={content} />
    </div>
  );
}

function AuthorAvatar({ reply }: { reply: ForumReply }) {
  if (reply.author.avatarUrl) {
    return (
      <img
        src={reply.author.avatarUrl}
        alt=""
        className="h-9 w-9 shrink-0 rounded-full border border-surface-200 object-cover dark:border-surface-700"
      />
    );
  }
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-100 text-surface-500 dark:bg-surface-800 dark:text-surface-300">
      <UserRound className="h-4 w-4" />
    </span>
  );
}

export function ForumPostDetailPane({
  post,
  actionKey,
  onBack,
  onEdit,
  onHide,
  onLike,
  onFavorite,
  onFeature,
  onAccept,
  onReply,
  onUpdateReply,
  onDeleteReply,
  onReport,
}: ForumPostDetailProps) {
  const [replyDraft, setReplyDraft] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ForumReply | null>(null);
  const [replyError, setReplyError] = useState('');
  const [sending, setSending] = useState(false);
  const [reportTarget, setReportTarget] = useState<ForumReportTarget | null>(null);
  const [editingReply, setEditingReply] = useState<ForumReply | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editingReplyBusy, setEditingReplyBusy] = useState(false);
  const [deletingReplyId, setDeletingReplyId] = useState('');
  const [replyPendingDelete, setReplyPendingDelete] = useState<ForumReply | null>(null);
  const [mentionUserIDs, setMentionUserIDs] = useState<string[]>([]);

  const replyAuthors = useMemo(
    () => new Map(post.replies.map((reply) => [reply.id, reply.author.name])),
    [post.replies],
  );

  const mentionCandidates = useMemo(() => {
    const candidates = new Map<string, ForumAuthor>();
    if (post.author.id) candidates.set(post.author.id, post.author);
    post.replies.forEach((reply) => {
      if (reply.author.id) candidates.set(reply.author.id, reply.author);
    });
    return [...candidates.values()];
  }, [post]);

  const mentionCandidatesByID = useMemo(
    () => new Map(mentionCandidates.map((candidate) => [candidate.id, candidate])),
    [mentionCandidates],
  );

  const changeReplyDraft = (value: string) => {
    setReplyDraft(value);
    setMentionUserIDs((current) => current.filter((id) => {
      const candidate = mentionCandidatesByID.get(id);
      return Boolean(candidate && value.includes(`@${candidate.name}`));
    }));
  };

  const addMention = (userID: string) => {
    const candidate = mentionCandidatesByID.get(userID);
    if (!candidate) return;
    const token = `@${candidate.name}`;
    setReplyDraft((current) => {
      if (current.includes(token)) return current;
      const content = current.trimEnd();
      return `${content}${content ? ' ' : ''}${token} `;
    });
    setMentionUserIDs((current) => current.includes(userID) ? current : [...current, userID]);
    setReplyError('');
  };

  const beginReply = (reply: ForumReply) => {
    setReplyingTo(reply);
    setReplyError('');
    addMention(reply.author.id);
  };

  const submitReply = async () => {
    const content = replyDraft.trim();
    if (!content) {
      setReplyError('请输入回复内容');
      return;
    }
    if (content.length > 20_000) {
      setReplyError('回复内容不能超过 20000 个字符');
      return;
    }
    setSending(true);
    setReplyError('');
    const saved = await onReply({
      content,
      attachments,
      parentReplyId: replyingTo?.id,
      mentionUserIds: mentionUserIDs.filter((id) => {
        const candidate = mentionCandidatesByID.get(id);
        return Boolean(candidate && content.includes(`@${candidate.name}`));
      }),
    });
    setSending(false);
    if (!saved) return;
    setReplyDraft('');
    setAttachments([]);
    setReplyingTo(null);
    setMentionUserIDs([]);
  };

  const startEditReply = (reply: ForumReply) => {
    setEditingReply(reply);
    setEditDraft(reply.content);
  };

  const saveEditedReply = async () => {
    if (!editingReply || !editDraft.trim()) return;
    setEditingReplyBusy(true);
    const saved = await onUpdateReply(editingReply.id, {
      content: editDraft,
      attachments: editingReply.attachments,
    });
    setEditingReplyBusy(false);
    if (saved) setEditingReply(null);
  };

  const removeReply = async () => {
    if (!replyPendingDelete || deletingReplyId) return;
    const replyId = replyPendingDelete.id;
    setDeletingReplyId(replyId);
    const deleted = await onDeleteReply(replyId);
    setDeletingReplyId('');
    if (deleted) setReplyPendingDelete(null);
  };

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-white dark:bg-surface-900">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <article>
          <div className="border-b border-surface-100 px-4 py-4 sm:px-6 dark:border-surface-800">
            <Button variant="ghost" size="sm" className="mb-3 -ml-2 lg:hidden" onClick={onBack}>
              <ArrowLeft className="mr-1.5 h-4 w-4" />返回列表
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              {post.status === 'resolved' ? (
                <Badge variant="success"><CheckCircle2 className="mr-1 h-3 w-3" />已解决</Badge>
              ) : null}
              {post.featured ? (
                <Badge variant="warning"><Sparkles className="mr-1 h-3 w-3" />教师精选</Badge>
              ) : null}
            </div>

            <h2 className="mt-3 break-words text-xl font-semibold leading-8 text-surface-950 dark:text-surface-50">
              {post.title}
            </h2>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2 text-xs text-surface-500 dark:text-surface-400">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-100 dark:bg-surface-800">
                  <UserRound className="h-3.5 w-3.5" />
                </span>
                <span className="truncate font-medium text-surface-700 dark:text-surface-200">{post.author.name}</span>
                <span>{roleLabels[post.author.role]}</span>
                <span>·</span>
                <time dateTime={post.createdAt}>{formatRelativeTime(post.createdAt)}</time>
              </div>

              <div className="flex shrink-0 items-center gap-0.5">
                {post.canFeature ? (
                  <IconTooltip label={post.featured ? '取消精选' : '设为精选'} side="bottom">
                    <button
                      type="button"
                      aria-label={post.featured ? '取消精选' : '设为精选'}
                      aria-pressed={post.featured}
                      disabled={Boolean(actionKey)}
                      onClick={() => void onFeature()}
                      className={cn(
                        'grid h-9 w-9 place-items-center rounded-md hover:bg-surface-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50 dark:hover:bg-surface-800',
                        post.featured ? 'text-amber-600 dark:text-amber-400' : 'text-surface-400',
                      )}
                    >
                      {actionKey === 'feature' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    </button>
                  </IconTooltip>
                ) : null}
                {post.canReport ? (
                  <IconTooltip label="举报帖子" side="bottom">
                    <button
                      type="button"
                      aria-label="举报帖子"
                      disabled={Boolean(actionKey)}
                      onClick={() => setReportTarget({ type: 'post', id: post.id, label: post.title })}
                      className="grid h-9 w-9 place-items-center rounded-md text-surface-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                    >
                      <TriangleAlert className="h-4 w-4" />
                    </button>
                  </IconTooltip>
                ) : null}
                {post.canEdit ? (
                  <IconTooltip label="编辑帖子" side="bottom">
                    <button
                      type="button"
                      aria-label="编辑帖子"
                      disabled={Boolean(actionKey)}
                      onClick={onEdit}
                      className="grid h-9 w-9 place-items-center rounded-md text-surface-400 hover:bg-surface-100 hover:text-surface-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50 dark:hover:bg-surface-800 dark:hover:text-surface-200"
                    >
                      <Edit3 className="h-4 w-4" />
                    </button>
                  </IconTooltip>
                ) : null}
                {post.canDelete ? (
                  <IconTooltip label="设为不可见" side="bottom">
                    <button
                      type="button"
                      aria-label="设为不可见"
                      disabled={Boolean(actionKey)}
                      onClick={onHide}
                      className="grid h-9 w-9 place-items-center rounded-md text-surface-400 hover:bg-amber-50 hover:text-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50 dark:hover:bg-amber-950/30 dark:hover:text-amber-300"
                    >
                      <EyeOff className="h-4 w-4" />
                    </button>
                  </IconTooltip>
                ) : null}
              </div>
            </div>
          </div>

          <div className="space-y-5 px-4 py-5 sm:px-6">
            <ForumMarkdown content={post.content} className="text-[15px] leading-8" />
            <MessageAttachments attachments={post.attachments} />
            {post.tags.length > 0 || post.knowledgeNodeName ? (
              <div className="flex flex-wrap gap-1.5">
                {post.knowledgeNodeName ? <Badge variant="outline">{post.knowledgeNodeName}</Badge> : null}
                {post.tags.map((tag) => <Badge key={tag} variant="secondary">#{tag}</Badge>)}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-surface-100 py-3 dark:border-surface-800">
              <div className="flex items-center gap-1 text-xs text-surface-400">
                <Eye className="h-3.5 w-3.5" />{post.viewCount}
                <span className="mx-1">·</span>
                <MessageCircle className="h-3.5 w-3.5" />{post.replyCount}
              </div>
              <div className="flex items-center gap-1">
                <IconTooltip label={post.liked ? '取消点赞' : '点赞帖子'}>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${post.liked ? '取消点赞' : '点赞帖子'}，当前 ${post.likeCount} 人点赞`}
                    aria-pressed={post.liked}
                    disabled={Boolean(actionKey)}
                    onClick={() => void onLike()}
                    className={post.liked ? 'text-red-600 dark:text-red-400' : ''}
                  >
                    {actionKey === 'like' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Heart className={cn('mr-1.5 h-4 w-4', post.liked && 'fill-current')} />}
                    {post.likeCount}
                  </Button>
                </IconTooltip>
                <IconTooltip label={post.favorited ? '取消收藏' : '收藏帖子'}>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${post.favorited ? '取消收藏' : '收藏帖子'}，当前 ${post.favoriteCount} 人收藏`}
                    aria-pressed={post.favorited}
                    disabled={Boolean(actionKey)}
                    onClick={() => void onFavorite()}
                    className={post.favorited ? 'text-primary-600 dark:text-primary-400' : ''}
                  >
                    {actionKey === 'favorite' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Star className={cn('mr-1.5 h-4 w-4', post.favorited && 'fill-current')} />}
                    {post.favoriteCount}
                  </Button>
                </IconTooltip>
              </div>
            </div>
          </div>
        </article>

        <section aria-labelledby="forum-replies-heading" className="px-4 pb-5 sm:px-6">
          <h3 id="forum-replies-heading" className="mb-2 text-sm font-semibold text-surface-900 dark:text-surface-100">
            全部回复 <span className="ml-1 font-normal text-surface-400">{post.replies.length}</span>
          </h3>
          {post.replies.length === 0 ? (
            <div className="grid min-h-28 place-items-center border-y border-surface-100 text-sm text-surface-400 dark:border-surface-800">
              暂无回复
            </div>
          ) : (
            <div className="divide-y divide-surface-100 border-y border-surface-100 dark:divide-surface-800 dark:border-surface-800">
              {post.replies.map((reply) => (
                <article
                  key={reply.id}
                  className={cn(
                    'py-4',
                    reply.parentReplyId && 'ml-6 border-l-2 border-surface-100 pl-3 sm:ml-10 dark:border-surface-800',
                    reply.accepted && 'bg-emerald-50/60 px-3 dark:bg-emerald-950/15',
                  )}
                >
                  <div className="flex gap-3">
                    <AuthorAvatar reply={reply} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium text-surface-800 dark:text-surface-100">{reply.author.name}</span>
                        <span className="text-surface-400">{roleLabels[reply.author.role]}</span>
                        {reply.accepted ? (
                          <Badge variant="success"><CheckCircle2 className="mr-1 h-3 w-3" />最佳答案</Badge>
                        ) : null}
                        <time className="ml-auto text-surface-400" dateTime={reply.createdAt}>{formatRelativeTime(reply.createdAt)}</time>
                      </div>
                      {reply.parentReplyId ? (
                        <div className="mt-1 text-xs text-surface-400">回复 {replyAuthors.get(reply.parentReplyId) ?? '上层讨论'}</div>
                      ) : null}
                      <ForumMarkdown content={reply.content} className="mt-2" />
                      <MessageAttachments attachments={reply.attachments} />
                      <div className="mt-2 flex items-center gap-1">
                        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-surface-500" onClick={() => beginReply(reply)}>
                          <ReplyIcon className="mr-1 h-3.5 w-3.5" />回复
                        </Button>
                        {reply.canEdit ? (
                          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-surface-500" onClick={() => startEditReply(reply)}>
                            <Edit3 className="mr-1 h-3.5 w-3.5" />编辑
                          </Button>
                        ) : null}
                        {reply.canDelete ? (
                          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-surface-500 hover:text-amber-700 dark:hover:text-amber-300" onClick={() => setReplyPendingDelete(reply)} disabled={Boolean(deletingReplyId)}>
                            {deletingReplyId === reply.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <EyeOff className="mr-1 h-3.5 w-3.5" />}设为不可见
                          </Button>
                        ) : null}
                        {reply.canReport ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2 text-xs text-surface-500 hover:text-red-600 dark:hover:text-red-300"
                            onClick={() => setReportTarget({
                              type: 'reply',
                              id: reply.id,
                              label: `${reply.author.name} 的回复`,
                            })}
                          >
                            <TriangleAlert className="mr-1 h-3.5 w-3.5" />举报
                          </Button>
                        ) : null}
                        {post.canAcceptAnswer && !reply.accepted ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2 text-xs text-emerald-700 dark:text-emerald-400"
                            disabled={Boolean(actionKey)}
                            onClick={() => void onAccept(reply.id)}
                          >
                            {actionKey === `accept:${reply.id}` ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                            采纳
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="shrink-0 border-t border-surface-100 bg-white px-3 py-3 sm:px-5 dark:border-surface-800 dark:bg-surface-900">
        {replyingTo ? (
          <div className="mb-2 flex items-center justify-between rounded-md bg-primary-50 px-3 py-1.5 text-xs text-primary-700 dark:bg-primary-950/30 dark:text-primary-300">
            <span className="truncate">回复 {replyingTo.author.name}</span>
            <IconTooltip label="取消回复">
              <button type="button" aria-label="取消回复" onClick={() => setReplyingTo(null)} className="grid h-6 w-6 place-items-center rounded hover:bg-primary-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:hover:bg-primary-900/40">
                <X className="h-3.5 w-3.5" />
              </button>
            </IconTooltip>
          </div>
        ) : null}
        {mentionCandidates.length > 0 ? (
          <div className="mb-2 flex min-w-0 items-center gap-2">
            <AtSign className="h-4 w-4 shrink-0 text-surface-400" />
            <div className="min-w-0 flex-1 sm:max-w-xs">
              <Select
                value=""
                onChange={addMention}
                placeholder="提及参与者"
                options={mentionCandidates.map((candidate) => ({
                  value: candidate.id,
                  label: `${candidate.name}（${roleLabels[candidate.role]}）`,
                }))}
                aria-label="在回复中提及参与者"
                className="h-8 text-xs"
                disabled={sending}
              />
            </div>
            {mentionUserIDs.length > 0 ? (
              <span className="shrink-0 text-xs text-surface-400">已提及 {mentionUserIDs.length} 人</span>
            ) : null}
          </div>
        ) : null}
        <MessageComposer
          value={replyDraft}
          onChange={changeReplyDraft}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          onUploadingChange={setUploading}
          onError={setReplyError}
          onSend={submitReply}
          placeholder="写下你的回复"
          sendLabel="发送回复"
          disabled={sending}
          uploading={uploading}
          sending={sending}
          allowAttachmentOnly={false}
          maxLength={20_000}
        />
        {replyError ? <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{replyError}</p> : null}
      </div>
      </div>
      <Modal
        isOpen={Boolean(editingReply)}
        onClose={editingReplyBusy ? () => undefined : () => setEditingReply(null)}
        title="编辑回复"
        className="max-w-lg rounded-lg p-6"
      >
        <textarea
          value={editDraft}
          onChange={(event) => setEditDraft(event.target.value)}
          maxLength={20_000}
          rows={5}
          aria-label="回复内容"
          className="w-full resize-y rounded-md border border-surface-200 bg-transparent p-3 text-sm outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 dark:border-surface-700"
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditingReply(null)} disabled={editingReplyBusy}>取消</Button>
          <Button size="sm" onClick={() => void saveEditedReply()} disabled={editingReplyBusy || !editDraft.trim()}>
            {editingReplyBusy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}保存
          </Button>
        </div>
      </Modal>
      {reportTarget ? (
        <ForumReportModal
          key={`${reportTarget.type}:${reportTarget.id}`}
          target={reportTarget}
          onClose={() => setReportTarget(null)}
          onSubmit={onReport}
        />
      ) : null}
      <ConfirmDialog
        isOpen={Boolean(replyPendingDelete)}
        onClose={() => { if (!deletingReplyId) setReplyPendingDelete(null); }}
        onConfirm={() => void removeReply()}
        loading={Boolean(deletingReplyId)}
        title="设为不可见"
        message="这条回复将不再显示，但内容仍会保留。确认继续吗？"
        confirmText="设为不可见"
        showIcon={false}
      />
    </>
  );
}
