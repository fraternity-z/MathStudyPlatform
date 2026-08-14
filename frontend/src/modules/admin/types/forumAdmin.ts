import type {
  ForumAuthor,
  ForumPostDetail,
  ForumPostListResponse,
  ForumReportReason,
  ForumReportTargetType,
  ForumSort,
} from '@/modules/forum/types';

export type ForumReportStatus = 'pending' | 'resolved' | 'dismissed';
export type ForumReportStatusFilter = 'all' | ForumReportStatus;

export interface ForumModerationReport {
  id: string;
  reporter: ForumAuthor;
  targetType: ForumReportTargetType;
  targetId: string;
  postId: string;
  reason: ForumReportReason;
  detail: string;
  status: ForumReportStatus;
  reviewedBy: string;
  reviewedAt: string;
  createdAt: string;
}

export interface ForumModerationReportListResponse {
  items: ForumModerationReport[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ForumModerationReportQuery {
  status: ForumReportStatusFilter;
  page: number;
  pageSize: number;
}

export type ForumModerationPostStatus = 'open' | 'resolved' | 'hidden' | 'deleted';
export type ForumModerationPost = ForumPostDetail;
export type ForumModerationPostListResponse = ForumPostListResponse;
export type ForumModerationPostStatusFilter = 'visible' | 'all' | ForumModerationPostStatus;

export interface ForumModerationPostQuery {
  search: string;
  status: ForumModerationPostStatusFilter;
  sort: ForumSort;
  page: number;
  pageSize: number;
}
