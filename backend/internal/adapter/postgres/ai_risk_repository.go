package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	airiskapp "mathstudy/backend/internal/application/airisk"
)

// AIRiskRepository persists student AI controls, usage, and risk events.
type AIRiskRepository struct {
	Repository
}

// NewAIRiskRepository creates a PostgreSQL-backed AI risk repository.
func NewAIRiskRepository(db Querier) (AIRiskRepository, error) {
	base, err := NewRepository(db)
	if err != nil {
		return AIRiskRepository{}, err
	}
	return AIRiskRepository{Repository: base}, nil
}

// GetSettings returns requested system setting values.
func (r AIRiskRepository) GetSettings(ctx context.Context, keys []string) (map[string]string, error) {
	rows, err := r.DB().Query(ctx, `
		SELECT key, value
		FROM public.system_settings
		WHERE key = ANY($1)`, keys)
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

// UpsertSettings updates all risk settings atomically.
func (r AIRiskRepository) UpsertSettings(ctx context.Context, updates []airiskapp.SettingUpdate) error {
	return withRepositoryTx(ctx, "AI risk settings", r.Repository, func(base Repository) AIRiskRepository {
		return AIRiskRepository{Repository: base}
	}, func(current AIRiskRepository) error {
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

// GetStudentAccess returns an account's AI-only access state.
func (r AIRiskRepository) GetStudentAccess(ctx context.Context, studentID string) (airiskapp.StudentAccess, bool, error) {
	var access airiskapp.StudentAccess
	var role string
	var reason pgtype.Text
	var blockedAt pgtype.Timestamp
	err := r.DB().QueryRow(ctx, `
		SELECT
			u.id,
			u.username,
			u.role::text,
			coalesce(c.is_blocked, false),
			c.blocked_reason,
			c.blocked_at
		FROM public.users u
		LEFT JOIN public.student_ai_access_controls c ON c.student_id = u.id
		WHERE u.id = $1`, studentID).Scan(
		&access.StudentID,
		&access.Username,
		&role,
		&access.IsBlocked,
		&reason,
		&blockedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return airiskapp.StudentAccess{}, false, nil
		}
		return airiskapp.StudentAccess{}, false, err
	}
	access.IsStudent = role == "STUDENT"
	if reason.Valid {
		access.BlockedReason = reason.String
	}
	access.BlockedAt = timestampPtr(blockedAt)
	return access, true, nil
}

// CountReplies returns delivered metered AI replies for one local day.
func (r AIRiskRepository) CountReplies(ctx context.Context, studentID, usageDate string) (int, error) {
	var count int
	err := r.DB().QueryRow(ctx, `
		SELECT count(*)::int
		FROM public.student_ai_reply_usage
		WHERE student_id = $1 AND usage_date = $2::date`, studentID, usageDate).Scan(&count)
	return count, err
}

// InsertReplyUsage records a delivered non-session AI response in the shared quota ledger.
func (r AIRiskRepository) InsertReplyUsage(ctx context.Context, usage airiskapp.ReplyUsage) error {
	_, err := r.DB().Exec(ctx, `
		INSERT INTO public.student_ai_reply_usage (
			id, student_id, session_id, message_id, usage_date, created_at
		)
		VALUES ($1, $2, NULL, $1, $3::date, $4)`,
		usage.ID,
		usage.StudentID,
		usage.UsageDate,
		usage.CreatedAt,
	)
	return err
}

// Overview returns risk-center counters for one local day.
func (r AIRiskRepository) Overview(ctx context.Context, usageDate string, dailyLimit int) (airiskapp.Overview, error) {
	var overview airiskapp.Overview
	err := r.DB().QueryRow(ctx, `
		SELECT
			(SELECT count(*)::int FROM public.users WHERE role = 'STUDENT'::public.userrole),
			(SELECT count(*)::int FROM public.student_ai_access_controls WHERE is_blocked = true),
			(SELECT count(*)::int FROM (
				SELECT student_id
				FROM public.student_ai_reply_usage
				WHERE usage_date = $1::date
				GROUP BY student_id
				HAVING count(*) >= $2
			) exhausted),
			(SELECT count(*)::int FROM public.student_ai_reply_usage WHERE usage_date = $1::date),
			(SELECT count(*)::int FROM public.student_ai_risk_events WHERE event_date = $1::date)`,
		usageDate,
		dailyLimit,
	).Scan(
		&overview.TotalStudents,
		&overview.BlockedStudents,
		&overview.QuotaExhaustedStudents,
		&overview.RepliesToday,
		&overview.RiskEventsToday,
	)
	return overview, err
}

// ListStudents returns student controls and usage for one local day.
func (r AIRiskRepository) ListStudents(ctx context.Context, filter airiskapp.StudentListFilter) ([]airiskapp.StudentItem, int, error) {
	args := []any{filter.UsageDate}
	conditions := []string{"1 = 1"}
	if filter.Search != "" {
		args = append(args, "%"+filter.Search+"%")
		placeholder := fmt.Sprintf("$%d", len(args))
		conditions = append(conditions, "(username ILIKE "+placeholder+" OR email ILIKE "+placeholder+" OR coalesce(display_name, '') ILIKE "+placeholder+")")
	}
	switch filter.Status {
	case "active":
		conditions = append(conditions, "ai_blocked = false")
	case "blocked":
		conditions = append(conditions, "ai_blocked = true")
	case "quota_exhausted":
		args = append(args, filter.DailyLimit)
		conditions = append(conditions, fmt.Sprintf("replies_used >= $%d", len(args)))
	}
	args = append(args, filter.PageSize, (filter.Page-1)*filter.PageSize)
	limitPlaceholder := fmt.Sprintf("$%d", len(args)-1)
	offsetPlaceholder := fmt.Sprintf("$%d", len(args))

	rows, err := r.DB().Query(ctx, `
		WITH usage AS (
			SELECT student_id, count(*)::int AS replies_used, max(created_at) AS last_ai_reply_at
			FROM public.student_ai_reply_usage
			WHERE usage_date = $1::date
			GROUP BY student_id
		), student_rows AS (
			SELECT
				u.id,
				u.username,
				u.email,
				u.display_name,
				coalesce(c.is_blocked, false) AS ai_blocked,
				c.blocked_reason,
				c.blocked_at,
				coalesce(usage.replies_used, 0)::int AS replies_used,
				usage.last_ai_reply_at
			FROM public.users u
			LEFT JOIN public.student_ai_access_controls c ON c.student_id = u.id
			LEFT JOIN usage ON usage.student_id = u.id
			WHERE u.role = 'STUDENT'::public.userrole
		)
		SELECT
			id,
			username,
			email,
			display_name,
			ai_blocked,
			blocked_reason,
			blocked_at,
			replies_used,
			last_ai_reply_at,
			count(*) OVER()::int
		FROM student_rows
		WHERE `+strings.Join(conditions, " AND ")+`
		ORDER BY ai_blocked DESC, replies_used DESC, username ASC
		LIMIT `+limitPlaceholder+` OFFSET `+offsetPlaceholder,
		args...,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []airiskapp.StudentItem{}
	total := 0
	for rows.Next() {
		var item airiskapp.StudentItem
		var displayName, reason pgtype.Text
		var blockedAt, lastReply pgtype.Timestamp
		if err := rows.Scan(
			&item.ID,
			&item.Username,
			&item.Email,
			&displayName,
			&item.AIBlocked,
			&reason,
			&blockedAt,
			&item.RepliesUsed,
			&lastReply,
			&total,
		); err != nil {
			return nil, 0, err
		}
		item.DisplayName = textPtr(displayName)
		if reason.Valid {
			item.BlockedReason = reason.String
		}
		item.BlockedAt = timestampPtr(blockedAt)
		item.LastAIReplyAt = timestampPtr(lastReply)
		items = append(items, item)
	}
	return items, total, rows.Err()
}

// SetStudentAccess updates AI-only access and writes an administrator event atomically.
func (r AIRiskRepository) SetStudentAccess(ctx context.Context, mutation airiskapp.StudentAccessMutation) (airiskapp.StudentAccessResponse, bool, error) {
	var response airiskapp.StudentAccessResponse
	found := false
	err := withRepositoryTx(ctx, "student AI access", r.Repository, func(base Repository) AIRiskRepository {
		return AIRiskRepository{Repository: base}
	}, func(current AIRiskRepository) error {
		var username, role string
		if err := current.DB().QueryRow(ctx, `
			SELECT username, role::text
			FROM public.users
			WHERE id = $1`, mutation.StudentID).Scan(&username, &role); err != nil {
			if err == pgx.ErrNoRows {
				return nil
			}
			return err
		}
		if role != "STUDENT" {
			return nil
		}
		found = true
		var reason any
		var blockedAt any
		var blockedBy any
		if mutation.Blocked {
			reason = mutation.Reason
			blockedAt = mutation.Now
			blockedBy = mutation.ActorID
		}
		if _, err := current.DB().Exec(ctx, `
			INSERT INTO public.student_ai_access_controls (
				student_id, is_blocked, blocked_reason, blocked_at, blocked_by, updated_at
			)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (student_id) DO UPDATE
			SET is_blocked = EXCLUDED.is_blocked,
				blocked_reason = EXCLUDED.blocked_reason,
				blocked_at = EXCLUDED.blocked_at,
				blocked_by = EXCLUDED.blocked_by,
				updated_at = EXCLUDED.updated_at`,
			mutation.StudentID,
			mutation.Blocked,
			reason,
			blockedAt,
			blockedBy,
			mutation.Now,
		); err != nil {
			return err
		}
		studentID := mutation.StudentID
		actorID := mutation.ActorID
		eventType := "admin_unblocked"
		action := "access_restored"
		severity := "info"
		if mutation.Blocked {
			eventType = "admin_blocked"
			action = "access_blocked"
			severity = "warning"
		}
		if err := current.insertRiskEvent(ctx, airiskapp.RiskEvent{
			ID:              mutation.EventID,
			StudentID:       &studentID,
			StudentUsername: username,
			EventType:       eventType,
			Severity:        severity,
			Action:          action,
			Source:          "admin_risk_center",
			ContentExcerpt:  mutation.Reason,
			ActorID:         &actorID,
			EventDate:       mutation.EventDate,
			CreatedAt:       mutation.Now,
		}); err != nil {
			return err
		}
		response = airiskapp.StudentAccessResponse{
			StudentID:     mutation.StudentID,
			AIBlocked:     mutation.Blocked,
			BlockedReason: mutation.Reason,
		}
		if mutation.Blocked {
			blocked := mutation.Now
			response.BlockedAt = &blocked
		}
		return nil
	})
	return response, found, err
}

// InsertRiskEvent persists one runtime risk event.
func (r AIRiskRepository) InsertRiskEvent(ctx context.Context, event airiskapp.RiskEvent) error {
	return r.insertRiskEvent(ctx, event)
}

func (r AIRiskRepository) insertRiskEvent(ctx context.Context, event airiskapp.RiskEvent) error {
	categoryScores := event.CategoryScores
	if categoryScores == nil {
		categoryScores = map[string]float64{}
	}
	categoryScoresJSON, err := json.Marshal(categoryScores)
	if err != nil {
		return fmt.Errorf("marshal AI risk category scores: %w", err)
	}
	_, err = r.DB().Exec(ctx, `
		INSERT INTO public.student_ai_risk_events (
			id,
			student_id,
			student_username,
			event_type,
			severity,
			action,
			source,
			matched_rule,
			content_excerpt,
			content_hash,
			review_model,
			risk_score,
			category_scores,
			review_latency_ms,
			actor_id,
			event_date,
			created_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16::date, $17)`,
		event.ID,
		event.StudentID,
		event.StudentUsername,
		event.EventType,
		event.Severity,
		event.Action,
		event.Source,
		event.MatchedRule,
		event.ContentExcerpt,
		event.ContentHash,
		event.ReviewModel,
		event.RiskScore,
		string(categoryScoresJSON),
		event.ReviewLatencyMS,
		event.ActorID,
		event.EventDate,
		event.CreatedAt,
	)
	return err
}

// ListRiskEvents returns filtered risk events in reverse chronological order.
func (r AIRiskRepository) ListRiskEvents(ctx context.Context, filter airiskapp.EventListFilter) ([]airiskapp.RiskEvent, int, error) {
	conditions := []string{"1 = 1"}
	args := []any{}
	if filter.Search != "" {
		args = append(args, "%"+filter.Search+"%")
		placeholder := fmt.Sprintf("$%d", len(args))
		conditions = append(conditions, "(student_username ILIKE "+placeholder+" OR matched_rule ILIKE "+placeholder+" OR content_excerpt ILIKE "+placeholder+" OR review_model ILIKE "+placeholder+")")
	}
	if filter.EventType != "" {
		args = append(args, filter.EventType)
		conditions = append(conditions, fmt.Sprintf("event_type = $%d", len(args)))
	}
	where := strings.Join(conditions, " AND ")
	var total int
	if err := r.DB().QueryRow(ctx, `SELECT count(*)::int FROM public.student_ai_risk_events WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args = append(args, filter.PageSize, (filter.Page-1)*filter.PageSize)
	limitPlaceholder := fmt.Sprintf("$%d", len(args)-1)
	offsetPlaceholder := fmt.Sprintf("$%d", len(args))
	rows, err := r.DB().Query(ctx, `
		SELECT
			id,
			student_id,
			student_username,
			event_type,
			severity,
			action,
			source,
			matched_rule,
			content_excerpt,
			review_model,
			risk_score,
			category_scores,
			review_latency_ms,
			actor_id,
			created_at
		FROM public.student_ai_risk_events
		WHERE `+where+`
		ORDER BY created_at DESC, id DESC
		LIMIT `+limitPlaceholder+` OFFSET `+offsetPlaceholder,
		args...,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []airiskapp.RiskEvent{}
	for rows.Next() {
		var event airiskapp.RiskEvent
		var studentID, actorID pgtype.Text
		var riskScore pgtype.Float8
		var reviewLatency pgtype.Int4
		var categoryScoresJSON []byte
		if err := rows.Scan(
			&event.ID,
			&studentID,
			&event.StudentUsername,
			&event.EventType,
			&event.Severity,
			&event.Action,
			&event.Source,
			&event.MatchedRule,
			&event.ContentExcerpt,
			&event.ReviewModel,
			&riskScore,
			&categoryScoresJSON,
			&reviewLatency,
			&actorID,
			&event.CreatedAt,
		); err != nil {
			return nil, 0, err
		}
		event.StudentID = textPtr(studentID)
		event.ActorID = textPtr(actorID)
		if riskScore.Valid {
			score := riskScore.Float64
			event.RiskScore = &score
		}
		if reviewLatency.Valid {
			latency := int(reviewLatency.Int32)
			event.ReviewLatencyMS = &latency
		}
		event.CategoryScores = map[string]float64{}
		if len(categoryScoresJSON) > 0 {
			if err := json.Unmarshal(categoryScoresJSON, &event.CategoryScores); err != nil {
				return nil, 0, fmt.Errorf("decode AI risk category scores: %w", err)
			}
		}
		items = append(items, event)
	}
	return items, total, rows.Err()
}
