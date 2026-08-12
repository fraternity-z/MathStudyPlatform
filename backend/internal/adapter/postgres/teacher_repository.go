package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"mathstudy/backend/internal/application/learningrange"
	teacherapp "mathstudy/backend/internal/application/teacher"
	"mathstudy/backend/internal/platform/timefmt"
)

// TeacherRepository persists teacher analytics read models in PostgreSQL.
type TeacherRepository struct {
	Repository
}

// NewTeacherRepository creates a PostgreSQL-backed teacher repository.
func NewTeacherRepository(db Querier) (TeacherRepository, error) {
	base, err := NewRepository(db)
	if err != nil {
		return TeacherRepository{}, err
	}
	return TeacherRepository{Repository: base}, nil
}

// ListAnalyticsStudents returns the shared per-student read model for teacher analytics views.
// An empty classID selects all classes owned by the teacher; scopeOwned is false only when a
// non-empty classID is not owned by the teacher.
func (r TeacherRepository) ListAnalyticsStudents(
	ctx context.Context,
	teacherID string,
	classID string,
	rangeStart time.Time,
	weekStart time.Time,
) ([]teacherapp.AnalyticsStudentReadModel, bool, error) {
	rows, err := r.DB().Query(ctx, `
		WITH owned_classes AS (
			SELECT id
			FROM public.classes
			WHERE teacher_id = $1 AND ($2 = '' OR id = $2)
		), scope_status AS (
			SELECT CASE WHEN $2 = '' THEN true ELSE EXISTS(SELECT 1 FROM owned_classes) END AS owned
		), scoped_students AS (
			SELECT ce.student_id, max(ce.joined_at) AS joined_at
			FROM public.class_enrollments ce
			JOIN owned_classes c ON c.id = ce.class_id
			GROUP BY ce.student_id
		), scoped_attempts AS (
			SELECT ca.student_id, ca.score, ca.started_at, ca.time_spent_seconds
			FROM public.content_attempts ca
			JOIN public.contents c ON c.id = ca.content_id
			JOIN scoped_students ss ON ss.student_id = ca.student_id
			WHERE c.owner_teacher_id = $1 AND c.generated_by_student_id IS NULL
		), attempt_stats AS (
			SELECT
				student_id,
				coalesce(sum(score) FILTER (WHERE started_at >= $3), 0)::double precision AS range_score_sum,
				(count(score) FILTER (WHERE started_at >= $3))::int AS range_attempt_count,
				coalesce(sum(time_spent_seconds) FILTER (WHERE started_at >= $3), 0)::int AS range_seconds,
				coalesce(sum(score), 0)::double precision AS all_score_sum,
				count(score)::int AS all_attempt_count,
				coalesce(sum(time_spent_seconds) FILTER (WHERE started_at >= $4), 0)::int AS weekly_seconds
			FROM scoped_attempts
			GROUP BY student_id
		), session_days AS (
			SELECT
				ls.student_id,
				jsonb_agg(DISTINCT ls.started_at::date::text ORDER BY ls.started_at::date::text) AS dates
			FROM public.learning_sessions ls
			JOIN scoped_students ss ON ss.student_id = ls.student_id
			WHERE ls.started_at >= $4
			GROUP BY ls.student_id
		)
		SELECT
			scope_status.owned,
			ss.student_id,
			sp.student_id IS NOT NULL AS has_profile,
			coalesce(sp.mastery_vector, '{}'::json),
			coalesce(sp.total_exercises, 0),
			coalesce(sp.correct_count, 0),
			coalesce(sp.total_study_time_minutes, 0),
			coalesce(nullif(btrim(u.display_name), ''), u.username, '未知'),
			coalesce(stats.range_score_sum, 0),
			coalesce(stats.range_attempt_count, 0),
			coalesce(stats.range_seconds, 0),
			coalesce(stats.all_score_sum, 0),
			coalesce(stats.all_attempt_count, 0),
			coalesce(stats.weekly_seconds, 0),
			coalesce(session_days.dates, '[]'::jsonb)
		FROM scope_status
		LEFT JOIN scoped_students ss ON scope_status.owned
		LEFT JOIN public.users u ON u.id = ss.student_id
		LEFT JOIN public.student_profiles sp ON sp.student_id = ss.student_id
		LEFT JOIN attempt_stats stats ON stats.student_id = ss.student_id
		LEFT JOIN session_days ON session_days.student_id = ss.student_id
		ORDER BY ss.joined_at DESC NULLS LAST, ss.student_id DESC`,
		teacherID,
		strings.TrimSpace(classID),
		rangeStart,
		weekStart,
	)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	students := []teacherapp.AnalyticsStudentReadModel{}
	scopeOwned := false
	for rows.Next() {
		var owned bool
		var studentID pgtype.Text
		var masteryRaw []byte
		var sessionDatesRaw []byte
		var student teacherapp.AnalyticsStudentReadModel
		if err := rows.Scan(
			&owned,
			&studentID,
			&student.HasProfile,
			&masteryRaw,
			&student.Profile.TotalExercises,
			&student.Profile.CorrectCount,
			&student.Profile.TotalStudyTimeMinutes,
			&student.DisplayName,
			&student.RangeScoreSum,
			&student.RangeAttemptCount,
			&student.RangeSeconds,
			&student.AllScoreSum,
			&student.AllAttemptCount,
			&student.WeeklySeconds,
			&sessionDatesRaw,
		); err != nil {
			return nil, false, err
		}
		scopeOwned = owned
		if !studentID.Valid {
			continue
		}
		student.StudentID = studentID.String
		student.Profile.StudentID = student.StudentID
		mastery, err := decodeFloatMap(masteryRaw)
		if err != nil {
			return nil, false, fmt.Errorf("decode analytics mastery vector: %w", err)
		}
		student.Profile.MasteryVector = mastery
		if err := json.Unmarshal(sessionDatesRaw, &student.WeeklySessionDates); err != nil {
			return nil, false, fmt.Errorf("decode analytics session dates: %w", err)
		}
		students = append(students, student)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return students, scopeOwned, nil
}

// ListTeacherClassIDs returns all class IDs owned by a teacher.
func (r TeacherRepository) ListTeacherClassIDs(ctx context.Context, teacherID string) ([]string, error) {
	rows, err := r.DB().Query(ctx, `
		SELECT id
		FROM public.classes
		WHERE teacher_id = $1
		ORDER BY created_at DESC, id DESC`,
		teacherID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanStringColumn(rows)
}

// ListStudentsInClasses returns all student IDs enrolled in any of the provided classes.
func (r TeacherRepository) ListStudentsInClasses(ctx context.Context, classIDs []string) ([]string, error) {
	if len(classIDs) == 0 {
		return []string{}, nil
	}
	rows, err := r.DB().Query(ctx, `
		SELECT student_id
		FROM public.class_enrollments
		WHERE class_id = ANY($1::varchar[])
		ORDER BY joined_at DESC, student_id DESC`,
		classIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanStringColumn(rows)
}

// ListTeacherStudents returns a paginated student list across teacher-owned classes.
func (r TeacherRepository) ListTeacherStudents(ctx context.Context, teacherID string, filter teacherapp.StudentListFilter) ([]teacherapp.StudentListItem, int, error) {
	classID := strings.TrimSpace(filter.ClassID)
	search := strings.TrimSpace(filter.Search)
	var total int
	if err := r.DB().QueryRow(ctx, `
		SELECT count(*)::int
		FROM public.class_enrollments ce
		JOIN public.classes c ON c.id = ce.class_id
		JOIN public.users u ON u.id = ce.student_id
		WHERE
			c.teacher_id = $1 AND
			($2 = '' OR c.id = $2) AND
			($3 = '' OR (
				lower(u.username) LIKE '%' || lower($3) || '%' OR
				lower(u.email) LIKE '%' || lower($3) || '%' OR
				lower(coalesce(u.display_name, '')) LIKE '%' || lower($3) || '%'
			))`,
		teacherID,
		classID,
		search,
	).Scan(&total); err != nil {
		return nil, 0, err
	}
	if total == 0 {
		return []teacherapp.StudentListItem{}, 0, nil
	}

	rows, err := r.DB().Query(ctx, `
		SELECT
			u.id,
			u.username,
			u.email,
			u.display_name,
			c.id AS class_id,
			c.name AS class_name
		FROM public.class_enrollments ce
		JOIN public.classes c ON c.id = ce.class_id
		JOIN public.users u ON u.id = ce.student_id
		WHERE
			c.teacher_id = $1 AND
			($2 = '' OR c.id = $2) AND
			($3 = '' OR (
				lower(u.username) LIKE '%' || lower($3) || '%' OR
				lower(u.email) LIKE '%' || lower($3) || '%' OR
				lower(coalesce(u.display_name, '')) LIKE '%' || lower($3) || '%'
			))
		ORDER BY c.name, coalesce(u.display_name, u.username), u.id
		LIMIT $4 OFFSET $5`,
		teacherID,
		classID,
		search,
		filter.PageSize,
		(filter.Page-1)*filter.PageSize,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := []teacherapp.StudentListItem{}
	for rows.Next() {
		var item teacherapp.StudentListItem
		var displayName pgtype.Text
		if err := rows.Scan(&item.ID, &item.Username, &item.Email, &displayName, &item.ClassID, &item.ClassName); err != nil {
			return nil, 0, err
		}
		item.DisplayName = textPtr(displayName)
		items = append(items, item)
	}
	return items, total, rows.Err()
}

// CountActiveSessionsSince counts distinct students with learning sessions after since.
func (r TeacherRepository) CountActiveSessionsSince(ctx context.Context, studentIDs []string, since time.Time) (int, error) {
	if len(studentIDs) == 0 {
		return 0, nil
	}
	var count int
	err := r.DB().QueryRow(ctx, `
		SELECT count(DISTINCT student_id)::int
		FROM public.learning_sessions
		WHERE student_id = ANY($1::varchar[]) AND started_at >= $2`,
		studentIDs,
		since,
	).Scan(&count)
	return count, err
}

// AverageAttemptScore returns the average score on teacher-owned content, optionally after since.
func (r TeacherRepository) AverageAttemptScore(ctx context.Context, teacherID string, studentIDs []string, since *time.Time) (float64, bool, error) {
	if len(studentIDs) == 0 {
		return 0, false, nil
	}
	query := `
		SELECT avg(ca.score)::double precision
		FROM public.content_attempts ca
		JOIN public.contents c ON c.id = ca.content_id
		WHERE c.owner_teacher_id = $1
			AND c.generated_by_student_id IS NULL
			AND ca.student_id = ANY($2::varchar[])`
	args := []any{teacherID, studentIDs}
	if since != nil {
		query += ` AND ca.started_at >= $3`
		args = append(args, *since)
	}
	var avg pgtype.Float8
	if err := r.DB().QueryRow(ctx, query, args...).Scan(&avg); err != nil {
		return 0, false, err
	}
	return avg.Float64, avg.Valid, nil
}

// KnowledgeNames returns a concept ID to name map.
func (r TeacherRepository) KnowledgeNames(ctx context.Context, conceptIDs []string) (map[string]string, error) {
	names := map[string]string{}
	if len(conceptIDs) == 0 {
		return names, nil
	}
	rows, err := r.DB().Query(ctx, `
		SELECT id, name
		FROM public.knowledge_nodes
		WHERE id = ANY($1::varchar[])`,
		conceptIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		names[id] = name
	}
	return names, rows.Err()
}

// ClassOwnedByTeacher reports whether classID belongs to teacherID.
func (r TeacherRepository) ClassOwnedByTeacher(ctx context.Context, teacherID string, classID string) (bool, error) {
	return r.Exists(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM public.classes
			WHERE id = $1 AND teacher_id = $2
		)`,
		classID,
		teacherID,
	)
}

// CommonErrors returns grouped diagnosis reports for teacher-owned content.
func (r TeacherRepository) CommonErrors(ctx context.Context, teacherID string, studentIDs []string, limit int) ([]teacherapp.CommonErrorAggregate, error) {
	if len(studentIDs) == 0 || limit <= 0 {
		return []teacherapp.CommonErrorAggregate{}, nil
	}
	rows, err := r.DB().Query(ctx, `
		SELECT
			dr.error_type::text,
			dr.error_subtype,
			dr.explanation,
			count(*)::int AS cnt
		FROM public.diagnosis_reports dr
		JOIN public.content_attempts ca ON ca.id = dr.attempt_id
		JOIN public.contents c ON c.id = ca.content_id
		WHERE c.owner_teacher_id = $1
			AND c.generated_by_student_id IS NULL
			AND ca.student_id = ANY($2::varchar[])
			AND dr.error_type IS NOT NULL
		GROUP BY dr.error_type, dr.error_subtype, dr.explanation
		ORDER BY cnt DESC, dr.error_type::text
		LIMIT $3`,
		teacherID,
		studentIDs,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []teacherapp.CommonErrorAggregate{}
	for rows.Next() {
		var errorType string
		var subtype pgtype.Text
		var explanation pgtype.Text
		var count int
		if err := rows.Scan(&errorType, &subtype, &explanation, &count); err != nil {
			return nil, err
		}
		content := "未知错误"
		if explanation.Valid && strings.TrimSpace(explanation.String) != "" {
			content = explanation.String
		} else if subtype.Valid && strings.TrimSpace(subtype.String) != "" {
			content = subtype.String
		}
		topic := "未分类"
		if subtype.Valid && strings.TrimSpace(subtype.String) != "" {
			topic = subtype.String
		}
		items = append(items, teacherapp.CommonErrorAggregate{
			Content:   content,
			Count:     count,
			Topic:     topic,
			ErrorType: errorType,
		})
	}
	return items, rows.Err()
}

// LowScoreStudents returns students whose teacher-owned average score is below maxAverage.
func (r TeacherRepository) LowScoreStudents(ctx context.Context, teacherID string, studentIDs []string, maxAverage float64) (map[string]float64, error) {
	result := map[string]float64{}
	if len(studentIDs) == 0 {
		return result, nil
	}
	rows, err := r.DB().Query(ctx, `
		SELECT ca.student_id, avg(ca.score)::double precision AS avg_score
		FROM public.content_attempts ca
		JOIN public.contents c ON c.id = ca.content_id
		WHERE c.owner_teacher_id = $1
			AND c.generated_by_student_id IS NULL
			AND ca.student_id = ANY($2::varchar[])
		GROUP BY ca.student_id
		HAVING avg(ca.score) < $3
		ORDER BY ca.student_id`,
		teacherID,
		studentIDs,
		maxAverage,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var studentID string
		var avgScore float64
		if err := rows.Scan(&studentID, &avgScore); err != nil {
			return nil, err
		}
		result[studentID] = avgScore
	}
	return result, rows.Err()
}

// ActiveStudentIDsSince returns students with learning sessions after since.
func (r TeacherRepository) ActiveStudentIDsSince(ctx context.Context, studentIDs []string, since time.Time) (map[string]struct{}, error) {
	result := map[string]struct{}{}
	if len(studentIDs) == 0 {
		return result, nil
	}
	rows, err := r.DB().Query(ctx, `
		SELECT DISTINCT student_id
		FROM public.learning_sessions
		WHERE student_id = ANY($1::varchar[]) AND started_at >= $2`,
		studentIDs,
		since,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var studentID string
		if err := rows.Scan(&studentID); err != nil {
			return nil, err
		}
		result[studentID] = struct{}{}
	}
	return result, rows.Err()
}

// StudentEnrollmentForTeacher returns a student enrollment under one teacher.
func (r TeacherRepository) StudentEnrollmentForTeacher(ctx context.Context, teacherID string, studentID string) (teacherapp.StudentEnrollment, bool, error) {
	row := r.DB().QueryRow(ctx, `
		SELECT ce.class_id, c.name, ce.joined_at
		FROM public.class_enrollments ce
		JOIN public.classes c ON c.id = ce.class_id
		WHERE ce.student_id = $1 AND c.teacher_id = $2
		ORDER BY ce.joined_at DESC
		LIMIT 1`,
		studentID,
		teacherID,
	)
	var enrollment teacherapp.StudentEnrollment
	var joinedAt pgtype.Timestamp
	if err := row.Scan(&enrollment.ClassID, &enrollment.ClassName, &joinedAt); err != nil {
		if err == pgx.ErrNoRows {
			return teacherapp.StudentEnrollment{}, false, nil
		}
		return teacherapp.StudentEnrollment{}, false, err
	}
	enrollment.JoinedAt = timestampPtr(joinedAt)
	return enrollment, true, nil
}

// GetUser returns one user by ID.
func (r TeacherRepository) GetUser(ctx context.Context, userID string) (teacherapp.UserInfo, bool, error) {
	row := r.DB().QueryRow(ctx, `
		SELECT id, username, email, display_name
		FROM public.users
		WHERE id = $1`,
		userID,
	)
	var user teacherapp.UserInfo
	var displayName pgtype.Text
	if err := row.Scan(&user.ID, &user.Username, &user.Email, &displayName); err != nil {
		if err == pgx.ErrNoRows {
			return teacherapp.UserInfo{}, false, nil
		}
		return teacherapp.UserInfo{}, false, err
	}
	user.DisplayName = textPtr(displayName)
	return user, true, nil
}

// GetProfile returns one student profile with counters scoped to teacher-owned content.
func (r TeacherRepository) GetProfile(ctx context.Context, teacherID string, studentID string) (teacherapp.StudentProfile, bool, error) {
	row := r.DB().QueryRow(ctx, `
		SELECT
			sp.student_id,
			sp.mastery_vector,
			attempt_stats.total_exercises,
			attempt_stats.correct_count,
			attempt_stats.total_study_time_minutes
		FROM public.student_profiles sp
		CROSS JOIN LATERAL (
			SELECT
				count(ca.id)::int AS total_exercises,
				(count(ca.id) FILTER (WHERE ca.is_correct))::int AS correct_count,
				(coalesce(sum(ca.time_spent_seconds), 0) / 60)::int AS total_study_time_minutes
			FROM public.content_attempts ca
			JOIN public.contents c ON c.id = ca.content_id
			WHERE c.owner_teacher_id = $1
				AND c.generated_by_student_id IS NULL
				AND ca.student_id = sp.student_id
		) attempt_stats
		WHERE sp.student_id = $2`,
		teacherID,
		studentID,
	)
	profile, err := scanTeacherProfile(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			return teacherapp.StudentProfile{}, false, nil
		}
		return teacherapp.StudentProfile{}, false, err
	}
	return profile, true, nil
}

// AverageStudentScore returns one student's average score on teacher-owned content.
func (r TeacherRepository) AverageStudentScore(ctx context.Context, teacherID string, studentID string) (float64, bool, error) {
	var avg pgtype.Float8
	err := r.DB().QueryRow(ctx, `
		SELECT avg(ca.score)::double precision
		FROM public.content_attempts ca
		JOIN public.contents c ON c.id = ca.content_id
		WHERE c.owner_teacher_id = $1
			AND c.generated_by_student_id IS NULL
			AND ca.student_id = $2`,
		teacherID,
		studentID,
	).Scan(&avg)
	if err != nil {
		return 0, false, err
	}
	return avg.Float64, avg.Valid, nil
}

// RankByAverageScore returns students ranked by their teacher-owned average score.
func (r TeacherRepository) RankByAverageScore(ctx context.Context, teacherID string, studentIDs []string) ([]teacherapp.StudentScore, error) {
	if len(studentIDs) == 0 {
		return []teacherapp.StudentScore{}, nil
	}
	rows, err := r.DB().Query(ctx, `
		SELECT ca.student_id, avg(ca.score)::double precision AS avg_score
		FROM public.content_attempts ca
		JOIN public.contents c ON c.id = ca.content_id
		WHERE c.owner_teacher_id = $1
			AND c.generated_by_student_id IS NULL
			AND ca.student_id = ANY($2::varchar[])
		GROUP BY ca.student_id
		ORDER BY avg_score DESC, ca.student_id`,
		teacherID,
		studentIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanStudentScores(rows)
}

// LastSessionStartedAt returns the latest learning session time.
func (r TeacherRepository) LastSessionStartedAt(ctx context.Context, studentID string) (*time.Time, error) {
	var latest pgtype.Timestamp
	if err := r.DB().QueryRow(ctx, `
		SELECT max(started_at)
		FROM public.learning_sessions
		WHERE student_id = $1`,
		studentID,
	).Scan(&latest); err != nil {
		return nil, err
	}
	if !latest.Valid {
		return nil, nil
	}
	value := latest.Time
	return &value, nil
}

// ListSessionDays returns distinct learning session days, newest first.
func (r TeacherRepository) ListSessionDays(ctx context.Context, studentID string) ([]time.Time, error) {
	rows, err := r.DB().Query(ctx, `
		SELECT date_trunc('day', started_at) AS day
		FROM public.learning_sessions
		WHERE student_id = $1
		GROUP BY day
		ORDER BY day DESC`,
		studentID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	days := []time.Time{}
	for rows.Next() {
		var day time.Time
		if err := rows.Scan(&day); err != nil {
			return nil, err
		}
		days = append(days, day)
	}
	return days, rows.Err()
}

// AttemptConceptCounts counts teacher-owned attempted content concept IDs for one student.
func (r TeacherRepository) AttemptConceptCounts(ctx context.Context, teacherID string, studentID string) (map[string]int, error) {
	counts := map[string]int{}
	rows, err := r.DB().Query(ctx, `
		SELECT c.concept_ids
		FROM public.contents c
		JOIN public.content_attempts ca ON ca.content_id = c.id
		WHERE c.owner_teacher_id = $1
			AND c.generated_by_student_id IS NULL
			AND ca.student_id = $2`,
		teacherID,
		studentID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		concepts, err := decodeStringSlice(raw)
		if err != nil {
			return nil, fmt.Errorf("decode attempted concept ids: %w", err)
		}
		for _, concept := range concepts {
			counts[concept]++
		}
	}
	return counts, rows.Err()
}

// RecentAttempts returns the latest attempt activity on teacher-owned content.
func (r TeacherRepository) RecentAttempts(ctx context.Context, teacherID string, studentID string, limit int) ([]teacherapp.RecentAttempt, error) {
	if limit <= 0 {
		return []teacherapp.RecentAttempt{}, nil
	}
	rows, err := r.DB().Query(ctx, `
		SELECT ca.id, ca.is_correct, ca.score, ca.started_at, c.title
		FROM public.content_attempts ca
		JOIN public.contents c ON c.id = ca.content_id
		WHERE c.owner_teacher_id = $1
			AND c.generated_by_student_id IS NULL
			AND ca.student_id = $2
		ORDER BY ca.started_at DESC, ca.id DESC
		LIMIT $3`,
		teacherID,
		studentID,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	attempts := []teacherapp.RecentAttempt{}
	for rows.Next() {
		var attempt teacherapp.RecentAttempt
		if err := rows.Scan(&attempt.ID, &attempt.IsCorrect, &attempt.Score, &attempt.StartedAt, &attempt.Title); err != nil {
			return nil, err
		}
		attempts = append(attempts, attempt)
	}
	return attempts, rows.Err()
}

// RecentSessions returns the latest learning sessions.
func (r TeacherRepository) RecentSessions(ctx context.Context, studentID string, limit int) ([]teacherapp.RecentSession, error) {
	if limit <= 0 {
		return []teacherapp.RecentSession{}, nil
	}
	rows, err := r.DB().Query(ctx, `
		SELECT id, started_at, ended_at
		FROM public.learning_sessions
		WHERE student_id = $1
		ORDER BY started_at DESC, id DESC
		LIMIT $2`,
		studentID,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sessions := []teacherapp.RecentSession{}
	for rows.Next() {
		var session teacherapp.RecentSession
		var endedAt pgtype.Timestamp
		if err := rows.Scan(&session.ID, &session.StartedAt, &endedAt); err != nil {
			return nil, err
		}
		session.EndedAt = timestampPtr(endedAt)
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

// RecentMistakes returns latest incorrect attempts on teacher-owned content.
func (r TeacherRepository) RecentMistakes(ctx context.Context, teacherID string, studentID string, limit int) ([]teacherapp.StudentMistake, error) {
	if limit <= 0 {
		return []teacherapp.StudentMistake{}, nil
	}
	rows, err := r.DB().Query(ctx, `
		SELECT ca.id, ca.started_at, c.title, dr.error_type::text, dr.explanation
		FROM public.content_attempts ca
		JOIN public.contents c ON c.id = ca.content_id
		LEFT JOIN public.diagnosis_reports dr ON dr.attempt_id = ca.id
		WHERE c.owner_teacher_id = $1
			AND c.generated_by_student_id IS NULL
			AND ca.student_id = $2
			AND ca.is_correct = false
		ORDER BY ca.started_at DESC, ca.id DESC
		LIMIT $3`,
		teacherID,
		studentID,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	mistakes := []teacherapp.StudentMistake{}
	for rows.Next() {
		var id string
		var startedAt time.Time
		var title string
		var errorType pgtype.Text
		var explanation pgtype.Text
		if err := rows.Scan(&id, &startedAt, &title, &errorType, &explanation); err != nil {
			return nil, err
		}
		item := teacherapp.StudentMistake{
			ID:        id,
			Content:   title,
			ErrorType: "",
			Date:      timefmt.DateTimeRFC3339(learningrange.InPlatformZone(startedAt)),
		}
		if errorType.Valid {
			item.ErrorType = errorType.String
		}
		item.Explanation = textPtr(explanation)
		mistakes = append(mistakes, item)
	}
	return mistakes, rows.Err()
}

func scanTeacherProfile(scanner rowScanner) (teacherapp.StudentProfile, error) {
	var profile teacherapp.StudentProfile
	var masteryRaw []byte
	if err := scanner.Scan(
		&profile.StudentID,
		&masteryRaw,
		&profile.TotalExercises,
		&profile.CorrectCount,
		&profile.TotalStudyTimeMinutes,
	); err != nil {
		return teacherapp.StudentProfile{}, err
	}
	mastery, err := decodeFloatMap(masteryRaw)
	if err != nil {
		return teacherapp.StudentProfile{}, fmt.Errorf("decode teacher mastery vector: %w", err)
	}
	profile.MasteryVector = mastery
	return profile, nil
}

func scanStudentScores(rows pgx.Rows) ([]teacherapp.StudentScore, error) {
	scores := []teacherapp.StudentScore{}
	for rows.Next() {
		var score teacherapp.StudentScore
		if err := rows.Scan(&score.StudentID, &score.AvgScore); err != nil {
			return nil, err
		}
		scores = append(scores, score)
	}
	return scores, rows.Err()
}

func scanStringColumn(rows pgx.Rows) ([]string, error) {
	values := []string{}
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}
