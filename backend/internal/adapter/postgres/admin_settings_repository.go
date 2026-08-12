package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	adminsettingsapp "mathstudy/backend/internal/application/adminsettings"
	adminstorageapp "mathstudy/backend/internal/application/adminstorage"
	"mathstudy/backend/internal/domain/user"
	"mathstudy/backend/internal/platform/redact"
)

var sensitiveExportFields = map[string]bool{
	"hashed_password": true,
}

var sensitiveSystemSettingKeys = map[string]bool{
	"smtp_password":            true,
	"storage_qiniu_access_key": true,
	"storage_qiniu_secret_key": true,
	"storage_s3_access_key":    true,
	"storage_s3_secret_key":    true,
}

const (
	maxImportBatchRows       = 500
	maxImportBatchParameters = 60000
)

// AdminSettingsRepository persists system settings and database management operations.
type AdminSettingsRepository struct {
	Repository
}

// NewAdminSettingsRepository creates a PostgreSQL-backed admin settings repository.
func NewAdminSettingsRepository(db Querier) (AdminSettingsRepository, error) {
	base, err := NewRepository(db)
	if err != nil {
		return AdminSettingsRepository{}, err
	}
	return AdminSettingsRepository{Repository: base}, nil
}

// GetSettings returns key/value pairs for requested system settings.
func (r AdminSettingsRepository) GetSettings(ctx context.Context, keys []string) (map[string]string, error) {
	rows, err := r.DB().Query(ctx, `
		SELECT key, value
		FROM public.system_settings
		WHERE key = ANY($1)`,
		keys,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	values := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		values[key] = value
	}
	return values, rows.Err()
}

// UpsertSettings applies system setting changes.
func (r AdminSettingsRepository) UpsertSettings(ctx context.Context, updates []adminsettingsapp.SettingUpdate) error {
	for _, update := range updates {
		_, err := r.DB().Exec(ctx, `
			INSERT INTO public.system_settings (key, value, description, updated_at)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (key) DO UPDATE
			SET value = EXCLUDED.value,
				description = EXCLUDED.description,
				updated_at = EXCLUDED.updated_at`,
			update.Key,
			update.Value,
			update.Description,
			update.UpdatedAt,
		)
		if err != nil {
			return err
		}
	}
	return nil
}

// SaveStorageSettings atomically replaces the administrator-managed storage snapshot.
func (r AdminSettingsRepository) SaveStorageSettings(ctx context.Context, updates []adminstorageapp.SettingUpdate) error {
	return withRepositoryTx(ctx, "storage settings", r.Repository, func(base Repository) AdminSettingsRepository {
		return AdminSettingsRepository{Repository: base}
	}, func(tx AdminSettingsRepository) error {
		for _, update := range updates {
			if _, err := tx.DB().Exec(ctx, `
				INSERT INTO public.system_settings (key, value, description, updated_at)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (key) DO UPDATE
				SET value = EXCLUDED.value,
					description = EXCLUDED.description,
					updated_at = EXCLUDED.updated_at`,
				update.Key,
				update.Value,
				update.Description,
				update.UpdatedAt,
			); err != nil {
				return err
			}
		}
		return nil
	})
}

// ExportTable visits every row in one whitelisted table, excluding sensitive fields.
func (r AdminSettingsRepository) ExportTable(ctx context.Context, table string, visit func(map[string]any) error) (int, error) {
	if !safeTableName(table) {
		return 0, fmt.Errorf("unsafe table name %q", table)
	}
	sql := "SELECT * FROM " + pgx.Identifier{"public", table}.Sanitize()
	args := []any{}
	switch table {
	case "users":
		sql += " WHERE role <> 'ADMIN'::public.userrole"
	case "system_settings":
		sql += " WHERE key <> ALL($1)"
		args = append(args, sensitiveSystemSettingKeyList())
	}
	rows, err := r.DB().Query(ctx, sql, args...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	fields := rows.FieldDescriptions()
	count := 0
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return count, err
		}
		item := map[string]any{}
		for index, field := range fields {
			name := field.Name
			if shouldOmitExportField(table, name) {
				continue
			}
			item[name] = normalizeExportValue(name, values[index])
		}
		if err := visit(item); err != nil {
			return count, err
		}
		count++
	}
	return count, rows.Err()
}

func sensitiveSystemSettingKeyList() []string {
	keys := make([]string, 0, len(sensitiveSystemSettingKeys))
	for key := range sensitiveSystemSettingKeys {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// ImportRows imports rows into one whitelisted table with ON CONFLICT DO NOTHING.
func (r AdminSettingsRepository) ImportRows(ctx context.Context, table string, rows []map[string]any) (adminsettingsapp.TableImportResult, error) {
	if !safeTableName(table) {
		return adminsettingsapp.TableImportResult{}, fmt.Errorf("unsafe table name %q", table)
	}
	var result adminsettingsapp.TableImportResult
	var group importRowGroup
	flushGroup := func() error {
		if len(group.rows) == 0 {
			return nil
		}
		if len(group.columns) > maxImportBatchParameters {
			return fmt.Errorf(
				"import row has %d columns, exceeding PostgreSQL parameter limit %d",
				len(group.columns),
				maxImportBatchParameters,
			)
		}
		batchSize := min(maxImportBatchRows, maxImportBatchParameters/len(group.columns))
		for start := 0; start < len(group.rows); start += batchSize {
			end := min(start+batchSize, len(group.rows))
			batchResult, err := r.importRowBatch(ctx, table, group.columns, group.rows[start:end])
			result.Imported += batchResult.Imported
			result.Skipped += batchResult.Skipped
			result.Failed += batchResult.Failed
			if err != nil {
				return err
			}
		}
		group = importRowGroup{}
		return nil
	}
	for _, row := range rows {
		filtered := filterImportRow(table, row)
		if len(filtered) == 0 {
			if err := flushGroup(); err != nil {
				return result, err
			}
			result.Skipped++
			continue
		}
		columns := make([]string, 0, len(filtered))
		for column := range filtered {
			columns = append(columns, column)
		}
		sort.Strings(columns)
		key := strings.Join(columns, "\x00")
		if group.key != "" && group.key != key {
			if err := flushGroup(); err != nil {
				return result, err
			}
		}
		if group.key == "" {
			group.key = key
			group.columns = columns
		}
		values := make([]any, 0, len(columns))
		for _, column := range columns {
			values = append(values, normalizeImportValue(filtered[column]))
		}
		group.rows = append(group.rows, values)
	}
	if err := flushGroup(); err != nil {
		return result, err
	}
	return result, nil
}

type importRowGroup struct {
	key     string
	columns []string
	rows    [][]any
}

func (r AdminSettingsRepository) importRowBatch(
	ctx context.Context,
	table string,
	columns []string,
	rows [][]any,
) (adminsettingsapp.TableImportResult, error) {
	sql := importRowsSQL(table, columns, len(rows))
	args := make([]any, 0, len(columns)*len(rows))
	for _, row := range rows {
		args = append(args, row...)
	}
	tag, err := r.DB().Exec(ctx, sql, args...)
	if err == nil {
		imported := int(tag.RowsAffected())
		return adminsettingsapp.TableImportResult{
			Imported: imported,
			Skipped:  len(rows) - imported,
		}, nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return adminsettingsapp.TableImportResult{}, ctxErr
	}
	if !isImportRowDataError(err) {
		return adminsettingsapp.TableImportResult{}, err
	}

	result := adminsettingsapp.TableImportResult{}
	singleRowSQL := importRowsSQL(table, columns, 1)
	for _, row := range rows {
		tag, rowErr := r.DB().Exec(ctx, singleRowSQL, row...)
		if rowErr != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return result, ctxErr
			}
			if !isImportRowDataError(rowErr) {
				return result, rowErr
			}
			result.Failed++
		} else if tag.RowsAffected() > 0 {
			result.Imported++
		} else {
			result.Skipped++
		}
	}
	return result, nil
}

func isImportRowDataError(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || len(pgErr.Code) < 2 {
		return false
	}
	switch pgErr.Code[:2] {
	case "22", "23":
		return true
	default:
		return false
	}
}

func importRowsSQL(table string, columns []string, rowCount int) string {
	identifiers := make([]string, 0, len(columns))
	for _, column := range columns {
		identifiers = append(identifiers, pgx.Identifier{column}.Sanitize())
	}
	valueGroups := make([]string, 0, rowCount)
	parameter := 1
	for range rowCount {
		placeholders := make([]string, 0, len(columns))
		for range columns {
			placeholders = append(placeholders, fmt.Sprintf("$%d", parameter))
			parameter++
		}
		valueGroups = append(valueGroups, "("+strings.Join(placeholders, ", ")+")")
	}
	return "INSERT INTO " + pgx.Identifier{"public", table}.Sanitize() +
		" (" + strings.Join(identifiers, ", ") + ") VALUES " +
		strings.Join(valueGroups, ", ") + " ON CONFLICT DO NOTHING"
}

// DatabaseOverview returns PostgreSQL overview data.
func (r AdminSettingsRepository) DatabaseOverview(ctx context.Context) (adminsettingsapp.DatabaseOverview, error) {
	var overview adminsettingsapp.DatabaseOverview
	if err := r.DB().QueryRow(ctx, `SELECT current_database()`).Scan(&overview.DatabaseName); err != nil {
		return adminsettingsapp.DatabaseOverview{}, err
	}
	if err := r.DB().QueryRow(ctx, `SELECT pg_size_pretty(pg_database_size(current_database()))`).Scan(&overview.DatabaseSize); err != nil {
		return adminsettingsapp.DatabaseOverview{}, err
	}
	if err := r.DB().QueryRow(ctx, `SELECT version()`).Scan(&overview.PostgresVersion); err != nil {
		return adminsettingsapp.DatabaseOverview{}, err
	}
	if comma := strings.Index(overview.PostgresVersion, ","); comma >= 0 {
		overview.PostgresVersion = overview.PostgresVersion[:comma]
	}
	if err := r.DB().QueryRow(ctx, `SELECT (now() - pg_postmaster_start_time())::text`).Scan(&overview.Uptime); err != nil {
		return adminsettingsapp.DatabaseOverview{}, err
	}
	if err := r.DB().QueryRow(ctx, `SELECT count(*)::int FROM pg_stat_activity WHERE state = 'active'`).Scan(&overview.ActiveConnections); err != nil {
		return adminsettingsapp.DatabaseOverview{}, err
	}
	var maxConnections string
	if err := r.DB().QueryRow(ctx, `SHOW max_connections`).Scan(&maxConnections); err != nil {
		return adminsettingsapp.DatabaseOverview{}, err
	}
	parsed, err := strconv.Atoi(maxConnections)
	if err != nil {
		return adminsettingsapp.DatabaseOverview{}, err
	}
	overview.MaxConnections = parsed
	return overview, nil
}

// TableStats returns table row count and size statistics.
func (r AdminSettingsRepository) TableStats(ctx context.Context) ([]adminsettingsapp.TableStats, error) {
	rows, err := r.DB().Query(ctx, `
		SELECT
			relname AS table_name,
			n_live_tup::int AS row_count,
			pg_size_pretty(pg_table_size(relid)) AS table_size,
			pg_size_pretty(pg_indexes_size(relid)) AS index_size,
			pg_size_pretty(pg_total_relation_size(relid)) AS total_size
		FROM pg_stat_user_tables
		ORDER BY pg_total_relation_size(relid) DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stats := []adminsettingsapp.TableStats{}
	for rows.Next() {
		var item adminsettingsapp.TableStats
		if err := rows.Scan(&item.TableName, &item.RowCount, &item.TableSize, &item.IndexSize, &item.TotalSize); err != nil {
			return nil, err
		}
		item.DisplayName = adminsettingsapp.DisplayNameForTable(item.TableName)
		stats = append(stats, item)
	}
	return stats, rows.Err()
}

func filterImportRow(table string, row map[string]any) map[string]any {
	filtered := map[string]any{}
	for column, value := range row {
		if sensitiveExportFields[column] || !safeColumnName(column) {
			continue
		}
		filtered[column] = value
	}
	if table == "system_settings" {
		key, ok := stringValue(filtered["key"])
		if !ok || sensitiveSystemSettingKeys[strings.ToLower(key)] {
			return map[string]any{}
		}
	}
	if table == "email_templates" {
		delete(filtered, "updated_by")
	}
	if table == "users" && !normalizeImportedUserRow(filtered) {
		return map[string]any{}
	}
	return filtered
}

func normalizeImportedUserRow(row map[string]any) bool {
	roleValue, ok := stringValue(row["role"])
	if !ok {
		return false
	}
	role, err := user.ParseRole(roleValue)
	if err != nil || role == user.RoleAdmin {
		return false
	}
	row["role"] = role.DBValue()

	statusValue, ok := stringValue(row["status"])
	if !ok {
		return false
	}
	status, err := user.ParseStatus(statusValue)
	if err != nil {
		return false
	}
	row["status"] = status.DBValue()
	row["is_active"] = status == user.StatusActive
	return true
}

func stringValue(value any) (string, bool) {
	typed, ok := value.(string)
	if !ok {
		return "", false
	}
	typed = strings.TrimSpace(typed)
	if typed == "" {
		return "", false
	}
	return typed, true
}

func shouldOmitExportField(table string, field string) bool {
	return sensitiveExportFields[field] ||
		(table == "security_logs" && field == "ip_address") ||
		(table == "email_templates" && field == "updated_by")
}

func normalizeExportValue(field string, value any) any {
	switch typed := value.(type) {
	case []byte:
		if json.Valid(typed) {
			var decoded any
			if err := json.Unmarshal(typed, &decoded); err == nil {
				return redact.Value(field, decoded)
			}
		}
		return redact.Value(field, string(typed))
	default:
		return redact.Value(field, typed)
	}
}

func normalizeImportValue(value any) any {
	switch typed := value.(type) {
	case map[string]any, []any:
		data, err := json.Marshal(typed)
		if err != nil {
			return nil
		}
		return string(data)
	default:
		return typed
	}
}

func safeTableName(value string) bool {
	return adminsettingsapp.DisplayNameForTable(value) != value && safeColumnName(value)
}

func safeColumnName(value string) bool {
	if value == "" {
		return false
	}
	for index, r := range value {
		if index == 0 {
			if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && r != '_' {
				return false
			}
			continue
		}
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' {
			return false
		}
	}
	return true
}
