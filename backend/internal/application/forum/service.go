// Package forum implements the global learning forum use cases.
package forum

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"mathstudy/backend/internal/application/messageattachment"
	"mathstudy/backend/internal/domain/user"
	"mathstudy/backend/internal/platform/identifier"
)

var (
	ErrInvalidInput = errors.New("forum invalid input")
	ErrForbidden    = errors.New("forum forbidden")
	ErrNotFound     = errors.New("forum not found")
	ErrConflict     = errors.New("forum conflict")
)

const (
	maxIdentifierRunes = 36
	maxSearchRunes     = 200
	maxTitleRunes      = 200
	maxContentRunes    = 50000
	maxReplyRunes      = 20000
	maxTagRunes        = 30
	maxTags            = 8
	maxMentions        = 20
	maxReportRunes     = 2000
	maxPageNumber      = 10000
	maxPageSize        = 100
)

type PostType string

const (
	PostTypeQuestion   PostType = "question"
	PostTypeDiscussion PostType = "discussion"
	PostTypeResource   PostType = "resource"

	// DefaultBoardSlug keeps the legacy board-backed schema usable when the
	// publish form does not expose a board selector.
	DefaultBoardSlug = "learning-methods"
	// DefaultPostType keeps posts published without a type as discussions.
	DefaultPostType = PostTypeDiscussion
)

type Author struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Role      user.Role `json:"role"`
	AvatarURL string    `json:"avatar_url,omitempty"`
}

type Board struct {
	ID          string `json:"id"`
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Description string `json:"description"`
	SortOrder   int    `json:"sort_order"`
}

type Permissions struct {
	CanEdit         bool `json:"can_edit"`
	CanDelete       bool `json:"can_delete"`
	CanAcceptAnswer bool `json:"can_accept_answer"`
	CanFeature      bool `json:"can_feature"`
	CanReport       bool `json:"can_report"`
}

type Post struct {
	ID                string                         `json:"id"`
	Board             Board                          `json:"board"`
	Category          string                         `json:"category"`
	Type              PostType                       `json:"type"`
	Title             string                         `json:"title"`
	Excerpt           string                         `json:"excerpt"`
	Content           string                         `json:"content,omitempty"`
	Attachments       []messageattachment.Attachment `json:"attachments"`
	Tags              []string                       `json:"tags"`
	KnowledgeNodeID   string                         `json:"knowledge_node_id,omitempty"`
	KnowledgeNodeName string                         `json:"knowledge_node_name,omitempty"`
	Author            Author                         `json:"author"`
	Status            string                         `json:"status"`
	IsFeatured        bool                           `json:"is_featured"`
	AcceptedReplyID   string                         `json:"accepted_reply_id,omitempty"`
	ReplyCount        int                            `json:"reply_count"`
	LikeCount         int                            `json:"like_count"`
	FavoriteCount     int                            `json:"favorite_count"`
	ViewCount         int                            `json:"view_count"`
	IsLiked           bool                           `json:"is_liked"`
	IsFavorited       bool                           `json:"is_favorited"`
	Permissions       Permissions                    `json:"permissions"`
	CreatedAt         time.Time                      `json:"created_at"`
	UpdatedAt         time.Time                      `json:"updated_at"`
}

type Reply struct {
	ID            string                         `json:"id"`
	PostID        string                         `json:"post_id"`
	ParentReplyID string                         `json:"parent_reply_id,omitempty"`
	Author        Author                         `json:"author"`
	Content       string                         `json:"content"`
	Attachments   []messageattachment.Attachment `json:"attachments"`
	Status        string                         `json:"status"`
	IsAccepted    bool                           `json:"is_accepted"`
	CanEdit       bool                           `json:"can_edit"`
	CanDelete     bool                           `json:"can_delete"`
	CanReport     bool                           `json:"can_report"`
	CreatedAt     time.Time                      `json:"created_at"`
	UpdatedAt     time.Time                      `json:"updated_at"`
}

type PostDetail struct {
	Post
	Replies []Reply `json:"replies"`
}

type ListPostsFilter struct {
	Search    string
	BoardSlug string
	Type      PostType
	Status    string
	Sort      string
	Scope     string
	Page      int
	PageSize  int
}

type ListPostsResponse struct {
	Items    []Post `json:"items"`
	Total    int    `json:"total"`
	Page     int    `json:"page"`
	PageSize int    `json:"page_size"`
}

type CreatePostInput struct {
	// BoardID and BoardSlug are optional for the publish flow. When both are
	// empty, the application assigns DefaultBoardSlug.
	BoardID   string
	BoardSlug string
	// Type defaults to DefaultPostType when omitted.
	Type            PostType
	Title           string
	Content         string
	Attachments     []messageattachment.Attachment
	Tags            []string
	KnowledgeNodeID string
}

type UpdatePostInput struct {
	BoardID         *string
	BoardSlug       *string
	Type            *PostType
	Title           *string
	Content         *string
	Attachments     *[]messageattachment.Attachment
	Tags            *[]string
	KnowledgeNodeID *string
}

type CreateReplyInput struct {
	ParentReplyID  string
	Content        string
	Attachments    []messageattachment.Attachment
	MentionUserIDs []string
}

type UpdateReplyInput struct {
	Content     *string
	Attachments *[]messageattachment.Attachment
}

type InteractionResult struct {
	Active bool `json:"active"`
	Count  int  `json:"count"`
}

type Report struct {
	ID         string     `json:"id"`
	Reporter   Author     `json:"reporter"`
	TargetType string     `json:"target_type"`
	TargetID   string     `json:"target_id"`
	PostID     string     `json:"post_id,omitempty"`
	Reason     string     `json:"reason"`
	Detail     string     `json:"detail"`
	Status     string     `json:"status"`
	ReviewedBy string     `json:"reviewed_by,omitempty"`
	ReviewedAt *time.Time `json:"reviewed_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

type Notification struct {
	ID        string     `json:"id"`
	EventType string     `json:"event_type"`
	Actor     *Author    `json:"actor,omitempty"`
	PostID    string     `json:"post_id"`
	ReplyID   string     `json:"reply_id,omitempty"`
	Title     string     `json:"title"`
	Summary   string     `json:"summary"`
	IsRead    bool       `json:"is_read"`
	ReadAt    *time.Time `json:"read_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

type ListNotificationsResponse struct {
	Items    []Notification `json:"items"`
	Total    int            `json:"total"`
	Unread   int            `json:"unread"`
	Page     int            `json:"page"`
	PageSize int            `json:"page_size"`
}

type ListReportsResponse struct {
	Items    []Report `json:"items"`
	Total    int      `json:"total"`
	Page     int      `json:"page"`
	PageSize int      `json:"page_size"`
}

type Repository interface {
	ListBoards(context.Context) ([]Board, error)
	ListPosts(context.Context, string, user.Role, ListPostsFilter) ([]Post, int, error)
	GetPost(context.Context, string, string, user.Role, bool) (PostDetail, bool, error)
	CreatePost(context.Context, string, string, user.Role, time.Time, CreatePostInput) (PostDetail, error)
	UpdatePost(context.Context, string, string, user.Role, time.Time, UpdatePostInput) (PostDetail, bool, bool, error)
	DeletePost(context.Context, string, string, user.Role, time.Time) (bool, bool, error)
	RestorePost(context.Context, string, time.Time) (bool, bool, error)
	HardDeletePost(context.Context, string) (bool, error)
	CreateReply(context.Context, string, string, string, user.Role, time.Time, CreateReplyInput) (Reply, bool, error)
	UpdateReply(context.Context, string, string, string, time.Time, UpdateReplyInput) (Reply, bool, bool, error)
	DeleteReply(context.Context, string, string, string, user.Role, time.Time) (bool, bool, error)
	SetPostLike(context.Context, string, string, user.Role, bool, time.Time) (InteractionResult, bool, error)
	SetPostFavorite(context.Context, string, string, bool, time.Time) (InteractionResult, bool, error)
	AcceptReply(context.Context, string, string, string, user.Role, time.Time) (PostDetail, bool, bool, error)
	SetFeatured(context.Context, string, string, user.Role, bool, time.Time) (PostDetail, bool, bool, error)
	CreateReport(context.Context, string, string, string, string, string, string, time.Time) (Report, bool, error)
	ListNotifications(context.Context, string, bool, int, int) ([]Notification, int, int, error)
	MarkNotificationRead(context.Context, string, string, time.Time) (bool, error)
	MarkPostNotificationsRead(context.Context, string, string, time.Time) (int, error)
	MarkAllNotificationsRead(context.Context, string, time.Time) (int, error)
	ListUnreadNotificationPostIDs(context.Context, string) ([]string, error)
	ListReports(context.Context, string, int, int) ([]Report, int, error)
	ResolveReport(context.Context, string, string, string, time.Time) (Report, bool, error)
}

type Service struct {
	repo  Repository
	now   func() time.Time
	newID func() (string, error)
}

func NewService(repo Repository) (*Service, error) {
	if repo == nil {
		return nil, errors.New("forum repository is nil")
	}
	return &Service{repo: repo, now: time.Now, newID: identifier.NewUUID}, nil
}

func (s *Service) ListBoards(ctx context.Context, role user.Role) ([]Board, error) {
	if !validRole(role) {
		return nil, ErrForbidden
	}
	return s.repo.ListBoards(ctx)
}

func (s *Service) ListPosts(ctx context.Context, viewerID string, role user.Role, filter ListPostsFilter) (ListPostsResponse, error) {
	if !validRole(role) {
		return ListPostsResponse{}, ErrForbidden
	}
	filter.Search = strings.TrimSpace(filter.Search)
	filter.BoardSlug = strings.TrimSpace(filter.BoardSlug)
	filter.Status = strings.TrimSpace(filter.Status)
	filter.Sort = strings.TrimSpace(filter.Sort)
	filter.Scope = strings.TrimSpace(filter.Scope)
	if filter.Sort == "" {
		filter.Sort = "latest"
	}
	if filter.Status == "" {
		filter.Status = "visible"
	}
	if !validListFilter(filter, role) {
		return ListPostsResponse{}, ErrInvalidInput
	}
	items, total, err := s.repo.ListPosts(ctx, viewerID, role, filter)
	if err != nil {
		return ListPostsResponse{}, err
	}
	return ListPostsResponse{Items: items, Total: total, Page: filter.Page, PageSize: filter.PageSize}, nil
}

func (s *Service) GetPost(ctx context.Context, viewerID, postID string, role user.Role, incrementView bool) (PostDetail, error) {
	if !validRole(role) || !validIdentifier(postID) {
		return PostDetail{}, ErrInvalidInput
	}
	// Moderation reads are observational and must not influence popularity.
	if role == user.RoleAdmin {
		incrementView = false
	}
	item, found, err := s.repo.GetPost(ctx, postID, viewerID, role, incrementView)
	if err != nil {
		return PostDetail{}, err
	}
	if !found {
		return PostDetail{}, ErrNotFound
	}
	return item, nil
}

func (s *Service) CreatePost(ctx context.Context, authorID string, role user.Role, input CreatePostInput) (PostDetail, error) {
	if !validRole(role) {
		return PostDetail{}, ErrForbidden
	}
	normalized, err := normalizeCreatePost(input)
	if err != nil {
		return PostDetail{}, err
	}
	id, err := s.newID()
	if err != nil {
		return PostDetail{}, fmt.Errorf("generate forum post id: %w", err)
	}
	return s.repo.CreatePost(ctx, id, authorID, role, s.now(), normalized)
}

func (s *Service) UpdatePost(ctx context.Context, actorID, postID string, role user.Role, input UpdatePostInput) (PostDetail, error) {
	if !validRole(role) || !validIdentifier(postID) {
		return PostDetail{}, ErrInvalidInput
	}
	normalized, err := normalizeUpdatePost(input)
	if err != nil {
		return PostDetail{}, err
	}
	item, found, allowed, err := s.repo.UpdatePost(ctx, postID, actorID, role, s.now(), normalized)
	if err != nil {
		return PostDetail{}, err
	}
	if !found {
		return PostDetail{}, ErrNotFound
	}
	if !allowed {
		return PostDetail{}, ErrForbidden
	}
	return item, nil
}

func (s *Service) DeletePost(ctx context.Context, actorID, postID string, role user.Role) error {
	if !validRole(role) || !validIdentifier(postID) {
		return ErrInvalidInput
	}
	found, allowed, err := s.repo.DeletePost(ctx, postID, actorID, role, s.now())
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	if !allowed {
		return ErrForbidden
	}
	return nil
}

// RestorePost makes a hidden forum post visible again. Restoring is restricted
// to administrators, is idempotent for visible posts, and rejects legacy
// deleted posts that cannot be recovered safely.
func (s *Service) RestorePost(ctx context.Context, postID string, role user.Role) error {
	if role != user.RoleAdmin {
		return ErrForbidden
	}
	if !validIdentifier(postID) {
		return ErrInvalidInput
	}
	found, restored, err := s.repo.RestorePost(ctx, postID, s.now())
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	if !restored {
		return ErrConflict
	}
	return nil
}

// HardDeletePost permanently removes a forum post. This is deliberately
// restricted to administrators because the operation cannot be undone.
func (s *Service) HardDeletePost(ctx context.Context, postID string, role user.Role) error {
	if role != user.RoleAdmin {
		return ErrForbidden
	}
	if !validIdentifier(postID) {
		return ErrInvalidInput
	}
	found, err := s.repo.HardDeletePost(ctx, postID)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	return nil
}

func (s *Service) CreateReply(ctx context.Context, actorID, postID string, role user.Role, input CreateReplyInput) (Reply, error) {
	if !validRole(role) || !validIdentifier(postID) {
		return Reply{}, ErrInvalidInput
	}
	normalized, err := normalizeReply(input)
	if err != nil {
		return Reply{}, err
	}
	id, err := s.newID()
	if err != nil {
		return Reply{}, fmt.Errorf("generate forum reply id: %w", err)
	}
	item, found, err := s.repo.CreateReply(ctx, id, postID, actorID, role, s.now(), normalized)
	if err != nil {
		return Reply{}, err
	}
	if !found {
		return Reply{}, ErrNotFound
	}
	return item, nil
}

func (s *Service) UpdateReply(ctx context.Context, actorID, postID, replyID string, role user.Role, input UpdateReplyInput) (Reply, error) {
	if !validRole(role) || !validIdentifier(postID) || !validIdentifier(replyID) {
		return Reply{}, ErrInvalidInput
	}
	normalized, err := normalizeUpdateReply(input)
	if err != nil {
		return Reply{}, err
	}
	item, found, allowed, err := s.repo.UpdateReply(ctx, postID, replyID, actorID, s.now(), normalized)
	if err != nil {
		return Reply{}, err
	}
	if !found {
		return Reply{}, ErrNotFound
	}
	if !allowed {
		return Reply{}, ErrForbidden
	}
	return item, nil
}

func (s *Service) DeleteReply(ctx context.Context, actorID, postID, replyID string, role user.Role) error {
	if !validRole(role) || !validIdentifier(postID) || !validIdentifier(replyID) {
		return ErrInvalidInput
	}
	found, allowed, err := s.repo.DeleteReply(ctx, postID, replyID, actorID, role, s.now())
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	if !allowed {
		return ErrForbidden
	}
	return nil
}

func (s *Service) SetPostLike(ctx context.Context, actorID, postID string, role user.Role, active bool) (InteractionResult, error) {
	return s.setPostInteraction(ctx, actorID, postID, role, active, true)
}

func (s *Service) SetPostFavorite(ctx context.Context, actorID, postID string, role user.Role, active bool) (InteractionResult, error) {
	return s.setPostInteraction(ctx, actorID, postID, role, active, false)
}

func (s *Service) setPostInteraction(ctx context.Context, actorID, postID string, role user.Role, active, like bool) (InteractionResult, error) {
	if !validRole(role) || !validIdentifier(postID) {
		return InteractionResult{}, ErrInvalidInput
	}
	var result InteractionResult
	var found bool
	var err error
	if like {
		result, found, err = s.repo.SetPostLike(ctx, postID, actorID, role, active, s.now())
	} else {
		result, found, err = s.repo.SetPostFavorite(ctx, postID, actorID, active, s.now())
	}
	if err != nil {
		return InteractionResult{}, err
	}
	if !found {
		return InteractionResult{}, ErrNotFound
	}
	return result, nil
}

func (s *Service) AcceptReply(ctx context.Context, actorID, postID, replyID string, role user.Role) (PostDetail, error) {
	if !validRole(role) || !validIdentifier(postID) || !validIdentifier(replyID) {
		return PostDetail{}, ErrInvalidInput
	}
	item, found, allowed, err := s.repo.AcceptReply(ctx, postID, replyID, actorID, role, s.now())
	if err != nil {
		return PostDetail{}, err
	}
	if !found {
		return PostDetail{}, ErrNotFound
	}
	if !allowed {
		return PostDetail{}, ErrForbidden
	}
	return item, nil
}

func (s *Service) SetFeatured(ctx context.Context, actorID, postID string, role user.Role, active bool) (PostDetail, error) {
	if !authCanFeature(role) {
		return PostDetail{}, ErrForbidden
	}
	if !validIdentifier(postID) {
		return PostDetail{}, ErrInvalidInput
	}
	item, found, allowed, err := s.repo.SetFeatured(ctx, postID, actorID, role, active, s.now())
	if err != nil {
		return PostDetail{}, err
	}
	if !found {
		return PostDetail{}, ErrNotFound
	}
	if !allowed {
		return PostDetail{}, ErrForbidden
	}
	return item, nil
}

func (s *Service) CreateReport(ctx context.Context, reporterID, targetType, targetID, reason, detail string, role user.Role) (Report, error) {
	if !validRole(role) {
		return Report{}, ErrForbidden
	}
	targetType = strings.TrimSpace(targetType)
	targetID = strings.TrimSpace(targetID)
	reason = strings.TrimSpace(reason)
	detail = strings.TrimSpace(detail)
	if !validIdentifier(targetID) || !validReportTarget(targetType) || !validReportReason(reason) ||
		utf8.RuneCountInString(detail) > maxReportRunes || !validText(detail) {
		return Report{}, ErrInvalidInput
	}
	id, err := s.newID()
	if err != nil {
		return Report{}, fmt.Errorf("generate forum report id: %w", err)
	}
	item, found, err := s.repo.CreateReport(ctx, id, reporterID, targetType, targetID, reason, detail, s.now())
	if err != nil {
		return Report{}, err
	}
	if !found {
		return Report{}, ErrNotFound
	}
	if item.ID == "" {
		return Report{}, ErrConflict
	}
	return item, nil
}

func (s *Service) ListNotifications(ctx context.Context, userID string, role user.Role, unreadOnly bool, page, pageSize int) (ListNotificationsResponse, error) {
	if !validRole(role) {
		return ListNotificationsResponse{}, ErrForbidden
	}
	if !validPage(page, pageSize) {
		return ListNotificationsResponse{}, ErrInvalidInput
	}
	items, total, unread, err := s.repo.ListNotifications(ctx, userID, unreadOnly, page, pageSize)
	if err != nil {
		return ListNotificationsResponse{}, err
	}
	return ListNotificationsResponse{Items: items, Total: total, Unread: unread, Page: page, PageSize: pageSize}, nil
}

func (s *Service) MarkNotificationRead(ctx context.Context, userID, notificationID string, role user.Role) error {
	if !validRole(role) || !validIdentifier(notificationID) {
		return ErrInvalidInput
	}
	found, err := s.repo.MarkNotificationRead(ctx, notificationID, userID, s.now())
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	return nil
}

func (s *Service) MarkPostNotificationsRead(ctx context.Context, userID, postID string, role user.Role) (int, error) {
	if !validRole(role) || !validIdentifier(postID) {
		return 0, ErrInvalidInput
	}
	return s.repo.MarkPostNotificationsRead(ctx, postID, userID, s.now())
}

func (s *Service) MarkAllNotificationsRead(ctx context.Context, userID string, role user.Role) (int, error) {
	if !validRole(role) {
		return 0, ErrForbidden
	}
	return s.repo.MarkAllNotificationsRead(ctx, userID, s.now())
}

func (s *Service) ListUnreadNotificationPostIDs(ctx context.Context, userID string, role user.Role) ([]string, error) {
	if !validRole(role) {
		return nil, ErrForbidden
	}
	return s.repo.ListUnreadNotificationPostIDs(ctx, userID)
}

func (s *Service) ListReports(ctx context.Context, role user.Role, status string, page, pageSize int) (ListReportsResponse, error) {
	if role != user.RoleAdmin {
		return ListReportsResponse{}, ErrForbidden
	}
	status = strings.TrimSpace(status)
	if status == "" {
		status = "pending"
	}
	if !validReportStatus(status) || !validPage(page, pageSize) {
		return ListReportsResponse{}, ErrInvalidInput
	}
	items, total, err := s.repo.ListReports(ctx, status, page, pageSize)
	if err != nil {
		return ListReportsResponse{}, err
	}
	return ListReportsResponse{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

func (s *Service) ResolveReport(ctx context.Context, actorID string, role user.Role, reportID, status string) (Report, error) {
	if role != user.RoleAdmin {
		return Report{}, ErrForbidden
	}
	status = strings.TrimSpace(status)
	if !validIdentifier(reportID) || (status != "resolved" && status != "dismissed") {
		return Report{}, ErrInvalidInput
	}
	item, found, err := s.repo.ResolveReport(ctx, reportID, actorID, status, s.now())
	if err != nil {
		return Report{}, err
	}
	if !found {
		return Report{}, ErrNotFound
	}
	return item, nil
}

func normalizeCreatePost(input CreatePostInput) (CreatePostInput, error) {
	input.BoardID = strings.TrimSpace(input.BoardID)
	input.BoardSlug = strings.TrimSpace(input.BoardSlug)
	input.Type = PostType(strings.TrimSpace(string(input.Type)))
	if input.BoardID == "" && input.BoardSlug == "" {
		input.BoardSlug = DefaultBoardSlug
	}
	if input.Type == "" {
		input.Type = DefaultPostType
	}
	input.Title = strings.TrimSpace(input.Title)
	input.Content = strings.TrimSpace(input.Content)
	input.KnowledgeNodeID = strings.TrimSpace(input.KnowledgeNodeID)
	attachments, err := messageattachment.Normalize(input.Attachments)
	if err != nil {
		return CreatePostInput{}, ErrInvalidInput
	}
	tags, ok := normalizeTags(input.Tags)
	if !ok ||
		(input.BoardID != "" && !validIdentifier(input.BoardID)) || !validPostType(input.Type) ||
		input.Title == "" || utf8.RuneCountInString(input.Title) > maxTitleRunes ||
		input.Content == "" || utf8.RuneCountInString(input.Content) > maxContentRunes ||
		(input.KnowledgeNodeID != "" && !validIdentifier(input.KnowledgeNodeID)) ||
		!validText(input.BoardSlug, input.Title, input.Content) {
		return CreatePostInput{}, ErrInvalidInput
	}
	input.Attachments = attachments
	input.Tags = tags
	return input, nil
}

func normalizeUpdatePost(input UpdatePostInput) (UpdatePostInput, error) {
	if input.BoardID == nil && input.BoardSlug == nil && input.Type == nil && input.Title == nil && input.Content == nil &&
		input.Attachments == nil && input.Tags == nil && input.KnowledgeNodeID == nil {
		return UpdatePostInput{}, ErrInvalidInput
	}
	if input.BoardID != nil {
		value := strings.TrimSpace(*input.BoardID)
		if !validIdentifier(value) {
			return UpdatePostInput{}, ErrInvalidInput
		}
		input.BoardID = &value
	}
	if input.BoardSlug != nil {
		value := strings.TrimSpace(*input.BoardSlug)
		if value == "" || !validText(value) {
			return UpdatePostInput{}, ErrInvalidInput
		}
		input.BoardSlug = &value
	}
	if input.Type != nil && !validPostType(*input.Type) {
		return UpdatePostInput{}, ErrInvalidInput
	}
	if input.Title != nil {
		value := strings.TrimSpace(*input.Title)
		if value == "" || utf8.RuneCountInString(value) > maxTitleRunes || !validText(value) {
			return UpdatePostInput{}, ErrInvalidInput
		}
		input.Title = &value
	}
	if input.Content != nil {
		value := strings.TrimSpace(*input.Content)
		if value == "" || utf8.RuneCountInString(value) > maxContentRunes || !validText(value) {
			return UpdatePostInput{}, ErrInvalidInput
		}
		input.Content = &value
	}
	if input.Attachments != nil {
		value, err := messageattachment.Normalize(*input.Attachments)
		if err != nil {
			return UpdatePostInput{}, ErrInvalidInput
		}
		input.Attachments = &value
	}
	if input.Tags != nil {
		value, ok := normalizeTags(*input.Tags)
		if !ok {
			return UpdatePostInput{}, ErrInvalidInput
		}
		input.Tags = &value
	}
	if input.KnowledgeNodeID != nil {
		value := strings.TrimSpace(*input.KnowledgeNodeID)
		if value != "" && !validIdentifier(value) {
			return UpdatePostInput{}, ErrInvalidInput
		}
		input.KnowledgeNodeID = &value
	}
	return input, nil
}

func normalizeReply(input CreateReplyInput) (CreateReplyInput, error) {
	input.ParentReplyID = strings.TrimSpace(input.ParentReplyID)
	input.Content = strings.TrimSpace(input.Content)
	attachments, err := messageattachment.Normalize(input.Attachments)
	if err != nil || input.Content == "" || utf8.RuneCountInString(input.Content) > maxReplyRunes ||
		(input.ParentReplyID != "" && !validIdentifier(input.ParentReplyID)) || !validText(input.Content) || len(input.MentionUserIDs) > maxMentions {
		return CreateReplyInput{}, ErrInvalidInput
	}
	mentions := make([]string, 0, len(input.MentionUserIDs))
	seen := make(map[string]struct{}, len(input.MentionUserIDs))
	for _, raw := range input.MentionUserIDs {
		id := strings.TrimSpace(raw)
		if !validIdentifier(id) {
			return CreateReplyInput{}, ErrInvalidInput
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		mentions = append(mentions, id)
	}
	input.Attachments = attachments
	input.MentionUserIDs = mentions
	return input, nil
}

func normalizeUpdateReply(input UpdateReplyInput) (UpdateReplyInput, error) {
	if input.Content == nil && input.Attachments == nil {
		return UpdateReplyInput{}, ErrInvalidInput
	}
	if input.Content != nil {
		value := strings.TrimSpace(*input.Content)
		if value == "" || utf8.RuneCountInString(value) > maxReplyRunes || !validText(value) {
			return UpdateReplyInput{}, ErrInvalidInput
		}
		input.Content = &value
	}
	if input.Attachments != nil {
		value, err := messageattachment.Normalize(*input.Attachments)
		if err != nil {
			return UpdateReplyInput{}, ErrInvalidInput
		}
		input.Attachments = &value
	}
	return input, nil
}

func normalizeTags(values []string) ([]string, bool) {
	if len(values) > maxTags {
		return nil, false
	}
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" || utf8.RuneCountInString(value) > maxTagRunes || !validText(value) {
			return nil, false
		}
		key := strings.ToLower(value)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
	}
	return result, true
}

func validListFilter(filter ListPostsFilter, role user.Role) bool {
	if !validPage(filter.Page, filter.PageSize) || utf8.RuneCountInString(filter.Search) > maxSearchRunes || !validText(filter.Search, filter.BoardSlug) {
		return false
	}
	if filter.Type != "" && !validPostType(filter.Type) {
		return false
	}
	switch filter.Status {
	case "all", "visible", "open", "resolved":
	case "hidden", "deleted":
		if role != user.RoleAdmin {
			return false
		}
	default:
		return false
	}
	switch filter.Sort {
	case "latest", "hot", "featured":
	default:
		return false
	}
	switch filter.Scope {
	case "", "all", "mine", "replied", "favorites":
		return true
	default:
		return false
	}
}

func validPostType(value PostType) bool {
	return value == PostTypeQuestion || value == PostTypeDiscussion || value == PostTypeResource
}

func validRole(role user.Role) bool {
	return role == user.RoleStudent || role == user.RoleTeacher || role == user.RoleAdmin
}

func authCanFeature(role user.Role) bool {
	return role == user.RoleTeacher
}

func validIdentifier(value string) bool {
	return value != "" && utf8.RuneCountInString(value) <= maxIdentifierRunes && validText(value)
}

func validText(values ...string) bool {
	for _, value := range values {
		if !utf8.ValidString(value) || strings.ContainsRune(value, '\x00') {
			return false
		}
	}
	return true
}

func validPage(page, pageSize int) bool {
	return page >= 1 && page <= maxPageNumber && pageSize >= 1 && pageSize <= maxPageSize
}

func validReportTarget(value string) bool {
	return value == "post" || value == "reply"
}

func validReportReason(value string) bool {
	switch value {
	case "spam", "abuse", "answer_leak", "misinformation", "copyright", "other":
		return true
	default:
		return false
	}
}

func validReportStatus(value string) bool {
	return value == "all" || value == "pending" || value == "resolved" || value == "dismissed"
}
