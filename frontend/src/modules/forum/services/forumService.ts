import { apiClient } from '@/libs/http/apiClient';
import type { MessageAttachment } from '@/modules/message-center/attachmentTypes';
import type {
  CreateForumReplyPayload,
  ForumAuthor,
  ForumBoard,
  ForumNotification,
  ForumNotificationEvent,
  ForumNotificationListResponse,
  ForumNotificationQuery,
  ForumPost,
  ForumPostDetail,
  ForumPostListResponse,
  ForumPostQuery,
  ForumPostStatus,
  ForumPostType,
  ForumReportReason,
  ForumReportTargetType,
  ForumReply,
  ForumRole,
  SaveForumPostPayload,
  UpdateForumReplyPayload,
} from '../types';

interface RawBoard {
  id?: string;
  slug?: string;
  name?: string;
  description?: string;
  sort_order?: number;
}

interface RawAuthor {
  id?: string;
  name?: string;
  display_name?: string;
  role?: ForumRole;
  avatar_url?: string | null;
}

interface RawReply {
  id?: string;
  post_id?: string;
  parent_reply_id?: string | null;
  content?: string;
  body?: string;
  attachments?: MessageAttachment[];
  author?: RawAuthor;
  is_accepted?: boolean;
  is_own?: boolean;
  can_edit?: boolean;
  can_delete?: boolean;
  can_report?: boolean;
  status?: 'active' | 'hidden' | 'deleted';
  created_at?: string;
  updated_at?: string;
}

interface RawPost {
  id?: string;
  board?: RawBoard;
  board_slug?: string;
  board_name?: string;
  category?: string;
  type?: ForumPostType;
  post_type?: ForumPostType;
  title?: string;
  excerpt?: string;
  content?: string;
  body?: string;
  attachments?: MessageAttachment[];
  tags?: string[];
  knowledge_node_id?: string | null;
  knowledge_node_name?: string | null;
  author?: RawAuthor;
  status?: ForumPostStatus;
  accepted_reply_id?: string | null;
  is_featured?: boolean;
  is_liked?: boolean;
  is_favorited?: boolean;
  is_own?: boolean;
  can_edit?: boolean;
  can_delete?: boolean;
  can_accept_answer?: boolean;
  can_feature?: boolean;
  can_report?: boolean;
  permissions?: {
    can_edit?: boolean;
    can_delete?: boolean;
    can_accept_answer?: boolean;
    can_feature?: boolean;
    can_report?: boolean;
  };
  is_unread?: boolean;
  unread?: boolean;
  view_count?: number;
  reply_count?: number;
  like_count?: number;
  favorite_count?: number;
  created_at?: string;
  updated_at?: string;
  replies?: RawReply[];
}

interface RawPostListResponse {
  items?: RawPost[];
  total?: number;
  page?: number;
  page_size?: number;
}

interface RawBoardListResponse {
  items?: RawBoard[];
}

interface RawNotification {
  id?: string;
  event_type?: ForumNotificationEvent;
  post_id?: string | null;
  reply_id?: string | null;
  title?: string;
  summary?: string;
  actor?: RawAuthor | null;
  is_read?: boolean;
  read_at?: string | null;
  created_at?: string;
}

interface RawNotificationListResponse {
  items?: RawNotification[];
  total?: number;
  page?: number;
  page_size?: number;
  unread_count?: number;
  unread?: number;
}

interface RawUnreadPostIDsResponse {
  post_ids?: string[];
}

interface RawUpdatedCountResponse {
  updated_count?: number;
}

function cleanCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

function mapBoard(raw: RawBoard | undefined, fallbackSlug = '', fallbackName = ''): ForumBoard {
  return {
    id: raw?.id ?? '',
    slug: raw?.slug || fallbackSlug,
    name: raw?.name || fallbackName || fallbackSlug,
    description: raw?.description ?? '',
    sortOrder: cleanCount(raw?.sort_order),
  };
}

function mapAuthor(raw: RawAuthor | undefined): ForumAuthor {
  return {
    id: raw?.id ?? '',
    name: raw?.name ?? raw?.display_name ?? '已注销用户',
    role: raw?.role ?? 'student',
    avatarUrl: raw?.avatar_url ?? '',
  };
}

function mapReply(raw: RawReply): ForumReply {
  return {
    id: raw.id ?? '',
    postId: raw.post_id ?? '',
    parentReplyId: raw.parent_reply_id ?? '',
    content: raw.content ?? raw.body ?? '',
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    author: mapAuthor(raw.author),
    accepted: raw.is_accepted ?? false,
    own: raw.is_own ?? false,
    canEdit: raw.can_edit ?? raw.is_own ?? false,
    canDelete: raw.can_delete ?? raw.is_own ?? false,
    canReport: raw.can_report ?? false,
    status: raw.status ?? 'active',
    createdAt: raw.created_at ?? '',
    updatedAt: raw.updated_at ?? raw.created_at ?? '',
  };
}

function mapPost(raw: RawPost): ForumPost {
  return {
    id: raw.id ?? '',
    board: mapBoard(raw.board, raw.board_slug, raw.board_name),
    category: raw.category ?? '',
    type: raw.type ?? raw.post_type ?? 'discussion',
    title: raw.title ?? '',
    excerpt: raw.excerpt ?? '',
    content: raw.content ?? raw.body ?? '',
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    knowledgeNodeId: raw.knowledge_node_id ?? '',
    knowledgeNodeName: raw.knowledge_node_name ?? '',
    author: mapAuthor(raw.author),
    status: raw.status ?? 'open',
    acceptedReplyId: raw.accepted_reply_id ?? '',
    featured: raw.is_featured ?? false,
    liked: raw.is_liked ?? false,
    favorited: raw.is_favorited ?? false,
    own: raw.is_own ?? false,
    canEdit: raw.permissions?.can_edit ?? raw.can_edit ?? raw.is_own ?? false,
    canDelete: raw.permissions?.can_delete ?? raw.can_delete ?? raw.is_own ?? false,
    canAcceptAnswer: raw.permissions?.can_accept_answer ?? raw.can_accept_answer ?? false,
    canFeature: raw.permissions?.can_feature ?? raw.can_feature ?? false,
    canReport: raw.permissions?.can_report ?? raw.can_report ?? false,
    unread: raw.is_unread ?? raw.unread ?? false,
    viewCount: cleanCount(raw.view_count),
    replyCount: cleanCount(raw.reply_count),
    likeCount: cleanCount(raw.like_count),
    favoriteCount: cleanCount(raw.favorite_count),
    createdAt: raw.created_at ?? '',
    updatedAt: raw.updated_at ?? raw.created_at ?? '',
  };
}

function mapPostDetail(raw: RawPost): ForumPostDetail {
  return {
    ...mapPost(raw),
    replies: (raw.replies ?? []).map(mapReply).filter((reply) => reply.id),
  };
}

function postPath(id: string, suffix = ''): string {
  return `/forum/posts/${encodeURIComponent(id)}${suffix}`;
}

function toPostPayload(payload: SaveForumPostPayload) {
  return {
    ...(payload.boardSlug ? { board_slug: payload.boardSlug } : {}),
    ...(payload.type ? { type: payload.type } : {}),
    title: payload.title.trim(),
    content: payload.content.trim(),
    attachments: payload.attachments,
    tags: payload.tags,
    knowledge_node_id: payload.knowledgeNodeId || undefined,
  };
}

export const forumService = {
  async boards(signal?: AbortSignal): Promise<ForumBoard[]> {
    const response = await apiClient.get<RawBoardListResponse>('/forum/boards', { signal });
    return (response.data.items ?? [])
      .map((item) => mapBoard(item))
      .filter((item) => item.id && item.slug)
      .sort((left, right) => left.sortOrder - right.sortOrder);
  },

  async list(query: ForumPostQuery, signal?: AbortSignal): Promise<ForumPostListResponse> {
    const response = await apiClient.get<RawPostListResponse>('/forum/posts', {
      params: {
        search: query.search || undefined,
        board: query.boardSlug || undefined,
        type: query.type || undefined,
        status: query.status || undefined,
        sort: query.sort || 'latest',
        scope: query.scope && query.scope !== 'all' ? query.scope : undefined,
        page: query.page ?? 1,
        page_size: query.pageSize ?? 20,
      },
      signal,
    });
    return {
      items: (response.data.items ?? []).map(mapPost).filter((item) => item.id),
      total: cleanCount(response.data.total),
      page: Math.max(1, cleanCount(response.data.page) || query.page || 1),
      pageSize: Math.max(1, cleanCount(response.data.page_size) || query.pageSize || 20),
    };
  },

  async get(id: string, signal?: AbortSignal, incrementView = true): Promise<ForumPostDetail> {
    const response = await apiClient.get<RawPost>(postPath(id), {
      params: { increment_view: incrementView },
      signal,
    });
    return mapPostDetail(response.data);
  },

  async create(payload: SaveForumPostPayload): Promise<ForumPost> {
    const response = await apiClient.post<RawPost>('/forum/posts', toPostPayload(payload));
    return mapPost(response.data);
  },

  async update(id: string, payload: SaveForumPostPayload): Promise<ForumPost> {
    const response = await apiClient.patch<RawPost>(postPath(id), toPostPayload(payload));
    return mapPost(response.data);
  },

  async hide(id: string): Promise<void> {
    await apiClient.delete(postPath(id));
  },

  async restore(id: string): Promise<void> {
    await apiClient.post(postPath(id, '/restore'));
  },

  // Keep the legacy service alias for callers outside the forum screens; the
  // endpoint now represents making a post invisible rather than hard delete.
  async delete(id: string): Promise<void> {
    await apiClient.delete(postPath(id));
  },

  async permanentlyDelete(id: string): Promise<void> {
    await apiClient.delete(postPath(id, '/permanent'));
  },

  async createReply(postId: string, payload: CreateForumReplyPayload): Promise<ForumReply> {
    const response = await apiClient.post<RawReply>(postPath(postId, '/replies'), {
      content: payload.content.trim(),
      attachments: payload.attachments,
      parent_reply_id: payload.parentReplyId || undefined,
      mention_user_ids: payload.mentionUserIds?.length ? payload.mentionUserIds : undefined,
    });
    return mapReply(response.data);
  },

  async updateReply(postId: string, replyId: string, payload: UpdateForumReplyPayload): Promise<ForumReply> {
    const response = await apiClient.patch<RawReply>(postPath(postId, `/replies/${encodeURIComponent(replyId)}`), {
      content: payload.content.trim(),
      attachments: payload.attachments,
    });
    return mapReply(response.data);
  },

  async deleteReply(postId: string, replyId: string): Promise<void> {
    await apiClient.delete(postPath(postId, `/replies/${encodeURIComponent(replyId)}`));
  },

  async likePost(id: string, liked: boolean): Promise<void> {
    if (liked) await apiClient.post(postPath(id, '/like'));
    else await apiClient.delete(postPath(id, '/like'));
  },

  async favoritePost(id: string, favorited: boolean): Promise<void> {
    if (favorited) await apiClient.post(postPath(id, '/favorite'));
    else await apiClient.delete(postPath(id, '/favorite'));
  },

  async acceptAnswer(postId: string, replyId: string): Promise<void> {
    await apiClient.post(postPath(postId, `/replies/${encodeURIComponent(replyId)}/accept`));
  },

  async featurePost(id: string, featured: boolean): Promise<void> {
    if (featured) await apiClient.post(postPath(id, '/feature'));
    else await apiClient.delete(postPath(id, '/feature'));
  },

  async report(
    targetType: ForumReportTargetType,
    targetId: string,
    reason: ForumReportReason,
    detail: string,
  ): Promise<void> {
    await apiClient.post('/forum/reports', {
      target_type: targetType,
      target_id: targetId,
      reason,
      detail,
    });
  },

  async notifications(
    query: ForumNotificationQuery = {},
    signal?: AbortSignal,
  ): Promise<ForumNotificationListResponse> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const response = await apiClient.get<RawNotificationListResponse>('/forum/notifications', {
      params: { unread_only: query.unreadOnly ?? false, page, page_size: pageSize },
      signal,
    });
    return {
      items: (response.data.items ?? []).map((item): ForumNotification => ({
        id: item.id ?? '',
        eventType: item.event_type ?? 'reply',
        postId: item.post_id ?? '',
        replyId: item.reply_id ?? '',
        title: item.title ?? '',
        summary: item.summary ?? '',
        actor: item.actor ? mapAuthor(item.actor) : null,
        read: item.is_read ?? Boolean(item.read_at),
        createdAt: item.created_at ?? '',
      })).filter((item) => item.id),
      total: cleanCount(response.data.total),
      page: Math.max(1, cleanCount(response.data.page) || page),
      pageSize: Math.max(1, cleanCount(response.data.page_size) || pageSize),
      unreadCount: cleanCount(response.data.unread_count ?? response.data.unread),
    };
  },

  async markNotificationRead(id: string): Promise<void> {
    await apiClient.put(`/forum/notifications/${encodeURIComponent(id)}/read`);
  },

  async unreadPostIDs(signal?: AbortSignal): Promise<string[]> {
    const response = await apiClient.get<RawUnreadPostIDsResponse>('/forum/notifications/unread-post-ids', { signal });
    return [...new Set((response.data.post_ids ?? []).filter(Boolean))];
  },

  async markPostNotificationsRead(postId: string): Promise<number> {
    const response = await apiClient.put<RawUpdatedCountResponse>(
      `/forum/notifications/posts/${encodeURIComponent(postId)}/read`,
    );
    return cleanCount(response.data.updated_count);
  },
};
