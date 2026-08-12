package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	securitylogapp "mathstudy/backend/internal/application/securitylog"
)

// SecurityLogRepository persists security logs and cleanup operations.
type SecurityLogRepository struct {
	Repository
}

// NewSecurityLogRepository creates a PostgreSQL-backed security log repository.
func NewSecurityLogRepository(db Querier) (SecurityLogRepository, error) {
	base, err := NewRepository(db)
	if err != nil {
		return SecurityLogRepository{}, err
	}
	return SecurityLogRepository{Repository: base}, nil
}

// ListLogs returns one filtered log page and total count.
func (r SecurityLogRepository) ListLogs(ctx context.Context, filter securitylogapp.QueryFilter) ([]securitylogapp.LogItem, int, error) {
	where, args := securityLogWhereClause(filter.EventTypes, filter.Severities, filter.StartDate, filter.EndDate, filter.IncludeArchived)
	var total int
	if err := r.DB().QueryRow(ctx, `
		SELECT count(id)::int
		FROM public.security_logs
		WHERE `+where,
		args...,
	).Scan(&total); err != nil {
		return nil, 0, err
	}

	offset := (filter.Page - 1) * filter.PageSize
	args = append(args, filter.PageSize, offset)
	limitPlaceholder := fmt.Sprintf("$%d", len(args)-1)
	offsetPlaceholder := fmt.Sprintf("$%d", len(args))
	rows, err := r.DB().Query(ctx, securityLogSelectSQL+`
		WHERE `+where+`
		ORDER BY created_at DESC, id DESC
		LIMIT `+limitPlaceholder+` OFFSET `+offsetPlaceholder,
		args...,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	logs, err := scanSecurityLogs(rows)
	if err != nil {
		return nil, 0, err
	}
	return logs, total, nil
}

// Stats returns security log counters for non-archived logs.
func (r SecurityLogRepository) Stats(ctx context.Context) (securitylogapp.StatsResponse, error) {
	var stats securitylogapp.StatsResponse
	if err := r.DB().QueryRow(ctx, `
		SELECT
			count(id)::int,
			coalesce(sum(CASE WHEN severity IN ('error'::public.securityseverity, 'critical'::public.securityseverity) THEN 1 ELSE 0 END), 0)::int,
			coalesce(sum(CASE WHEN severity = 'warning'::public.securityseverity THEN 1 ELSE 0 END), 0)::int,
			coalesce(sum(CASE WHEN severity = 'info'::public.securityseverity THEN 1 ELSE 0 END), 0)::int
		FROM public.security_logs
		WHERE archived = false`,
	).Scan(&stats.TotalCount, &stats.ErrorCount, &stats.WarningCount, &stats.InfoCount); err != nil {
		return securitylogapp.StatsResponse{}, err
	}

	var lastError pgtype.Timestamp
	if err := r.DB().QueryRow(ctx, `
		SELECT created_at
		FROM public.security_logs
		WHERE archived = false AND severity IN ('error'::public.securityseverity, 'critical'::public.securityseverity)
		ORDER BY created_at DESC
		LIMIT 1`,
	).Scan(&lastError); err != nil && err != pgx.ErrNoRows {
		return securitylogapp.StatsResponse{}, err
	}
	stats.LastErrorAt = timestampPtr(lastError)

	var lastReport pgtype.Timestamp
	if err := r.DB().QueryRow(ctx, `
		SELECT created_at
		FROM public.security_logs
		WHERE event_type = 'daily_report'::public.securityeventtype
		ORDER BY created_at DESC
		LIMIT 1`,
	).Scan(&lastReport); err != nil && err != pgx.ErrNoRows {
		return securitylogapp.StatsResponse{}, err
	}
	stats.LastDailyReportAt = timestampPtr(lastReport)
	return stats, nil
}

// DeleteLogs deletes logs by ids, cutoff, all logs, or no-ops when no filter is supplied.
func (r SecurityLogRepository) DeleteLogs(ctx context.Context, request securitylogapp.DeleteRequest) (int, error) {
	switch {
	case request.DeleteAll:
		tag, err := r.DB().Exec(ctx, `DELETE FROM public.security_logs`)
		return int(tag.RowsAffected()), err
	case len(request.LogIDs) > 0:
		tag, err := r.DB().Exec(ctx, `DELETE FROM public.security_logs WHERE id = ANY($1)`, request.LogIDs)
		return int(tag.RowsAffected()), err
	case request.BeforeDate != nil:
		tag, err := r.DB().Exec(ctx, `DELETE FROM public.security_logs WHERE created_at < $1`, *request.BeforeDate)
		return int(tag.RowsAffected()), err
	default:
		return 0, nil
	}
}

// ExportLogs returns all logs matching export filters.
func (r SecurityLogRepository) ExportLogs(ctx context.Context, request securitylogapp.ExportRequest) ([]securitylogapp.LogItem, error) {
	where, args := securityLogWhereClause(request.EventTypes, request.Severities, request.StartDate, request.EndDate, request.IncludeArchived)
	rows, err := r.DB().Query(ctx, securityLogSelectSQL+`
		WHERE `+where+`
		ORDER BY created_at DESC, id DESC`,
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSecurityLogs(rows)
}

// ArchiveLogs marks logs before cutoff as archived.
func (r SecurityLogRepository) ArchiveLogs(ctx context.Context, before time.Time) (int, error) {
	tag, err := r.DB().Exec(ctx, `
		UPDATE public.security_logs
		SET archived = true
		WHERE created_at < $1 AND archived = false`,
		before,
	)
	return int(tag.RowsAffected()), err
}

// DailyReportStatus returns whether today has a report and how many abnormal events exist.
func (r SecurityLogRepository) DailyReportStatus(ctx context.Context, todayStart, todayEnd time.Time) (bool, int, error) {
	var reportCount int
	if err := r.DB().QueryRow(ctx, `
		SELECT count(id)::int
		FROM public.security_logs
		WHERE event_type = 'daily_report'::public.securityeventtype
		  AND created_at >= $1
		  AND created_at < $2`,
		todayStart,
		todayEnd,
	).Scan(&reportCount); err != nil {
		return false, 0, err
	}
	var abnormalCount int
	if err := r.DB().QueryRow(ctx, `
		SELECT count(id)::int
		FROM public.security_logs
		WHERE severity != 'info'::public.securityseverity
		  AND created_at >= $1
		  AND created_at < $2`,
		todayStart,
		todayEnd,
	).Scan(&abnormalCount); err != nil {
		return false, 0, err
	}
	return reportCount > 0, abnormalCount, nil
}

// CreateLog inserts one security log.
func (r SecurityLogRepository) CreateLog(ctx context.Context, create securitylogapp.CreateLog) (securitylogapp.LogItem, error) {
	id, err := newUUID()
	if err != nil {
		return securitylogapp.LogItem{}, err
	}
	if create.ExtraData == nil {
		create.ExtraData = map[string]any{}
	}
	metadata, err := json.Marshal(create.ExtraData)
	if err != nil {
		return securitylogapp.LogItem{}, err
	}
	if create.CreatedAt.IsZero() {
		create.CreatedAt = time.Now().UTC()
	}
	if _, err := r.DB().Exec(ctx, `
		INSERT INTO public.security_logs (
			id, event_type, severity, title, description, metadata, archived, created_at
		)
		VALUES ($1, $2::public.securityeventtype, $3::public.securityseverity, $4, $5, $6::json, false, $7)`,
		id,
		string(create.EventType),
		string(create.Severity),
		create.Title,
		create.Description,
		string(metadata),
		create.CreatedAt,
	); err != nil {
		return securitylogapp.LogItem{}, err
	}
	row := r.DB().QueryRow(ctx, securityLogSelectSQL+` WHERE id = $1`, id)
	item, err := scanSecurityLog(row)
	if err != nil {
		return securitylogapp.LogItem{}, err
	}
	return item, nil
}

// AutoArchive archives one bounded batch of stale active logs.
func (r SecurityLogRepository) AutoArchive(ctx context.Context, cutoff time.Time, batchSize int) (int, error) {
	if batchSize <= 0 {
		return 0, fmt.Errorf("security log archive batch size must be greater than 0")
	}
	tag, err := r.DB().Exec(ctx, `
		WITH candidates AS (
			SELECT log.id
			FROM public.security_logs log
			WHERE log.created_at < $1 AND log.archived = false
			ORDER BY log.created_at, log.id
			FOR UPDATE SKIP LOCKED
			LIMIT $2
		)
		UPDATE public.security_logs log
		SET archived = true
		FROM candidates
		WHERE log.id = candidates.id`,
		cutoff,
		batchSize,
	)
	return int(tag.RowsAffected()), err
}

// AutoDelete deletes one bounded batch of stale archived logs.
func (r SecurityLogRepository) AutoDelete(ctx context.Context, cutoff time.Time, batchSize int) (int, error) {
	if batchSize <= 0 {
		return 0, fmt.Errorf("security log delete batch size must be greater than 0")
	}
	tag, err := r.DB().Exec(ctx, `
		WITH candidates AS (
			SELECT log.id
			FROM public.security_logs log
			WHERE log.created_at < $1 AND log.archived = true
			ORDER BY log.created_at, log.id
			FOR UPDATE SKIP LOCKED
			LIMIT $2
		)
		DELETE FROM public.security_logs log
		USING candidates
		WHERE log.id = candidates.id`,
		cutoff,
		batchSize,
	)
	return int(tag.RowsAffected()), err
}

// Volume returns active and archived counts.
func (r SecurityLogRepository) Volume(ctx context.Context) (securitylogapp.VolumeResponse, error) {
	var volume securitylogapp.VolumeResponse
	if err := r.DB().QueryRow(ctx, `
		SELECT
			coalesce(sum(CASE WHEN archived = false THEN 1 ELSE 0 END), 0)::int,
			coalesce(sum(CASE WHEN archived = true THEN 1 ELSE 0 END), 0)::int
		FROM public.security_logs`,
	).Scan(&volume.ActiveCount, &volume.ArchivedCount); err != nil {
		return securitylogapp.VolumeResponse{}, err
	}
	return volume, nil
}

const securityLogSelectSQL = `
	SELECT id, event_type::text, severity::text, title, description, ip_address, user_id, username, metadata, archived, created_at
	FROM public.security_logs`

func securityLogWhereClause(eventTypes []securitylogapp.EventType, severities []securitylogapp.Severity, startDate *time.Time, endDate *time.Time, includeArchived bool) (string, []any) {
	conditions := []string{"true"}
	args := []any{}
	if !includeArchived {
		conditions = append(conditions, "archived = false")
	}
	if len(eventTypes) > 0 {
		args = append(args, eventTypesToStrings(eventTypes))
		conditions = append(conditions, fmt.Sprintf("event_type::text = ANY($%d)", len(args)))
	}
	if len(severities) > 0 {
		args = append(args, severitiesToStrings(severities))
		conditions = append(conditions, fmt.Sprintf("severity::text = ANY($%d)", len(args)))
	}
	if startDate != nil {
		args = append(args, *startDate)
		conditions = append(conditions, fmt.Sprintf("created_at >= $%d", len(args)))
	}
	if endDate != nil {
		args = append(args, *endDate)
		conditions = append(conditions, fmt.Sprintf("created_at <= $%d", len(args)))
	}
	return strings.Join(conditions, " AND "), args
}

func scanSecurityLogs(rows pgx.Rows) ([]securitylogapp.LogItem, error) {
	logs := []securitylogapp.LogItem{}
	for rows.Next() {
		item, err := scanSecurityLog(rows)
		if err != nil {
			return nil, err
		}
		logs = append(logs, item)
	}
	return logs, rows.Err()
}

func scanSecurityLog(row rowScanner) (securitylogapp.LogItem, error) {
	var item securitylogapp.LogItem
	var eventType string
	var severity string
	var ipAddress pgtype.Text
	var userID pgtype.Text
	var username pgtype.Text
	var metadata []byte
	if err := row.Scan(
		&item.ID,
		&eventType,
		&severity,
		&item.Title,
		&item.Description,
		&ipAddress,
		&userID,
		&username,
		&metadata,
		&item.Archived,
		&item.CreatedAt,
	); err != nil {
		return securitylogapp.LogItem{}, err
	}
	item.EventType = securitylogapp.EventType(eventType)
	item.Severity = securitylogapp.Severity(severity)
	item.IPAddress = textPtr(ipAddress)
	item.UserID = textPtr(userID)
	item.Username = textPtr(username)
	item.ExtraData = map[string]any{}
	if len(metadata) > 0 {
		_ = json.Unmarshal(metadata, &item.ExtraData)
	}
	return item, nil
}

func eventTypesToStrings(values []securitylogapp.EventType) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, string(value))
	}
	return result
}

func severitiesToStrings(values []securitylogapp.Severity) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, string(value))
	}
	return result
}
