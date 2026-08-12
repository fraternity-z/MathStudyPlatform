package securitylog

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"mathstudy/backend/internal/platform/csvsafe"
	"mathstudy/backend/internal/platform/ptrutil"
	"mathstudy/backend/internal/platform/redact"
	"mathstudy/backend/internal/platform/timefmt"
)

var (
	// ErrBadRequest is returned when input cannot be applied.
	ErrBadRequest = errors.New("bad security log request")
)

// Error wraps a domain error with a Python-compatible message.
type Error struct {
	Kind    error
	Message string
}

func (e Error) Error() string {
	return e.Message
}

func (e Error) Unwrap() error {
	return e.Kind
}

// EventType is a security event category.
type EventType string

const (
	EventLoginFailed      EventType = "login_failed"
	EventLoginAnomaly     EventType = "login_anomaly"
	EventRequestError     EventType = "request_error"
	EventRequestBlocked   EventType = "request_blocked"
	EventServiceError     EventType = "service_error"
	EventServiceRecovered EventType = "service_recovered"
	EventDailyReport      EventType = "daily_report"
	EventConfigChanged    EventType = "config_changed"
)

// Severity is a security event severity.
type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityWarning  Severity = "warning"
	SeverityError    Severity = "error"
	SeverityCritical Severity = "critical"
)

var eventDisplay = map[EventType]string{
	EventLoginFailed:      "登录失败",
	EventLoginAnomaly:     "异常登录",
	EventRequestError:     "请求异常",
	EventRequestBlocked:   "请求拦截",
	EventServiceError:     "服务异常",
	EventServiceRecovered: "服务恢复",
	EventDailyReport:      "每日报告",
	EventConfigChanged:    "配置变更",
}

// Repository is the persistence surface required by security log management.
type Repository interface {
	ListLogs(context.Context, QueryFilter) ([]LogItem, int, error)
	Stats(context.Context) (StatsResponse, error)
	DeleteLogs(context.Context, DeleteRequest) (int, error)
	ExportLogs(context.Context, ExportRequest) ([]LogItem, error)
	ArchiveLogs(context.Context, time.Time) (int, error)
	DailyReportStatus(context.Context, time.Time, time.Time) (bool, int, error)
	CreateLog(context.Context, CreateLog) (LogItem, error)
	AutoArchive(context.Context, time.Time, int) (int, error)
	AutoDelete(context.Context, time.Time, int) (int, error)
	Volume(context.Context) (VolumeResponse, error)
}

// CleanupConfig stores log cleanup settings.
type CleanupConfig struct {
	ArchiveAfterDays int
	DeleteAfterDays  int
	BatchSize        int
	MaxBatches       int
	MaxLogCount      int
}

// LogItem mirrors one security log response item.
type LogItem struct {
	ID          string         `json:"id"`
	EventType   EventType      `json:"event_type"`
	Severity    Severity       `json:"severity"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	IPAddress   *string        `json:"ip_address"`
	UserID      *string        `json:"user_id"`
	Username    *string        `json:"username"`
	ExtraData   map[string]any `json:"extra_data"`
	Archived    bool           `json:"archived"`
	CreatedAt   time.Time      `json:"created_at"`
}

// LogGroup stores logs grouped by date.
type LogGroup struct {
	Date        string    `json:"date"`
	DateDisplay string    `json:"date_display"`
	Logs        []LogItem `json:"logs"`
	Count       int       `json:"count"`
}

// ListResponse mirrors /admin/security-logs.
type ListResponse struct {
	Groups  []LogGroup `json:"groups"`
	Total   int        `json:"total"`
	HasMore bool       `json:"has_more"`
}

// QueryFilter stores list filters.
type QueryFilter struct {
	EventTypes      []EventType
	Severities      []Severity
	StartDate       *time.Time
	EndDate         *time.Time
	IncludeArchived bool
	Page            int
	PageSize        int
}

// StatsResponse mirrors /admin/security-logs/stats.
type StatsResponse struct {
	TotalCount        int        `json:"total_count"`
	ErrorCount        int        `json:"error_count"`
	WarningCount      int        `json:"warning_count"`
	InfoCount         int        `json:"info_count"`
	LastErrorAt       *time.Time `json:"last_error_at"`
	LastDailyReportAt *time.Time `json:"last_daily_report_at"`
}

// DeleteRequest mirrors security log delete filters.
type DeleteRequest struct {
	LogIDs     []string   `json:"log_ids"`
	BeforeDate *time.Time `json:"before_date"`
	DeleteAll  bool       `json:"delete_all"`
}

// ExportRequest mirrors security log export filters.
type ExportRequest struct {
	Format          string      `json:"format"`
	EventTypes      []EventType `json:"event_types"`
	Severities      []Severity  `json:"severities"`
	StartDate       *time.Time  `json:"start_date"`
	EndDate         *time.Time  `json:"end_date"`
	IncludeArchived bool        `json:"include_archived"`
}

// ExportResponse mirrors /admin/security-logs/export.
type ExportResponse struct {
	Filename    string `json:"filename"`
	Content     string `json:"content"`
	ContentType string `json:"content_type"`
	RecordCount int    `json:"record_count"`
}

// ArchiveRequest mirrors /admin/security-logs/archive.
type ArchiveRequest struct {
	BeforeDate time.Time `json:"before_date"`
}

// ArchiveResponse mirrors /admin/security-logs/archive.
type ArchiveResponse struct {
	ArchivedCount int `json:"archived_count"`
}

// CreateLog stores one new security log.
type CreateLog struct {
	EventType   EventType
	Severity    Severity
	Title       string
	Description string
	ExtraData   map[string]any
	CreatedAt   time.Time
}

// DailyReportResponse mirrors /admin/security-logs/generate-daily-report.
type DailyReportResponse struct {
	Generated bool    `json:"generated"`
	ReportID  *string `json:"report_id,omitempty"`
	Message   *string `json:"message,omitempty"`
}

// VolumeResponse mirrors /admin/security-logs/volume.
type VolumeResponse struct {
	ActiveCount   int  `json:"active_count"`
	ArchivedCount int  `json:"archived_count"`
	Total         int  `json:"total"`
	MaxAllowed    int  `json:"max_allowed"`
	Exceeded      bool `json:"exceeded"`
}

// CleanupResponse mirrors /admin/security-logs/cleanup.
type CleanupResponse struct {
	ArchivedCount int            `json:"archived_count"`
	DeletedCount  int            `json:"deleted_count"`
	Volume        VolumeResponse `json:"volume"`
	CleanupAt     string         `json:"cleanup_at"`
}

// Service implements security log management use cases.
type Service struct {
	repo   Repository
	config CleanupConfig
	now    func() time.Time
}

// NewService creates a security log service.
func NewService(repo Repository, config CleanupConfig) (*Service, error) {
	if repo == nil {
		return nil, errors.New("security log repository is nil")
	}
	config = normalizeCleanupConfig(config)
	return &Service{
		repo:   repo,
		config: config,
		now:    func() time.Time { return time.Now().UTC() },
	}, nil
}

// ListLogs returns grouped security logs.
func (s *Service) ListLogs(ctx context.Context, filter QueryFilter) (ListResponse, error) {
	normalized, err := normalizeQueryFilter(filter)
	if err != nil {
		return ListResponse{}, err
	}
	logs, total, err := s.repo.ListLogs(ctx, normalized)
	if err != nil {
		return ListResponse{}, err
	}
	offset := (normalized.Page - 1) * normalized.PageSize
	return ListResponse{
		Groups:  s.groupLogsByDate(logs),
		Total:   total,
		HasMore: offset+len(logs) < total,
	}, nil
}

// Stats returns security log counters.
func (s *Service) Stats(ctx context.Context) (StatsResponse, error) {
	return s.repo.Stats(ctx)
}

// DeleteLogs removes logs and returns the deleted count.
func (s *Service) DeleteLogs(ctx context.Context, request DeleteRequest) (map[string]int, error) {
	deleted, err := s.repo.DeleteLogs(ctx, request)
	if err != nil {
		return nil, err
	}
	return map[string]int{"deleted_count": deleted}, nil
}

// ExportLogs exports filtered logs as Base64-encoded JSON or CSV.
func (s *Service) ExportLogs(ctx context.Context, request ExportRequest) (ExportResponse, error) {
	normalized, err := normalizeExportRequest(request)
	if err != nil {
		return ExportResponse{}, err
	}
	logs, err := s.repo.ExportLogs(ctx, normalized)
	if err != nil {
		return ExportResponse{}, err
	}
	timestamp := s.now().Format("20060102_150405")
	var content string
	var contentType string
	var filename string
	if normalized.Format == "csv" {
		content = exportCSV(logs)
		contentType = "text/csv"
		filename = "security_logs_" + timestamp + ".csv"
	} else {
		data, err := json.MarshalIndent(exportJSONRows(logs), "", "  ")
		if err != nil {
			return ExportResponse{}, err
		}
		content = string(data)
		contentType = "application/json"
		filename = "security_logs_" + timestamp + ".json"
	}
	return ExportResponse{
		Filename:    filename,
		Content:     base64.StdEncoding.EncodeToString([]byte(content)),
		ContentType: contentType,
		RecordCount: len(logs),
	}, nil
}

// ArchiveLogs marks logs before a cutoff as archived.
func (s *Service) ArchiveLogs(ctx context.Context, before time.Time) (ArchiveResponse, error) {
	if before.IsZero() {
		return ArchiveResponse{}, badRequest("before_date 不能为空")
	}
	count, err := s.repo.ArchiveLogs(ctx, before)
	if err != nil {
		return ArchiveResponse{}, err
	}
	return ArchiveResponse{ArchivedCount: count}, nil
}

// GenerateDailyReport creates a daily safe report when no abnormal events exist.
func (s *Service) GenerateDailyReport(ctx context.Context) (DailyReportResponse, error) {
	todayStart := timefmt.StartOfDay(s.now())
	todayEnd := todayStart.AddDate(0, 0, 1)
	hasReport, abnormalCount, err := s.repo.DailyReportStatus(ctx, todayStart, todayEnd)
	if err != nil {
		return DailyReportResponse{}, err
	}
	if hasReport || abnormalCount > 0 {
		message := "今日已有报告或存在异常事件"
		return DailyReportResponse{Generated: false, Message: &message}, nil
	}
	report, err := s.repo.CreateLog(ctx, CreateLog{
		EventType:   EventDailyReport,
		Severity:    SeverityInfo,
		Title:       "每日安全报告",
		Description: "系统运行正常，未检测到安全异常",
		ExtraData:   map[string]any{"date": timefmt.Date(todayStart)},
		CreatedAt:   s.now(),
	})
	if err != nil {
		return DailyReportResponse{}, err
	}
	return DailyReportResponse{Generated: true, ReportID: &report.ID}, nil
}

// Cleanup runs archive, delete, and volume checks.
func (s *Service) Cleanup(ctx context.Context) (CleanupResponse, error) {
	now := s.now()
	archived, err := runCleanupBatches(
		ctx,
		s.config.BatchSize,
		s.config.MaxBatches,
		func(ctx context.Context) (int, error) {
			return s.repo.AutoArchive(ctx, now.AddDate(0, 0, -s.config.ArchiveAfterDays), s.config.BatchSize)
		},
	)
	if err != nil {
		return CleanupResponse{}, err
	}
	deleted, err := runCleanupBatches(
		ctx,
		s.config.BatchSize,
		s.config.MaxBatches,
		func(ctx context.Context) (int, error) {
			return s.repo.AutoDelete(ctx, now.AddDate(0, 0, -s.config.DeleteAfterDays), s.config.BatchSize)
		},
	)
	if err != nil {
		return CleanupResponse{}, err
	}
	volume, err := s.Volume(ctx)
	if err != nil {
		return CleanupResponse{}, err
	}
	return CleanupResponse{
		ArchivedCount: archived,
		DeletedCount:  deleted,
		Volume:        volume,
		CleanupAt:     now.Format(time.RFC3339),
	}, nil
}

func runCleanupBatches(
	ctx context.Context,
	batchSize int,
	maxBatches int,
	run func(context.Context) (int, error),
) (int, error) {
	total := 0
	for batch := 0; batch < maxBatches && ctx.Err() == nil; batch++ {
		count, err := run(ctx)
		total += count
		if err != nil {
			return total, err
		}
		if count < batchSize {
			return total, nil
		}
	}
	if err := ctx.Err(); err != nil {
		return total, err
	}
	return total, nil
}

// Volume returns active/archive security log counts.
func (s *Service) Volume(ctx context.Context) (VolumeResponse, error) {
	volume, err := s.repo.Volume(ctx)
	if err != nil {
		return VolumeResponse{}, err
	}
	volume.MaxAllowed = s.config.MaxLogCount
	volume.Total = volume.ActiveCount + volume.ArchivedCount
	volume.Exceeded = volume.Total > volume.MaxAllowed
	return volume, nil
}

func normalizeQueryFilter(filter QueryFilter) (QueryFilter, error) {
	if filter.Page == 0 {
		filter.Page = 1
	}
	if filter.PageSize == 0 {
		filter.PageSize = 50
	}
	if filter.Page < 1 {
		return QueryFilter{}, badRequest("page 必须大于等于 1")
	}
	if filter.PageSize < 1 || filter.PageSize > 100 {
		return QueryFilter{}, badRequest("page_size 必须在 1 到 100 之间")
	}
	if err := validateEventTypes(filter.EventTypes); err != nil {
		return QueryFilter{}, err
	}
	if err := validateSeverities(filter.Severities); err != nil {
		return QueryFilter{}, err
	}
	return filter, nil
}

func normalizeExportRequest(request ExportRequest) (ExportRequest, error) {
	request.Format = strings.ToLower(strings.TrimSpace(request.Format))
	if request.Format == "" {
		request.Format = "json"
	}
	if request.Format != "json" && request.Format != "csv" {
		return ExportRequest{}, badRequest("format 必须是 json 或 csv")
	}
	if err := validateEventTypes(request.EventTypes); err != nil {
		return ExportRequest{}, err
	}
	if err := validateSeverities(request.Severities); err != nil {
		return ExportRequest{}, err
	}
	return request, nil
}

func validateEventTypes(values []EventType) error {
	for _, value := range values {
		switch value {
		case EventLoginFailed, EventLoginAnomaly, EventRequestError, EventRequestBlocked, EventServiceError, EventServiceRecovered, EventDailyReport, EventConfigChanged:
		default:
			return badRequest("event_types 包含无效事件类型")
		}
	}
	return nil
}

func validateSeverities(values []Severity) error {
	for _, value := range values {
		switch value {
		case SeverityInfo, SeverityWarning, SeverityError, SeverityCritical:
		default:
			return badRequest("severities 包含无效严重程度")
		}
	}
	return nil
}

func normalizeCleanupConfig(config CleanupConfig) CleanupConfig {
	if config.ArchiveAfterDays <= 0 {
		config.ArchiveAfterDays = 30
	}
	if config.DeleteAfterDays <= 0 {
		config.DeleteAfterDays = 90
	}
	if config.DeleteAfterDays < config.ArchiveAfterDays {
		config.DeleteAfterDays = config.ArchiveAfterDays
	}
	if config.BatchSize <= 0 {
		config.BatchSize = 500
	}
	if config.MaxBatches <= 0 {
		config.MaxBatches = 10
	}
	if config.MaxLogCount <= 0 {
		config.MaxLogCount = 100000
	}
	return config
}

func (s *Service) groupLogsByDate(logs []LogItem) []LogGroup {
	today := timefmt.StartOfDay(s.now())
	yesterday := today.AddDate(0, 0, -1)
	groups := make([]LogGroup, 0)
	indexByDate := map[string]int{}
	for _, log := range logs {
		date := timefmt.Date(timefmt.StartOfDay(log.CreatedAt))
		groupIndex, ok := indexByDate[date]
		if !ok {
			display := date
			logDate := timefmt.StartOfDay(log.CreatedAt)
			if logDate.Equal(today) {
				display = "今天"
			} else if logDate.Equal(yesterday) {
				display = "昨天"
			}
			groups = append(groups, LogGroup{Date: date, DateDisplay: display})
			groupIndex = len(groups) - 1
			indexByDate[date] = groupIndex
		}
		groups[groupIndex].Logs = append(groups[groupIndex].Logs, log)
		groups[groupIndex].Count++
	}
	return groups
}

func exportJSONRows(logs []LogItem) []map[string]any {
	rows := make([]map[string]any, 0, len(logs))
	for _, log := range logs {
		rows = append(rows, map[string]any{
			"id":                 log.ID,
			"event_type":         log.EventType,
			"event_type_display": eventDisplay[log.EventType],
			"severity":           log.Severity,
			"title":              redact.String(log.Title),
			"description":        redact.String(log.Description),
			"ip_address":         redactedPointer(log.IPAddress),
			"user_id":            log.UserID,
			"username":           redactedStringPointer(log.Username),
			"extra_data":         redact.Value("extra_data", log.ExtraData),
			"archived":           log.Archived,
			"created_at":         log.CreatedAt.Format(time.RFC3339),
		})
	}
	return rows
}

func exportCSV(logs []LogItem) string {
	var buffer bytes.Buffer
	writer := csv.NewWriter(&buffer)
	_ = writer.Write([]string{"ID", "事件类型", "严重程度", "标题", "描述", "IP 地址", "用户 ID", "用户名", "创建时间", "已归档"})
	for _, log := range logs {
		_ = writer.Write(csvsafe.Row(
			log.ID,
			eventDisplay[log.EventType],
			string(log.Severity),
			redact.String(log.Title),
			redact.String(log.Description),
			redactedFieldString(log.IPAddress),
			ptrutil.ValueOrZero(log.UserID),
			redactedString(log.Username),
			log.CreatedAt.Format(time.RFC3339),
			yesNo(log.Archived),
		))
	}
	writer.Flush()
	return buffer.String()
}

func redactedPointer(value *string) *string {
	if value == nil {
		return nil
	}
	redacted := redact.Marker
	return &redacted
}

func redactedStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	redacted := redact.String(*value)
	return &redacted
}

func redactedString(value *string) string {
	if value == nil {
		return ""
	}
	return redact.String(*value)
}

func redactedFieldString(value *string) string {
	if value == nil {
		return ""
	}
	return redact.Marker
}

func yesNo(value bool) string {
	if value {
		return "是"
	}
	return "否"
}

func badRequest(message string) error {
	return Error{Kind: ErrBadRequest, Message: message}
}
