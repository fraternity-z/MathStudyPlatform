import type { MessageAttachment } from '@/modules/message-center/attachmentTypes';

export type ForumRole = 'student' | 'teacher' | 'admin';
export type ForumPostType = 'question' | 'discussion' | 'resource';
export type ForumPostStatus = 'open' | 'resolved' | 'hidden' | 'deleted';
export type ForumPostStatusFilter = ForumPostStatus | 'visible' | 'all';
export type ForumSort = 'latest' | 'hot' | 'featured';
export type ForumScope = 'all' | 'mine' | 'replied' | 'favorites';
export type ForumReportTargetType = 'post' | 'reply';
export type ForumReportReason = 'spam' | 'abuse' | 'answer_leak' | 'misinformation' | 'copyright' | 'other';

export interface ForumBoard {
  id: string;
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
}

export interface ForumAuthor {
  id: string;
  name: string;
  role: ForumRole;
  avatarUrl: string;
}

export interface ForumReply {
  id: string;
  postId: string;
  parentReplyId: string;
  content: string;
  attachments: MessageAttachment[];
  author: ForumAuthor;
  accepted: boolean;
  own: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReport: boolean;
  status: 'active' | 'hidden' | 'deleted';
  createdAt: string;
  updatedAt: string;
}

export interface ForumPost {
  id: string;
  board: ForumBoard;
  category: string;
  type: ForumPostType;
  title: string;
  excerpt: string;
  content: string;
  attachments: MessageAttachment[];
  tags: string[];
  knowledgeNodeId: string;
  knowledgeNodeName: string;
  author: ForumAuthor;
  status: ForumPostStatus;
  acceptedReplyId: string;
  featured: boolean;
  liked: boolean;
  favorited: boolean;
  own: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canAcceptAnswer: boolean;
  canFeature: boolean;
  canReport: boolean;
  unread: boolean;
  viewCount: number;
  replyCount: number;
  likeCount: number;
  favoriteCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ForumPostDetail extends ForumPost {
  replies: ForumReply[];
}

export interface ForumPostListResponse {
  items: ForumPost[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ForumPostQuery {
  search?: string;
  boardSlug?: string;
  type?: ForumPostType;
  status?: ForumPostStatusFilter;
  sort?: ForumSort;
  scope?: ForumScope;
  page?: number;
  pageSize?: number;
}

export interface SaveForumPostPayload {
  boardSlug?: string;
  type?: ForumPostType;
  title: string;
  content: string;
  attachments: MessageAttachment[];
  tags: string[];
  knowledgeNodeId?: string;
}

export interface CreateForumReplyPayload {
  content: string;
  attachments: MessageAttachment[];
  parentReplyId?: string;
  mentionUserIds?: string[];
}

export interface UpdateForumReplyPayload {
  content: string;
  attachments: MessageAttachment[];
}

export type ForumNotificationEvent = 'reply' | 'mention' | 'like' | 'accepted' | 'featured';

export interface ForumNotification {
  id: string;
  eventType: ForumNotificationEvent;
  postId: string;
  replyId: string;
  title: string;
  summary: string;
  actor: ForumAuthor | null;
  read: boolean;
  createdAt: string;
}

export interface ForumNotificationListResponse {
  items: ForumNotification[];
  total: number;
  page: number;
  pageSize: number;
  unreadCount: number;
}

export interface ForumNotificationQuery {
  unreadOnly?: boolean;
  page?: number;
  pageSize?: number;
}
