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
	maxImportInsertBatchRows = 100
	importAttemptSavepoint   = "msp_admin_import_attempt"
)

var errImportSavepoint = errors.New("database import savepoint failure")

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
	return withRepositoryTx(ctx, "admin settings", r.Repository, func(base Repository) AdminSettingsRepository {
		return AdminSettingsRepository{Repository: base}
	}, func(current AdminSettingsRepository) error {
		for _, update := range updates {
			if _, err := current.DB().Exec(ctx, `
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
	result := adminsettingsapp.TableImportResult{}
	var batchColumns []string
	var batchRows [][]any
	batchKey := ""
	flush := func() error {
		if len(batchRows) == 0 {
			return nil
		}
		if len(batchColumns) > maxImportBatchParameters {
			return fmt.Errorf(
				"import row has %d columns, exceeding PostgreSQL parameter limit %d",
				len(batchColumns),
				maxImportBatchParameters,
			)
		}
		batchSize := min(maxImportInsertBatchRows, maxImportBatchRows, maxImportBatchParameters/len(batchColumns))
		for start := 0; start < len(batchRows); start += batchSize {
			if err := ctx.Err(); err != nil {
				return err
			}
			end := min(start+batchSize, len(batchRows))
			batchResult, err := r.importRowBatch(ctx, table, batchColumns, batchRows[start:end])
			mergeImportResult(&result, batchResult)
			if err != nil {
				return err
			}
		}
		batchRows = nil
		return nil
	}

	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		filtered := filterImportRow(table, row)
		if len(filtered) == 0 {
			if err := flush(); err != nil {
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
		if len(batchRows) > 0 && key != batchKey {
			if err := flush(); err != nil {
				return result, err
			}
		}
		if len(batchRows) == 0 {
			batchColumns = columns
			batchKey = key
		}
		values := make([]any, 0, len(columns))
		for _, column := range columns {
			values = append(values, normalizeImportValue(filtered[column]))
		}
		batchRows = append(batchRows, values)
		if len(batchRows) == maxImportInsertBatchRows {
			if err := flush(); err != nil {
				return result, err
			}
		}
	}
	if err := flush(); err != nil {
		return result, err
	}
	return result, nil
}

func (r AdminSettingsRepository) importRowBatch(
	ctx context.Context,
	table string,
	columns []string,
	rows [][]any,
) (adminsettingsapp.TableImportResult, error) {
	if len(rows) == 0 {
		return adminsettingsapp.TableImportResult{}, nil
	}
	tag, err := r.execImportRows(ctx, table, columns, rows)
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
	if errors.Is(err, errImportSavepoint) {
		return adminsettingsapp.TableImportResult{}, err
	}
	if !isImportRowDataError(err) {
		return adminsettingsapp.TableImportResult{}, err
	}
	if len(rows) == 1 {
		return adminsettingsapp.TableImportResult{Failed: 1}, nil
	}

	result := adminsettingsapp.TableImportResult{}
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		tag, rowErr := r.execImportRows(ctx, table, columns, [][]any{row})
		if ctxErr := ctx.Err(); ctxErr != nil {
			return result, ctxErr
		}
		if errors.Is(rowErr, errImportSavepoint) {
			return result, rowErr
		}
		switch {
		case rowErr != nil && !isImportRowDataError(rowErr):
			return result, rowErr
		case rowErr != nil:
			result.Failed++
		case tag.RowsAffected() > 0:
			result.Imported++
		default:
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

func (r AdminSettingsRepository) execImportRows(
	ctx context.Context,
	table string,
	columns []string,
	rows [][]any,
) (pgconn.CommandTag, error) {
	if tx, ok := r.DB().(pgx.Tx); ok {
		savepoint := pgx.Identifier{importAttemptSavepoint}.Sanitize()
		if _, err := tx.Exec(ctx, "SAVEPOINT "+savepoint); err != nil {
			return pgconn.CommandTag{}, fmt.Errorf("%w: begin: %w", errImportSavepoint, err)
		}
		tag, execErr := execImportRows(ctx, tx, table, columns, rows)
		if execErr != nil {
			if _, rollbackErr := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+savepoint); rollbackErr != nil {
				return tag, errors.Join(execErr, fmt.Errorf("%w: rollback: %w", errImportSavepoint, rollbackErr))
			}
			if _, releaseErr := tx.Exec(ctx, "RELEASE SAVEPOINT "+savepoint); releaseErr != nil {
				return tag, errors.Join(execErr, fmt.Errorf("%w: release after rollback: %w", errImportSavepoint, releaseErr))
			}
			return tag, execErr
		}
		if _, err := tx.Exec(ctx, "RELEASE SAVEPOINT "+savepoint); err != nil {
			return tag, fmt.Errorf("%w: release: %w", errImportSavepoint, err)
		}
		return tag, nil
	}
	return execImportRows(ctx, r.DB(), table, columns, rows)
}

func execImportRows(
	ctx context.Context,
	db Querier,
	table string,
	columns []string,
	rows [][]any,
) (pgconn.CommandTag, error) {
	identifiers := make([]string, 0, len(columns))
	for _, column := range columns {
		identifiers = append(identifiers, pgx.Identifier{column}.Sanitize())
	}
	valueGroups := make([]string, 0, len(rows))
	args := make([]any, 0, len(rows)*len(columns))
	for _, row := range rows {
		placeholders := make([]string, 0, len(row))
		for _, value := range row {
			args = append(args, value)
			placeholders = append(placeholders, fmt.Sprintf("$%d", len(args)))
		}
		valueGroups = append(valueGroups, "("+strings.Join(placeholders, ", ")+")")
	}
	sql := "INSERT INTO " + pgx.Identifier{"public", table}.Sanitize() +
		" (" + strings.Join(identifiers, ", ") + ") VALUES " +
		strings.Join(valueGroups, ", ") + " ON CONFLICT DO NOTHING"
	return db.Exec(ctx, sql, args...)
}

func mergeImportResult(target *adminsettingsapp.TableImportResult, addition adminsettingsapp.TableImportResult) {
	target.Imported += addition.Imported
	target.Skipped += addition.Skipped
	target.Failed += addition.Failed
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
