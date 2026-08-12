package adminsettings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	allowStudentRegistration = "allow_student_registration"
	allowTeacherRegistration = "allow_teacher_registration"
	systemNameKey            = "system_name"
	systemDescriptionKey     = "system_description"

	maxImportTableCount   = 32
	maxImportRowsPerTable = 50000
	maxImportTotalRows    = 100000
	maxImportFieldsPerRow = 128
	maxImportKeyBytes     = 256
	maxImportStringBytes  = 1 << 20
	maxImportValueDepth   = 16
	maxImportArrayItems   = 4096
	maxExportJSONBytes    = 100 << 20

	sanitizedDataExchangeKind = "sanitized_data_exchange"
)

var (
	// ErrBadRequest is returned when input cannot be applied.
	ErrBadRequest     = errors.New("bad admin settings request")
	errExportTooLarge = errors.New("database export exceeds size limit")
)

var exportableTables = []ExportableTableItem{
	{Name: "student_profiles", DisplayName: "学生画像"},
	{Name: "knowledge_nodes", DisplayName: "知识节点"},
	{Name: "knowledge_relations", DisplayName: "知识关系"},
	{Name: "learning_sessions", DisplayName: "学习会话"},
	{Name: "session_messages", DisplayName: "会话消息"},
	{Name: "contents", DisplayName: "内容"},
	{Name: "system_settings", DisplayName: "系统设置"},
	{Name: "email_templates", DisplayName: "邮件模板"},
	{Name: "system_announcements", DisplayName: "系统公告"},
	{Name: "announcement_dismissals", DisplayName: "公告关闭记录"},
	{Name: "classes", DisplayName: "班级"},
	{Name: "class_enrollments", DisplayName: "班级学生"},
	{Name: "class_enrollment_history", DisplayName: "班级学生历史"},
	{Name: "security_logs", DisplayName: "安全日志"},
}

var importOrder = []string{
	"student_profiles",
	"knowledge_nodes",
	"knowledge_relations",
	"system_settings",
	"email_templates",
	"system_announcements",
	"announcement_dismissals",
	"classes",
	"class_enrollments",
	"class_enrollment_history",
	"contents",
	"learning_sessions",
	"session_messages",
	"security_logs",
}

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

// Repository is the persistence surface required by admin settings.
type Repository interface {
	GetSettings(context.Context, []string) (map[string]string, error)
	UpsertSettings(context.Context, []SettingUpdate) error
	ExportTable(context.Context, string, func(map[string]any) error) (int, error)
	ImportTables(context.Context, []ImportTable) (map[string]TableImportResult, error)
	DatabaseOverview(context.Context) (DatabaseOverview, error)
	TableStats(context.Context) ([]TableStats, error)
}

// PoolStatsProvider supplies connection pool status for database monitor.
type PoolStatsProvider interface {
	ConnectionPoolStatus() ConnectionPoolStatus
}

// PoolStatsProviderFunc adapts a function into a PoolStatsProvider.
type PoolStatsProviderFunc func() ConnectionPoolStatus

// ConnectionPoolStatus calls f().
func (f PoolStatsProviderFunc) ConnectionPoolStatus() ConnectionPoolStatus {
	return f()
}

// SettingUpdate stores one system setting mutation.
type SettingUpdate struct {
	Key         string
	Value       string
	Description string
	UpdatedAt   time.Time
}

// ImportTable stores one fully parsed and validated table for atomic import.
type ImportTable struct {
	Name string
	Rows []map[string]any
}

// RegistrationSettingsResponse mirrors /admin/settings/registration.
type RegistrationSettingsResponse struct {
	AllowStudent bool `json:"allow_student"`
	AllowTeacher bool `json:"allow_teacher"`
}

// GeneralSettingsResponse mirrors /admin/settings/general.
type GeneralSettingsResponse struct {
	SystemName        string `json:"system_name"`
	SystemDescription string `json:"system_description"`
	SystemVersion     string `json:"system_version"`
}

// ExportableTableItem stores one exportable table descriptor.
type ExportableTableItem struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
}

// ExportableTablesResponse mirrors /admin/settings/database/exportable-tables.
type ExportableTablesResponse struct {
	Tables []ExportableTableItem `json:"tables"`
}

// DataExportMetadata describes a streamed database export response.
type DataExportMetadata struct {
	Filename     string         `json:"filename"`
	ExportedAt   time.Time      `json:"exported_at"`
	TableCounts  map[string]int `json:"table_counts"`
	TotalRecords int            `json:"total_records"`
}

// TableImportResult stores one table import outcome.
type TableImportResult struct {
	Imported int `json:"imported"`
	Skipped  int `json:"skipped"`
	Failed   int `json:"failed"`
}

// DataImportResponse mirrors /admin/settings/database/import.
type DataImportResponse struct {
	Success       bool                         `json:"success"`
	ImportedAt    time.Time                    `json:"imported_at"`
	TableResults  map[string]TableImportResult `json:"table_results"`
	TotalImported int                          `json:"total_imported"`
	TotalSkipped  int                          `json:"total_skipped"`
	TotalFailed   int                          `json:"total_failed"`
	Errors        []string                     `json:"errors"`
}

// ConnectionPoolStatus mirrors database pool status.
type ConnectionPoolStatus struct {
	PoolSize     int     `json:"pool_size"`
	MaxOverflow  int     `json:"max_overflow"`
	CheckedOut   int     `json:"checked_out"`
	CheckedIn    int     `json:"checked_in"`
	Overflow     int     `json:"overflow"`
	PoolTimeout  int     `json:"pool_timeout"`
	PoolRecycle  int     `json:"pool_recycle"`
	UsagePercent float64 `json:"usage_percent"`
}

// TableStats stores one database table statistic.
type TableStats struct {
	TableName   string `json:"table_name"`
	DisplayName string `json:"display_name"`
	RowCount    int    `json:"row_count"`
	TableSize   string `json:"table_size"`
	IndexSize   string `json:"index_size"`
	TotalSize   string `json:"total_size"`
}

// DatabaseOverview stores database-level monitor data.
type DatabaseOverview struct {
	DatabaseName      string `json:"database_name"`
	DatabaseSize      string `json:"database_size"`
	PostgresVersion   string `json:"postgres_version"`
	Uptime            string `json:"uptime"`
	ActiveConnections int    `json:"active_connections"`
	MaxConnections    int    `json:"max_connections"`
}

// DatabaseMonitorResponse mirrors /admin/settings/database/monitor.
type DatabaseMonitorResponse struct {
	Overview       DatabaseOverview     `json:"overview"`
	ConnectionPool ConnectionPoolStatus `json:"connection_pool"`
	Tables         []TableStats         `json:"tables"`
	HealthStatus   string               `json:"health_status"`
	CheckedAt      time.Time            `json:"checked_at"`
}

// Service implements admin settings and database management use cases.
type Service struct {
	repo        Repository
	poolStats   PoolStatsProvider
	appName     string
	appVersion  string
	now         func() time.Time
	tableLookup map[string]string
}

// NewService creates an admin settings service.
func NewService(repo Repository, appName string, appVersion string, providers ...PoolStatsProvider) (*Service, error) {
	if repo == nil {
		return nil, errors.New("admin settings repository is nil")
	}
	if strings.TrimSpace(appName) == "" {
		appName = "高等数学智能学习平台"
	}
	if strings.TrimSpace(appVersion) == "" {
		appVersion = "0.1.0"
	}
	var poolStats PoolStatsProvider
	if len(providers) > 0 {
		poolStats = providers[0]
	}
	lookup := map[string]string{}
	for _, table := range exportableTables {
		lookup[table.Name] = table.DisplayName
	}
	return &Service{
		repo:        repo,
		poolStats:   poolStats,
		appName:     appName,
		appVersion:  appVersion,
		now:         func() time.Time { return time.Now().UTC() },
		tableLookup: lookup,
	}, nil
}

// RegistrationSettings reads registration toggles with Python-compatible defaults.
func (s *Service) RegistrationSettings(ctx context.Context) (RegistrationSettingsResponse, error) {
	values, err := s.repo.GetSettings(ctx, []string{allowStudentRegistration, allowTeacherRegistration})
	if err != nil {
		return RegistrationSettingsResponse{}, err
	}
	return RegistrationSettingsResponse{
		AllowStudent: settingBool(values, allowStudentRegistration, true),
		AllowTeacher: settingBool(values, allowTeacherRegistration, false),
	}, nil
}

// UpdateRegistrationSettings updates registration toggles.
func (s *Service) UpdateRegistrationSettings(ctx context.Context, allowStudent bool, allowTeacher bool) (RegistrationSettingsResponse, error) {
	now := s.now()
	if err := s.repo.UpsertSettings(ctx, []SettingUpdate{
		{Key: allowStudentRegistration, Value: strconv.FormatBool(allowStudent), Description: "是否允许学生注册", UpdatedAt: now},
		{Key: allowTeacherRegistration, Value: strconv.FormatBool(allowTeacher), Description: "是否允许教师注册", UpdatedAt: now},
	}); err != nil {
		return RegistrationSettingsResponse{}, err
	}
	return RegistrationSettingsResponse{AllowStudent: allowStudent, AllowTeacher: allowTeacher}, nil
}

// GeneralSettings reads system display metadata.
func (s *Service) GeneralSettings(ctx context.Context) (GeneralSettingsResponse, error) {
	values, err := s.repo.GetSettings(ctx, []string{systemNameKey, systemDescriptionKey})
	if err != nil {
		return GeneralSettingsResponse{}, err
	}
	response := GeneralSettingsResponse{
		SystemName:        s.appName,
		SystemDescription: "",
		SystemVersion:     s.appVersion,
	}
	if value := strings.TrimSpace(values[systemNameKey]); value != "" {
		response.SystemName = value
	}
	if value, ok := values[systemDescriptionKey]; ok {
		response.SystemDescription = value
	}
	return response, nil
}

// UpdateGeneralSettings updates system display metadata.
func (s *Service) UpdateGeneralSettings(ctx context.Context, systemName string, systemDescription string) (GeneralSettingsResponse, error) {
	systemName = strings.TrimSpace(systemName)
	if systemName == "" || len(systemName) > 100 {
		return GeneralSettingsResponse{}, badRequest("system_name 长度必须在 1 到 100 之间")
	}
	if len(systemDescription) > 500 {
		return GeneralSettingsResponse{}, badRequest("system_description 长度不能超过 500")
	}
	now := s.now()
	if err := s.repo.UpsertSettings(ctx, []SettingUpdate{
		{Key: systemNameKey, Value: systemName, Description: "系统名称", UpdatedAt: now},
		{Key: systemDescriptionKey, Value: systemDescription, Description: "系统描述", UpdatedAt: now},
	}); err != nil {
		return GeneralSettingsResponse{}, err
	}
	return GeneralSettingsResponse{
		SystemName:        systemName,
		SystemDescription: systemDescription,
		SystemVersion:     s.appVersion,
	}, nil
}

// ExportableTables returns supported database export tables.
func (s *Service) ExportableTables(context.Context) (ExportableTablesResponse, error) {
	tables := append([]ExportableTableItem(nil), exportableTables...)
	return ExportableTablesResponse{Tables: tables}, nil
}

// ExportData writes selected tables as a sanitized JSON exchange and returns response metadata.
func (s *Service) ExportData(ctx context.Context, tables []string, adminID string, destination io.Writer) (DataExportMetadata, error) {
	if len(tables) == 0 {
		return DataExportMetadata{}, badRequest("至少选择一张表")
	}
	for _, table := range tables {
		if !s.isExportableTable(table) {
			return DataExportMetadata{}, badRequest("不支持导出的表: " + table)
		}
	}
	if destination == nil {
		return DataExportMetadata{}, errors.New("database export destination is nil")
	}

	exportedAt := s.now()
	metadata := DataExportMetadata{
		Filename:    "sanitized_data_" + exportedAt.Format("20060102_150405") + ".json",
		ExportedAt:  exportedAt,
		TableCounts: map[string]int{},
	}
	orderedTables := append([]string(nil), tables...)
	sort.Strings(orderedTables)
	writer := &exportLimitWriter{destination: destination, remaining: maxExportJSONBytes}
	if err := s.writeExportPayload(ctx, writer, orderedTables, adminID, &metadata); err != nil {
		if errors.Is(err, errExportTooLarge) {
			return DataExportMetadata{}, badRequest("导出数据不能超过 100MB")
		}
		return DataExportMetadata{}, err
	}
	return metadata, nil
}

func (s *Service) writeExportPayload(
	ctx context.Context,
	writer io.Writer,
	tables []string,
	adminID string,
	metadata *DataExportMetadata,
) error {
	if _, err := io.WriteString(writer, `{"exported_at":`); err != nil {
		return fmt.Errorf("write export metadata: %w", err)
	}
	if err := writeJSONValue(writer, metadata.ExportedAt.Format(time.RFC3339)); err != nil {
		return fmt.Errorf("write export timestamp: %w", err)
	}
	if _, err := io.WriteString(writer, `,"exported_by":`); err != nil {
		return fmt.Errorf("write export metadata: %w", err)
	}
	if err := writeJSONValue(writer, adminID); err != nil {
		return fmt.Errorf("write export administrator: %w", err)
	}
	if _, err := io.WriteString(writer, `,"data_kind":"sanitized_data_exchange","sanitized":true,"complete_backup":false,"full_restore_supported":false,"excluded_data":["user_accounts","administrator_accounts","sensitive_fields","unlisted_business_tables"]`); err != nil {
		return fmt.Errorf("write export scope: %w", err)
	}
	if _, err := io.WriteString(writer, `,"tables":{`); err != nil {
		return fmt.Errorf("write export tables: %w", err)
	}
	for index, table := range tables {
		if index > 0 {
			if _, err := io.WriteString(writer, ","); err != nil {
				return fmt.Errorf("write export table separator: %w", err)
			}
		}
		if err := writeJSONValue(writer, table); err != nil {
			return fmt.Errorf("write export table name: %w", err)
		}
		if _, err := io.WriteString(writer, ":["); err != nil {
			return fmt.Errorf("write export table %s: %w", table, err)
		}
		firstRow := true
		count, err := s.repo.ExportTable(ctx, table, func(row map[string]any) error {
			if !firstRow {
				if _, err := io.WriteString(writer, ","); err != nil {
					return err
				}
			}
			firstRow = false
			return writeJSONValue(writer, row)
		})
		if err != nil {
			return fmt.Errorf("export %s: %w", table, err)
		}
		if _, err := io.WriteString(writer, "]"); err != nil {
			return fmt.Errorf("write export table %s: %w", table, err)
		}
		metadata.TableCounts[table] = count
		metadata.TotalRecords += count
	}
	if _, err := io.WriteString(writer, `},"version":"1.0"}`); err != nil {
		return fmt.Errorf("finish database export: %w", err)
	}
	return nil
}

func writeJSONValue(writer io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = writer.Write(data)
	return err
}

type exportLimitWriter struct {
	destination io.Writer
	remaining   int64
}

func (w *exportLimitWriter) Write(data []byte) (int, error) {
	if int64(len(data)) > w.remaining {
		return 0, errExportTooLarge
	}
	written, err := w.destination.Write(data)
	w.remaining -= int64(written)
	if err == nil && written != len(data) {
		return written, io.ErrShortWrite
	}
	return written, err
}

// ImportData imports a sanitized JSON data exchange atomically.
func (s *Service) ImportData(ctx context.Context, content []byte, adminID string) (DataImportResponse, error) {
	_ = adminID
	var payload struct {
		DataKind             string                     `json:"data_kind"`
		Sanitized            *bool                      `json:"sanitized"`
		CompleteBackup       *bool                      `json:"complete_backup"`
		FullRestoreSupported *bool                      `json:"full_restore_supported"`
		Tables               map[string]json.RawMessage `json:"tables"`
	}
	if err := json.Unmarshal(content, &payload); err != nil {
		return DataImportResponse{}, badRequest("JSON 文件解析失败: " + err.Error())
	}
	if payload.Tables == nil {
		return DataImportResponse{}, badRequest("无效的脱敏数据交换文件格式")
	}
	if len(payload.Tables) > maxImportTableCount {
		return DataImportResponse{}, badRequest(fmt.Sprintf("导入表数量不能超过 %d", maxImportTableCount))
	}
	if payload.DataKind != "" && payload.DataKind != sanitizedDataExchangeKind {
		return DataImportResponse{}, badRequest("此接口仅支持管理端脱敏数据交换 JSON；完整数据库恢复请使用 pg_dump/pg_restore")
	}
	if payload.CompleteBackup != nil && *payload.CompleteBackup {
		return DataImportResponse{}, badRequest("此接口不接受完整数据库备份；完整数据库恢复请使用 pg_dump/pg_restore")
	}
	if payload.Sanitized != nil && !*payload.Sanitized {
		return DataImportResponse{}, badRequest("此接口仅接受脱敏数据交换文件；完整数据库恢复请使用 pg_dump/pg_restore")
	}
	if payload.FullRestoreSupported != nil && *payload.FullRestoreSupported {
		return DataImportResponse{}, badRequest("此接口不支持完整数据库恢复；请使用 pg_dump/pg_restore")
	}

	response := DataImportResponse{
		TableResults: map[string]TableImportResult{},
		Errors:       []string{},
	}
	prepared := make([]ImportTable, 0, len(payload.Tables))
	totalRows := 0
	for _, table := range s.orderedImportTables(payload.Tables) {
		var rows []map[string]any
		if err := json.Unmarshal(payload.Tables[table], &rows); err != nil {
			return DataImportResponse{}, badRequest(table + ": 数据格式无效")
		}
		totalRows += len(rows)
		if totalRows > maxImportTotalRows {
			return DataImportResponse{}, badRequest(fmt.Sprintf("导入总行数不能超过 %d", maxImportTotalRows))
		}
		if err := validateImportRows(table, rows); err != nil {
			return DataImportResponse{}, err
		}
		if table == "users" {
			if len(rows) > 0 {
				return DataImportResponse{}, badRequest("脱敏数据交换不支持导入用户账号，也不能用于空库恢复；请先在目标库建立所需账号，完整恢复请使用 pg_dump/pg_restore")
			}
			continue
		}
		if !s.isExportableTable(table) {
			response.Errors = append(response.Errors, "跳过未知表: "+table)
			continue
		}
		prepared = append(prepared, ImportTable{Name: table, Rows: rows})
	}
	if err := ctx.Err(); err != nil {
		return DataImportResponse{}, err
	}

	results := map[string]TableImportResult{}
	if len(prepared) > 0 {
		var err error
		results, err = s.repo.ImportTables(ctx, prepared)
		if err != nil {
			return DataImportResponse{}, fmt.Errorf("import sanitized data exchange: %w", err)
		}
	}
	for _, table := range prepared {
		result := results[table.Name]
		response.TableResults[table.Name] = result
		response.TotalImported += result.Imported
		response.TotalSkipped += result.Skipped
		response.TotalFailed += result.Failed
		if result.Failed > 0 {
			response.Errors = append(response.Errors, fmt.Sprintf(
				"%s: %d 条数据不符合目标库约束，已跳过；请确认目标库已有对应账号和关联数据",
				table.Name,
				result.Failed,
			))
		}
	}
	response.ImportedAt = s.now()
	response.Success = response.TotalFailed == 0 && len(response.Errors) == 0
	return response, nil
}

func validateImportRows(table string, rows []map[string]any) error {
	if len(rows) > maxImportRowsPerTable {
		return badRequest(fmt.Sprintf("%s: 单表导入行数不能超过 %d", table, maxImportRowsPerTable))
	}
	for rowIndex, row := range rows {
		if len(row) > maxImportFieldsPerRow {
			return badRequest(fmt.Sprintf("%s: 第 %d 行字段数量不能超过 %d", table, rowIndex+1, maxImportFieldsPerRow))
		}
		for column, value := range row {
			if len(column) > maxImportKeyBytes {
				return badRequest(fmt.Sprintf("%s: 第 %d 行字段名长度不能超过 %d 字节", table, rowIndex+1, maxImportKeyBytes))
			}
			if err := validateImportValue(value, 0); err != nil {
				return badRequest(fmt.Sprintf("%s: 第 %d 行字段 %q %s", table, rowIndex+1, column, err.Error()))
			}
		}
	}
	return nil
}

func validateImportValue(value any, depth int) error {
	if depth > maxImportValueDepth {
		return fmt.Errorf("嵌套深度不能超过 %d", maxImportValueDepth)
	}
	switch typed := value.(type) {
	case string:
		if len(typed) > maxImportStringBytes {
			return fmt.Errorf("字符串长度不能超过 %d 字节", maxImportStringBytes)
		}
	case []any:
		if len(typed) > maxImportArrayItems {
			return fmt.Errorf("数组长度不能超过 %d", maxImportArrayItems)
		}
		for _, item := range typed {
			if err := validateImportValue(item, depth+1); err != nil {
				return err
			}
		}
	case map[string]any:
		if len(typed) > maxImportFieldsPerRow {
			return fmt.Errorf("对象字段数量不能超过 %d", maxImportFieldsPerRow)
		}
		for key, nested := range typed {
			if len(key) > maxImportKeyBytes {
				return fmt.Errorf("对象字段名长度不能超过 %d 字节", maxImportKeyBytes)
			}
			if err := validateImportValue(nested, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

// DatabaseMonitor returns database overview, pool usage, and table statistics.
func (s *Service) DatabaseMonitor(ctx context.Context) (DatabaseMonitorResponse, error) {
	overview, err := s.repo.DatabaseOverview(ctx)
	if err != nil {
		return DatabaseMonitorResponse{}, err
	}
	tables, err := s.repo.TableStats(ctx)
	if err != nil {
		return DatabaseMonitorResponse{}, err
	}
	pool := ConnectionPoolStatus{}
	if s.poolStats != nil {
		pool = s.poolStats.ConnectionPoolStatus()
	}
	health := "healthy"
	if pool.UsagePercent > 90 {
		health = "degraded"
	}
	if pool.UsagePercent > 95 {
		health = "unhealthy"
	}
	return DatabaseMonitorResponse{
		Overview:       overview,
		ConnectionPool: pool,
		Tables:         tables,
		HealthStatus:   health,
		CheckedAt:      s.now(),
	}, nil
}

func (s *Service) orderedImportTables(tables map[string]json.RawMessage) []string {
	seen := map[string]bool{}
	ordered := make([]string, 0, len(tables))
	for _, table := range importOrder {
		if _, ok := tables[table]; ok {
			ordered = append(ordered, table)
			seen[table] = true
		}
	}
	remaining := make([]string, 0)
	for table := range tables {
		if !seen[table] {
			remaining = append(remaining, table)
		}
	}
	sort.Strings(remaining)
	return append(ordered, remaining...)
}

func (s *Service) isExportableTable(table string) bool {
	_, ok := s.tableLookup[table]
	return ok
}

func settingBool(values map[string]string, key string, fallback bool) bool {
	value, ok := values[key]
	if !ok {
		return fallback
	}
	return strings.EqualFold(value, "true")
}

func DisplayNameForTable(table string) string {
	for _, item := range exportableTables {
		if item.Name == table {
			return item.DisplayName
		}
	}
	return table
}

func badRequest(message string) error {
	return Error{Kind: ErrBadRequest, Message: message}
}
