package airisk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"mathstudy/backend/internal/platform/identifier"
	"mathstudy/backend/internal/platform/numutil"
)

const (
	defaultDailyReplyLimit = 50
	defaultMaxConcurrency  = 2
	defaultLeaseTTL        = 10 * time.Minute
	maxBlockedKeywords     = 100
	maxListPage            = 100
)

var modelReviewCategoryOrder = []string{
	"harassment",
	"harassment/threatening",
	"hate",
	"hate/threatening",
	"illicit",
	"illicit/violent",
	"self-harm",
	"self-harm/intent",
	"self-harm/instructions",
	"sexual",
	"sexual/minors",
	"violence",
	"violence/graphic",
}

var shanghaiLocation = time.FixedZone(ResetTimezone, 8*60*60)

// Service implements administrator and runtime AI risk-control use cases.
type Service struct {
	repo     Repository
	slots    SlotStore
	reviewer ContentReviewer
	now      func() time.Time
	newID    func() (string, error)
	leaseTTL time.Duration
}

// Option customizes the AI risk-control service.
type Option func(*Service) error

// WithContentReviewer enables provider-backed model review when the policy switch is on.
func WithContentReviewer(reviewer ContentReviewer) Option {
	return func(service *Service) error {
		if reviewer == nil {
			return errors.New("AI content reviewer is nil")
		}
		service.reviewer = reviewer
		return nil
	}
}

// NewService creates an AI risk-control service.
func NewService(repo Repository, slots SlotStore, options ...Option) (*Service, error) {
	if repo == nil {
		return nil, errors.New("AI risk repository is nil")
	}
	if slots == nil {
		return nil, errors.New("AI risk slot store is nil")
	}
	service := &Service{
		repo:     repo,
		slots:    slots,
		now:      func() time.Time { return time.Now().UTC() },
		newID:    identifier.NewUUID,
		leaseTTL: defaultLeaseTTL,
	}
	for _, option := range options {
		if option == nil {
			continue
		}
		if err := option(service); err != nil {
			return nil, err
		}
	}
	return service, nil
}

// GetSettings returns the uniform student AI limits.
func (s *Service) GetSettings(ctx context.Context) (Settings, error) {
	values, err := s.repo.GetSettings(ctx, []string{
		DailyReplyLimitKey,
		MaxConcurrencyKey,
		BlockedKeywordsKey,
		ModelReviewEnabledKey,
		ModelReviewThresholdsKey,
	})
	if err != nil {
		return Settings{}, fmt.Errorf("get AI risk settings: %w", err)
	}
	settings, err := parseSettings(values)
	if err != nil {
		return Settings{}, err
	}
	return s.withResetMetadata(settings), nil
}

// RecordSuccessfulReply commits one delivered response to the student's daily quota ledger.
func (s *Service) RecordSuccessfulReply(ctx context.Context, studentID string) error {
	access, ok, err := s.repo.GetStudentAccess(ctx, strings.TrimSpace(studentID))
	if err != nil {
		return Error{Kind: ErrUnavailable, Message: "AI 风控服务暂不可用"}
	}
	if !ok || !access.IsStudent {
		return nil
	}
	usageID, err := s.newID()
	if err != nil {
		return Error{Kind: ErrUnavailable, Message: "AI 风控服务暂不可用"}
	}
	now := s.now()
	if err := s.repo.InsertReplyUsage(ctx, ReplyUsage{
		ID: usageID, StudentID: access.StudentID, UsageDate: s.usageDate(now), CreatedAt: now,
	}); err != nil {
		return Error{Kind: ErrUnavailable, Message: "AI 风控服务暂不可用"}
	}
	return nil
}

// UpdateSettings validates and stores the uniform student AI limits.
func (s *Service) UpdateSettings(ctx context.Context, input UpdateSettingsRequest) (Settings, error) {
	settings, err := normalizeSettings(input)
	if err != nil {
		return Settings{}, err
	}
	keywords, err := json.Marshal(settings.BlockedKeywords)
	if err != nil {
		return Settings{}, fmt.Errorf("marshal blocked keywords: %w", err)
	}
	thresholds, err := json.Marshal(settings.ModelReviewThresholds)
	if err != nil {
		return Settings{}, fmt.Errorf("marshal model review thresholds: %w", err)
	}
	now := s.now()
	if err := s.repo.UpsertSettings(ctx, []SettingUpdate{
		{Key: DailyReplyLimitKey, Value: strconv.Itoa(settings.DailyReplyLimit), Description: "每名学生每日可获得的 AI 成功回复数", UpdatedAt: now},
		{Key: MaxConcurrencyKey, Value: strconv.Itoa(settings.MaxConcurrentRequests), Description: "每名学生可同时执行的 AI 请求数", UpdatedAt: now},
		{Key: BlockedKeywordsKey, Value: string(keywords), Description: "学生 AI 请求拦截关键词 JSON 数组", UpdatedAt: now},
		{Key: ModelReviewEnabledKey, Value: strconv.FormatBool(settings.ModelReviewEnabled), Description: "学生 AI 输入模型同步前置审查开关", UpdatedAt: now},
		{Key: ModelReviewThresholdsKey, Value: string(thresholds), Description: "学生 AI 模型审查分类阈值 JSON 对象", UpdatedAt: now},
	}); err != nil {
		return Settings{}, fmt.Errorf("update AI risk settings: %w", err)
	}
	return s.withResetMetadata(settings), nil
}

// GetOverview returns risk-center summary counters.
func (s *Service) GetOverview(ctx context.Context) (Overview, error) {
	settings, err := s.GetSettings(ctx)
	if err != nil {
		return Overview{}, err
	}
	overview, err := s.repo.Overview(ctx, s.usageDate(s.now()), settings.DailyReplyLimit)
	if err != nil {
		return Overview{}, fmt.Errorf("get AI risk overview: %w", err)
	}
	overview.DailyReplyLimit = settings.DailyReplyLimit
	overview.MaxConcurrentRequests = settings.MaxConcurrentRequests
	return overview, nil
}

// ListStudents returns current access and daily reply usage for students.
func (s *Service) ListStudents(ctx context.Context, filter StudentListFilter) (StudentListResponse, error) {
	filter, err := normalizeStudentFilter(filter)
	if err != nil {
		return StudentListResponse{}, err
	}
	settings, err := s.GetSettings(ctx)
	if err != nil {
		return StudentListResponse{}, err
	}
	filter.UsageDate = s.usageDate(s.now())
	filter.DailyLimit = settings.DailyReplyLimit
	items, total, err := s.repo.ListStudents(ctx, filter)
	if err != nil {
		return StudentListResponse{}, fmt.Errorf("list AI risk students: %w", err)
	}
	for index := range items {
		items[index].RepliesRemaining = max(settings.DailyReplyLimit-items[index].RepliesUsed, 0)
		items[index].QuotaExhausted = items[index].RepliesUsed >= settings.DailyReplyLimit
	}
	return StudentListResponse{
		Items:      items,
		Total:      total,
		Page:       filter.Page,
		PageSize:   filter.PageSize,
		TotalPages: min(numutil.TotalPages(total, filter.PageSize), maxListPage),
	}, nil
}

// UpdateStudentAccess blocks or unblocks one student's AI access only.
func (s *Service) UpdateStudentAccess(ctx context.Context, studentID, actorID string, input UpdateStudentAccessRequest) (StudentAccessResponse, error) {
	studentID = strings.TrimSpace(studentID)
	actorID = strings.TrimSpace(actorID)
	input.Reason = strings.TrimSpace(input.Reason)
	if studentID == "" || len(studentID) > 36 {
		return StudentAccessResponse{}, badRequest("学生 ID 无效")
	}
	if actorID == "" || len(actorID) > 36 {
		return StudentAccessResponse{}, badRequest("管理员 ID 无效")
	}
	if input.Blocked && input.Reason == "" {
		return StudentAccessResponse{}, badRequest("封禁原因不能为空")
	}
	if utf8.RuneCountInString(input.Reason) > 500 {
		return StudentAccessResponse{}, badRequest("封禁原因不能超过 500 个字符")
	}
	eventID, err := s.newID()
	if err != nil {
		return StudentAccessResponse{}, fmt.Errorf("create AI access event ID: %w", err)
	}
	now := s.now()
	response, ok, err := s.repo.SetStudentAccess(ctx, StudentAccessMutation{
		EventID:   eventID,
		StudentID: studentID,
		ActorID:   actorID,
		Blocked:   input.Blocked,
		Reason:    input.Reason,
		EventDate: s.usageDate(now),
		Now:       now,
	})
	if err != nil {
		return StudentAccessResponse{}, fmt.Errorf("update student AI access: %w", err)
	}
	if !ok {
		return StudentAccessResponse{}, Error{Kind: ErrNotFound, Message: "学生不存在"}
	}
	return response, nil
}

// ListRiskEvents returns content and administrator action events.
func (s *Service) ListRiskEvents(ctx context.Context, filter EventListFilter) (EventListResponse, error) {
	filter, err := normalizeEventFilter(filter)
	if err != nil {
		return EventListResponse{}, err
	}
	items, total, err := s.repo.ListRiskEvents(ctx, filter)
	if err != nil {
		return EventListResponse{}, fmt.Errorf("list AI risk events: %w", err)
	}
	return EventListResponse{
		Items:      items,
		Total:      total,
		Page:       filter.Page,
		PageSize:   filter.PageSize,
		TotalPages: min(numutil.TotalPages(total, filter.PageSize), maxListPage),
	}, nil
}

func (s *Service) withResetMetadata(settings Settings) Settings {
	now := s.now().In(shanghaiLocation)
	next := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, shanghaiLocation)
	settings.ResetTimezone = ResetTimezone
	settings.NextResetAt = next.Format(time.RFC3339)
	return settings
}

func (s *Service) usageDate(now time.Time) string {
	return UsageDate(now)
}

// UsageDate returns the quota day in the platform's fixed Asia/Shanghai timezone.
func UsageDate(now time.Time) string {
	return now.In(shanghaiLocation).Format("2006-01-02")
}

func parseSettings(values map[string]string) (Settings, error) {
	settings := Settings{
		DailyReplyLimit:       defaultDailyReplyLimit,
		MaxConcurrentRequests: defaultMaxConcurrency,
		BlockedKeywords:       []string{},
		ModelReviewThresholds: defaultModelReviewThresholds(),
	}
	if raw, ok := values[DailyReplyLimitKey]; ok {
		value, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil {
			return Settings{}, fmt.Errorf("parse %s: %w", DailyReplyLimitKey, err)
		}
		settings.DailyReplyLimit = value
	}
	if raw, ok := values[MaxConcurrencyKey]; ok {
		value, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil {
			return Settings{}, fmt.Errorf("parse %s: %w", MaxConcurrencyKey, err)
		}
		settings.MaxConcurrentRequests = value
	}
	if raw, ok := values[BlockedKeywordsKey]; ok && strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &settings.BlockedKeywords); err != nil {
			return Settings{}, fmt.Errorf("parse %s: %w", BlockedKeywordsKey, err)
		}
	}
	if raw, ok := values[ModelReviewEnabledKey]; ok && strings.TrimSpace(raw) != "" {
		value, err := strconv.ParseBool(strings.TrimSpace(raw))
		if err != nil {
			return Settings{}, fmt.Errorf("parse %s: %w", ModelReviewEnabledKey, err)
		}
		settings.ModelReviewEnabled = value
	}
	if raw, ok := values[ModelReviewThresholdsKey]; ok && strings.TrimSpace(raw) != "" {
		var thresholds map[string]float64
		if err := json.Unmarshal([]byte(raw), &thresholds); err != nil {
			return Settings{}, fmt.Errorf("parse %s: %w", ModelReviewThresholdsKey, err)
		}
		settings.ModelReviewThresholds = thresholds
	}
	return normalizeSettings(UpdateSettingsRequest{
		DailyReplyLimit:       settings.DailyReplyLimit,
		MaxConcurrentRequests: settings.MaxConcurrentRequests,
		BlockedKeywords:       settings.BlockedKeywords,
		ModelReviewEnabled:    settings.ModelReviewEnabled,
		ModelReviewThresholds: settings.ModelReviewThresholds,
	})
}

func normalizeSettings(input UpdateSettingsRequest) (Settings, error) {
	if input.DailyReplyLimit < 1 || input.DailyReplyLimit > 10_000 {
		return Settings{}, badRequest("每日回复额度必须在 1 到 10000 之间")
	}
	if input.MaxConcurrentRequests < 1 || input.MaxConcurrentRequests > 20 {
		return Settings{}, badRequest("每生并发上限必须在 1 到 20 之间")
	}
	if len(input.BlockedKeywords) > maxBlockedKeywords {
		return Settings{}, badRequest("风险关键词不能超过 100 个")
	}
	keywords := make([]string, 0, len(input.BlockedKeywords))
	seen := map[string]struct{}{}
	for _, keyword := range input.BlockedKeywords {
		keyword = strings.TrimSpace(keyword)
		if keyword == "" {
			continue
		}
		if utf8.RuneCountInString(keyword) > 64 {
			return Settings{}, badRequest("单个风险关键词不能超过 64 个字符")
		}
		key := strings.ToLower(keyword)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		keywords = append(keywords, keyword)
	}
	thresholds, err := normalizeModelReviewThresholds(input.ModelReviewThresholds)
	if err != nil {
		return Settings{}, err
	}
	return Settings{
		DailyReplyLimit:       input.DailyReplyLimit,
		MaxConcurrentRequests: input.MaxConcurrentRequests,
		BlockedKeywords:       keywords,
		ModelReviewEnabled:    input.ModelReviewEnabled,
		ModelReviewThresholds: thresholds,
	}, nil
}

func defaultModelReviewThresholds() map[string]float64 {
	return map[string]float64{
		"harassment":             0.98,
		"harassment/threatening": 0.90,
		"hate":                   0.65,
		"hate/threatening":       0.65,
		"illicit":                0.95,
		"illicit/violent":        0.95,
		"self-harm":              0.65,
		"self-harm/intent":       0.85,
		"self-harm/instructions": 0.65,
		"sexual":                 0.65,
		"sexual/minors":          0.65,
		"violence":               0.95,
		"violence/graphic":       0.95,
	}
}

func normalizeModelReviewThresholds(input map[string]float64) (map[string]float64, error) {
	thresholds := defaultModelReviewThresholds()
	for category, value := range input {
		if _, ok := thresholds[category]; !ok {
			return nil, badRequest("不支持的模型审查分类: " + category)
		}
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1 {
			return nil, badRequest("模型审查阈值必须在 0 到 1 之间")
		}
		thresholds[category] = value
	}
	return thresholds, nil
}

func normalizeStudentFilter(filter StudentListFilter) (StudentListFilter, error) {
	if filter.Page == 0 {
		filter.Page = 1
	}
	if filter.PageSize == 0 {
		filter.PageSize = 20
	}
	if filter.Page < 1 || filter.Page > maxListPage || filter.PageSize < 1 || filter.PageSize > 100 {
		return StudentListFilter{}, badRequest("分页参数超出范围")
	}
	filter.Search = strings.TrimSpace(filter.Search)
	filter.Status = strings.ToLower(strings.TrimSpace(filter.Status))
	if filter.Status == "all" {
		filter.Status = ""
	}
	switch filter.Status {
	case "", "active", "blocked", "quota_exhausted":
	default:
		return StudentListFilter{}, badRequest("status 参数无效")
	}
	return filter, nil
}

func normalizeEventFilter(filter EventListFilter) (EventListFilter, error) {
	if filter.Page == 0 {
		filter.Page = 1
	}
	if filter.PageSize == 0 {
		filter.PageSize = 20
	}
	if filter.Page < 1 || filter.Page > maxListPage || filter.PageSize < 1 || filter.PageSize > 100 {
		return EventListFilter{}, badRequest("分页参数超出范围")
	}
	filter.Search = strings.TrimSpace(filter.Search)
	filter.EventType = strings.ToLower(strings.TrimSpace(filter.EventType))
	if filter.EventType == "all" {
		filter.EventType = ""
	}
	switch filter.EventType {
	case "", "content_blocked", "model_blocked", "model_review_error", "admin_blocked", "admin_unblocked":
	default:
		return EventListFilter{}, badRequest("event_type 参数无效")
	}
	return filter, nil
}

func badRequest(message string) error {
	return Error{Kind: ErrBadRequest, Message: message}
}

type distributedLease struct {
	store     SlotStore
	studentID string
	leaseID   string
	once      sync.Once
	err       error
}

func (l *distributedLease) Release(ctx context.Context) error {
	if l == nil {
		return nil
	}
	l.once.Do(func() { l.err = l.store.Release(ctx, l.studentID, l.leaseID) })
	return l.err
}

type noopLease struct{}

func (noopLease) Release(context.Context) error { return nil }
