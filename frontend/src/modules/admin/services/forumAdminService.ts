import { apiClient } from '@/libs/http/apiClient';
import { forumService } from '@/modules/forum';
import type {
  ForumAuthor,
  ForumReportReason,
  ForumReportTargetType,
  ForumRole,
} from '@/modules/forum/types';
import type {
  ForumModerationPost,
  ForumModerationPostListResponse,
  ForumModerationPostQuery,
  ForumModerationReport,
  ForumModerationReportListResponse,
  ForumModerationReportQuery,
  ForumReportStatus,
} from '../types/forumAdmin';

interface RawForumAuthor {
  id?: string;
  name?: string;
  display_name?: string;
  role?: ForumRole;
  avatar_url?: string | null;
}

interface RawForumReport {
  id?: string;
  reporter?: RawForumAuthor;
  target_type?: ForumReportTargetType;
  target_id?: string;
  post_id?: string;
  reason?: ForumReportReason;
  detail?: string;
  status?: ForumReportStatus;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  created_at?: string;
}

interface RawForumReportListResponse {
  items?: RawForumReport[];
  total?: number;
  page?: number;
  page_size?: number;
}

function cleanCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

function mapAuthor(raw: RawForumAuthor | undefined): ForumAuthor {
  return {
    id: raw?.id ?? '',
    name: raw?.name ?? raw?.display_name ?? '未知用户',
    role: raw?.role ?? 'student',
    avatarUrl: raw?.avatar_url ?? '',
  };
}

function mapReport(raw: RawForumReport): ForumModerationReport {
  return {
    id: raw.id ?? '',
    reporter: mapAuthor(raw.reporter),
    targetType: raw.target_type ?? 'post',
    targetId: raw.target_id ?? '',
    postId: raw.post_id ?? '',
    reason: raw.reason ?? 'other',
    detail: raw.detail ?? '',
    status: raw.status ?? 'pending',
    reviewedBy: raw.reviewed_by ?? '',
    reviewedAt: raw.reviewed_at ?? '',
    createdAt: raw.created_at ?? '',
  };
}

function reportPath(id: string): string {
  return `/forum/moderation/reports/${encodeURIComponent(id)}`;
}

export const forumAdminService = {
  async listReports(
    query: ForumModerationReportQuery,
    signal?: AbortSignal,
  ): Promise<ForumModerationReportListResponse> {
    const response = await apiClient.get<RawForumReportListResponse>('/forum/moderation/reports', {
      params: {
        status: query.status,
        page: query.page,
        page_size: query.pageSize,
      },
      signal,
    });
    return {
      items: (response.data.items ?? []).map(mapReport).filter((item) => item.id),
      total: cleanCount(response.data.total),
      page: Math.max(1, cleanCount(response.data.page) || query.page),
      pageSize: Math.max(1, cleanCount(response.data.page_size) || query.pageSize),
    };
  },

  async resolveReport(id: string, status: ForumReportStatus): Promise<ForumModerationReport> {
    const response = await apiClient.put<RawForumReport>(reportPath(id), { status });
    return mapReport(response.data);
  },

  async listPosts(
    query: ForumModerationPostQuery,
    signal?: AbortSignal,
  ): Promise<ForumModerationPostListResponse> {
    const response = await forumService.list({
      search: query.search,
      status: query.status,
      sort: query.sort,
      scope: 'all',
      page: query.page,
      pageSize: query.pageSize,
    }, signal);
    return response as ForumModerationPostListResponse;
  },

  getPost(id: string, signal?: AbortSignal): Promise<ForumModerationPost> {
    return forumService.get(id, signal, false);
  },

  hidePost(id: string): Promise<void> {
    return forumService.hide(id);
  },

  restorePost(id: string): Promise<void> {
    return forumService.restore(id);
  },

  // Legacy alias: DELETE /posts/{id} now means make the post invisible.
  deletePost(id: string): Promise<void> {
    return forumService.hide(id);
  },

  permanentlyDeletePost(id: string): Promise<void> {
    return forumService.permanentlyDelete(id);
  },

  deleteReply(postId: string, replyId: string): Promise<void> {
    return forumService.deleteReply(postId, replyId);
  },
};
