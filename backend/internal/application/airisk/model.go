package airisk

import (
	"context"
	"errors"
	"time"
)

const (
	DailyReplyLimitKey       = "student_ai_daily_reply_limit"
	MaxConcurrencyKey        = "student_ai_max_concurrency"
	BlockedKeywordsKey       = "student_ai_blocked_keywords"
	ModelReviewEnabledKey    = "student_ai_model_review_enabled"
	ModelReviewThresholdsKey = "student_ai_model_review_thresholds"
	ResetTimezone            = "Asia/Shanghai"
)

var (
	ErrBadRequest          = errors.New("bad AI risk request")
	ErrNotFound            = errors.New("AI risk resource not found")
	ErrAccessBlocked       = errors.New("student AI access blocked")
	ErrContentBlocked      = errors.New("student AI content blocked")
	ErrQuotaExceeded       = errors.New("student AI daily quota exceeded")
	ErrConcurrencyExceeded = errors.New("student AI concurrency exceeded")
	ErrUnavailable         = errors.New("student AI guard unavailable")
)

// Error adds a stable public message to a domain error.
type Error struct {
	Kind    error
	Message string
}

func (e Error) Error() string { return e.Message }

func (e Error) Unwrap() error { return e.Kind }

// Settings applies uniformly to every student.
type Settings struct {
	DailyReplyLimit       int                `json:"daily_reply_limit"`
	MaxConcurrentRequests int                `json:"max_concurrent_requests"`
	BlockedKeywords       []string           `json:"blocked_keywords"`
	ModelReviewEnabled    bool               `json:"model_review_enabled"`
	ModelReviewThresholds map[string]float64 `json:"model_review_thresholds"`
	ResetTimezone         string             `json:"reset_timezone"`
	NextResetAt           string             `json:"next_reset_at"`
}

// UpdateSettingsRequest stores mutable risk-control settings.
type UpdateSettingsRequest struct {
	DailyReplyLimit       int                `json:"daily_reply_limit"`
	MaxConcurrentRequests int                `json:"max_concurrent_requests"`
	BlockedKeywords       []string           `json:"blocked_keywords"`
	ModelReviewEnabled    bool               `json:"model_review_enabled"`
	ModelReviewThresholds map[string]float64 `json:"model_review_thresholds"`
}

// SettingUpdate is one system setting mutation.
type SettingUpdate struct {
	Key         string
	Value       string
	Description string
	UpdatedAt   time.Time
}

// StudentAccess is the runtime access record loaded before an AI request.
type StudentAccess struct {
	StudentID     string
	Username      string
	IsStudent     bool
	IsBlocked     bool
	BlockedReason string
	BlockedAt     *time.Time
}

// Overview summarizes the current risk center.
type Overview struct {
	TotalStudents          int `json:"total_students"`
	BlockedStudents        int `json:"blocked_students"`
	QuotaExhaustedStudents int `json:"quota_exhausted_students"`
	RepliesToday           int `json:"replies_today"`
	RiskEventsToday        int `json:"risk_events_today"`
	DailyReplyLimit        int `json:"daily_reply_limit"`
	MaxConcurrentRequests  int `json:"max_concurrent_requests"`
}

// StudentItem is one student row in the risk center.
type StudentItem struct {
	ID               string     `json:"id"`
	Username         string     `json:"username"`
	Email            string     `json:"email"`
	DisplayName      *string    `json:"display_name"`
	AIBlocked        bool       `json:"ai_blocked"`
	BlockedReason    string     `json:"blocked_reason"`
	BlockedAt        *time.Time `json:"blocked_at"`
	RepliesUsed      int        `json:"replies_used"`
	RepliesRemaining int        `json:"replies_remaining"`
	QuotaExhausted   bool       `json:"quota_exhausted"`
	LastAIReplyAt    *time.Time `json:"last_ai_reply_at"`
}

// StudentListFilter stores student table filters.
type StudentListFilter struct {
	Page       int
	PageSize   int
	Search     string
	Status     string
	UsageDate  string
	DailyLimit int
}

// StudentListResponse wraps a paginated student list.
type StudentListResponse struct {
	Items      []StudentItem `json:"items"`
	Total      int           `json:"total"`
	Page       int           `json:"page"`
	PageSize   int           `json:"page_size"`
	TotalPages int           `json:"total_pages"`
}

// UpdateStudentAccessRequest toggles one student's AI-only access.
type UpdateStudentAccessRequest struct {
	Blocked bool   `json:"blocked"`
	Reason  string `json:"reason"`
}

// StudentAccessResponse returns the updated AI-only access state.
type StudentAccessResponse struct {
	StudentID     string     `json:"student_id"`
	AIBlocked     bool       `json:"ai_blocked"`
	BlockedReason string     `json:"blocked_reason"`
	BlockedAt     *time.Time `json:"blocked_at"`
}

// StudentAccessMutation carries a validated access update into persistence.
type StudentAccessMutation struct {
	EventID   string
	StudentID string
	ActorID   string
	Blocked   bool
	Reason    string
	EventDate string
	Now       time.Time
}

// RiskEvent stores one content or administrator action event.
type RiskEvent struct {
	ID              string             `json:"id"`
	StudentID       *string            `json:"student_id"`
	StudentUsername string             `json:"student_username"`
	EventType       string             `json:"event_type"`
	Severity        string             `json:"severity"`
	Action          string             `json:"action"`
	Source          string             `json:"source"`
	MatchedRule     string             `json:"matched_rule"`
	ContentExcerpt  string             `json:"content_excerpt"`
	ContentHash     string             `json:"-"`
	ReviewModel     string             `json:"review_model"`
	RiskScore       *float64           `json:"risk_score"`
	CategoryScores  map[string]float64 `json:"category_scores"`
	ReviewLatencyMS *int               `json:"review_latency_ms"`
	ActorID         *string            `json:"actor_id"`
	EventDate       string             `json:"-"`
	CreatedAt       time.Time          `json:"created_at"`
}

// EventListFilter stores risk event filters.
type EventListFilter struct {
	Page      int
	PageSize  int
	Search    string
	EventType string
}

// EventListResponse wraps paginated risk events.
type EventListResponse struct {
	Items      []RiskEvent `json:"items"`
	Total      int         `json:"total"`
	Page       int         `json:"page"`
	PageSize   int         `json:"page_size"`
	TotalPages int         `json:"total_pages"`
}

// SlotDecision explains whether a distributed lease was acquired.
type SlotDecision struct {
	Allowed bool
	Reason  string
}

// SlotStore owns distributed per-student AI leases.
type SlotStore interface {
	Acquire(context.Context, string, string, int, int, int, time.Duration) (SlotDecision, error)
	Release(context.Context, string, string) error
}

// Lease releases one acquired AI concurrency slot.
type Lease interface {
	Release(context.Context) error
}

// ReplyUsage records one delivered AI response against a student's daily quota.
type ReplyUsage struct {
	ID        string
	StudentID string
	UsageDate string
	CreatedAt time.Time
}

// ModelReviewResult is the normalized result returned by a moderation provider.
type ModelReviewResult struct {
	Model          string
	CategoryScores map[string]float64
}

// ContentReviewer evaluates student input before the protected AI request runs.
type ContentReviewer interface {
	Review(context.Context, string) (ModelReviewResult, error)
}

// Repository is the persistence surface required by AI risk control.
type Repository interface {
	GetSettings(context.Context, []string) (map[string]string, error)
	UpsertSettings(context.Context, []SettingUpdate) error
	GetStudentAccess(context.Context, string) (StudentAccess, bool, error)
	CountReplies(context.Context, string, string) (int, error)
	InsertReplyUsage(context.Context, ReplyUsage) error
	Overview(context.Context, string, int) (Overview, error)
	ListStudents(context.Context, StudentListFilter) ([]StudentItem, int, error)
	SetStudentAccess(context.Context, StudentAccessMutation) (StudentAccessResponse, bool, error)
	InsertRiskEvent(context.Context, RiskEvent) error
	ListRiskEvents(context.Context, EventListFilter) ([]RiskEvent, int, error)
}
