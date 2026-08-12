package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	teacherapp "mathstudy/backend/internal/application/teacher"
)

// GetStudentDetailSnapshot returns the teacher-scoped scalar and aggregate detail inputs.
func (r TeacherRepository) GetStudentDetailSnapshot(
	ctx context.Context,
	teacherID string,
	studentID string,
) (teacherapp.StudentDetailSnapshot, bool, error) {
	row := r.DB().QueryRow(ctx, `
		WITH enrollment AS (
			SELECT ce.class_id, c.name AS class_name, ce.joined_at
			FROM public.class_enrollments ce
			JOIN public.classes c ON c.id = ce.class_id
			WHERE ce.student_id = $2 AND c.teacher_id = $1
			ORDER BY ce.joined_at DESC
			LIMIT 1
		), teacher_attempts AS (
			SELECT ca.id, ca.student_id, ca.is_correct, ca.score,
				ca.time_spent_seconds, c.concept_ids
			FROM public.content_attempts ca
			JOIN public.contents c ON c.id = ca.content_id
			WHERE c.owner_teacher_id = $1
				AND c.generated_by_student_id IS NULL
				AND ca.student_id = $2
		), attempt_stats AS (
			SELECT
				count(id)::int AS total_exercises,
				(count(id) FILTER (WHERE is_correct))::int AS correct_count,
				(coalesce(sum(time_spent_seconds), 0) / 60)::int AS study_minutes,
				coalesce(avg(score), 0)::double precision AS average_score
			FROM teacher_attempts
		), class_scores AS (
			SELECT ca.student_id, avg(ca.score)::double precision AS average_score
			FROM public.content_attempts ca
			JOIN public.contents c ON c.id = ca.content_id
			JOIN public.class_enrollments ce ON ce.student_id = ca.student_id
			JOIN enrollment e ON e.class_id = ce.class_id
			WHERE c.owner_teacher_id = $1
				AND c.generated_by_student_id IS NULL
			GROUP BY ca.student_id
		), class_rankings AS (
			SELECT
				student_id,
				row_number() OVER (ORDER BY average_score DESC, student_id)::int AS position
			FROM class_scores
		), session_stats AS (
			SELECT
				max(started_at) AS last_active,
				coalesce(
					json_agg(
						DISTINCT to_char(started_at::date, 'YYYY-MM-DD')
						ORDER BY to_char(started_at::date, 'YYYY-MM-DD')
					),
					'[]'::json
				) AS session_days
			FROM public.learning_sessions
			WHERE student_id = $2
		), concept_rows AS (
			SELECT concept.value AS concept_id
			FROM teacher_attempts attempt
			CROSS JOIN LATERAL json_array_elements_text(
				CASE json_typeof(attempt.concept_ids)
					WHEN 'array' THEN attempt.concept_ids
					WHEN 'string' THEN json_build_array(attempt.concept_ids)
					ELSE '[]'::json
				END
			) concept(value)
			WHERE nullif(btrim(concept.value), '') IS NOT NULL
		), concept_counts AS (
			SELECT concept_id, count(*)::int AS attempt_count
			FROM concept_rows
			GROUP BY concept_id
		), mastery_concepts AS (
			SELECT mastery.key AS concept_id
			FROM public.student_profiles sp
			CROSS JOIN LATERAL json_each_text(
				CASE
					WHEN json_typeof(sp.mastery_vector) = 'object' THEN sp.mastery_vector
					ELSE '{}'::json
				END
			) mastery
			WHERE sp.student_id = $2
		)
		SELECT
			e.class_id,
			e.class_name,
			e.joined_at,
			coalesce(u.id, ''),
			coalesce(u.username, ''),
			coalesce(u.email, ''),
			u.display_name,
			sp.student_id IS NOT NULL,
			coalesce(sp.mastery_vector, '{}'::json),
			CASE WHEN sp.student_id IS NULL THEN 0 ELSE stats.total_exercises END,
			CASE WHEN sp.student_id IS NULL THEN 0 ELSE stats.correct_count END,
			CASE WHEN sp.student_id IS NULL THEN 0 ELSE stats.study_minutes END,
			stats.average_score,
			coalesce((SELECT position FROM class_rankings WHERE student_id = $2), 0)::int,
			(SELECT count(*)::int FROM public.class_enrollments ce WHERE ce.class_id = e.class_id),
			sessions.last_active,
			sessions.session_days,
			coalesce((SELECT json_object_agg(concept_id, attempt_count) FROM concept_counts), '{}'::json),
			coalesce((
				SELECT json_object_agg(mastery.concept_id, coalesce(node.name, ''))
				FROM mastery_concepts mastery
				LEFT JOIN public.knowledge_nodes node ON node.id = mastery.concept_id
			), '{}'::json)
		FROM enrollment e
		LEFT JOIN public.users u ON u.id = $2
		LEFT JOIN public.student_profiles sp ON sp.student_id = $2
		CROSS JOIN attempt_stats stats
		CROSS JOIN session_stats sessions`,
		teacherID,
		studentID,
	)

	var snapshot teacherapp.StudentDetailSnapshot
	var joinedAt time.Time
	var displayName pgtype.Text
	var lastActive pgtype.Timestamp
	var masteryRaw []byte
	var sessionDaysRaw []byte
	var conceptCountsRaw []byte
	var knowledgeNamesRaw []byte
	if err := row.Scan(
		&snapshot.Enrollment.ClassID,
		&snapshot.Enrollment.ClassName,
		&joinedAt,
		&snapshot.User.ID,
		&snapshot.User.Username,
		&snapshot.User.Email,
		&displayName,
		&snapshot.HasProfile,
		&masteryRaw,
		&snapshot.Profile.TotalExercises,
		&snapshot.Profile.CorrectCount,
		&snapshot.Profile.TotalStudyTimeMinutes,
		&snapshot.AverageScore,
		&snapshot.Rank,
		&snapshot.TotalClassStudents,
		&lastActive,
		&sessionDaysRaw,
		&conceptCountsRaw,
		&knowledgeNamesRaw,
	); err != nil {
		if err == pgx.ErrNoRows {
			return teacherapp.StudentDetailSnapshot{}, false, nil
		}
		return teacherapp.StudentDetailSnapshot{}, false, err
	}

	snapshot.Enrollment.JoinedAt = &joinedAt
	snapshot.User.DisplayName = textPtr(displayName)
	snapshot.Profile.StudentID = studentID
	snapshot.LastActive = timestampPtr(lastActive)
	var err error
	snapshot.Profile.MasteryVector, err = decodeFloatMap(masteryRaw)
	if err != nil {
		return teacherapp.StudentDetailSnapshot{}, false, fmt.Errorf("decode student detail mastery vector: %w", err)
	}
	snapshot.SessionDays, err = decodeStringSlice(sessionDaysRaw)
	if err != nil {
		return teacherapp.StudentDetailSnapshot{}, false, fmt.Errorf("decode student detail session days: %w", err)
	}
	snapshot.ConceptAttemptCount, err = decodeIntMap(conceptCountsRaw)
	if err != nil {
		return teacherapp.StudentDetailSnapshot{}, false, fmt.Errorf("decode student detail concept counts: %w", err)
	}
	snapshot.KnowledgeNames, err = decodeStringMap(knowledgeNamesRaw)
	if err != nil {
		return teacherapp.StudentDetailSnapshot{}, false, fmt.Errorf("decode student detail knowledge names: %w", err)
	}
	return snapshot, true, nil
}

// ListStudentRecentActivity merges bounded exercise and session activity in one query.
func (r TeacherRepository) ListStudentRecentActivity(
	ctx context.Context,
	teacherID string,
	studentID string,
	attemptLimit int,
	sessionLimit int,
	resultLimit int,
) ([]teacherapp.StudentActivityReadModel, error) {
	if resultLimit <= 0 || (attemptLimit <= 0 && sessionLimit <= 0) {
		return []teacherapp.StudentActivityReadModel{}, nil
	}
	rows, err := r.DB().Query(ctx, `
		WITH recent_attempts AS (
			SELECT ca.id, ca.started_at, ca.is_correct, ca.score, c.title
			FROM public.content_attempts ca
			JOIN public.contents c ON c.id = ca.content_id
			WHERE c.owner_teacher_id = $1
				AND c.generated_by_student_id IS NULL
				AND ca.student_id = $2
			ORDER BY ca.started_at DESC, ca.id DESC
			LIMIT $3
		), recent_sessions AS (
			SELECT id, started_at, ended_at
			FROM public.learning_sessions
			WHERE student_id = $2
			ORDER BY started_at DESC, id DESC
			LIMIT $4
		)
		SELECT activity_type, id, started_at, ended_at, is_correct, score, title
		FROM (
			SELECT
				'exercise'::text AS activity_type,
				id,
				started_at,
				NULL::timestamp AS ended_at,
				is_correct,
				score,
				title::text
			FROM recent_attempts
			UNION ALL
			SELECT
				'session'::text AS activity_type,
				id,
				started_at,
				ended_at,
				false AS is_correct,
				0::double precision AS score,
				''::text AS title
			FROM recent_sessions
		) activity
		ORDER BY started_at DESC, id DESC, activity_type
		LIMIT $5`,
		teacherID,
		studentID,
		max(attemptLimit, 0),
		max(sessionLimit, 0),
		resultLimit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]teacherapp.StudentActivityReadModel, 0, resultLimit)
	for rows.Next() {
		var item teacherapp.StudentActivityReadModel
		var endedAt pgtype.Timestamp
		if err := rows.Scan(
			&item.Type,
			&item.ID,
			&item.StartedAt,
			&endedAt,
			&item.IsCorrect,
			&item.Score,
			&item.Title,
		); err != nil {
			return nil, err
		}
		item.EndedAt = timestampPtr(endedAt)
		items = append(items, item)
	}
	return items, rows.Err()
}

func decodeIntMap(raw []byte) (map[string]int, error) {
	if isEmptyJSON(raw) || !hasJSONContainerPrefix(raw, '{') {
		return map[string]int{}, nil
	}
	values := map[string]int{}
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, err
	}
	return values, nil
}

func decodeStringMap(raw []byte) (map[string]string, error) {
	if isEmptyJSON(raw) || !hasJSONContainerPrefix(raw, '{') {
		return map[string]string{}, nil
	}
	values := map[string]string{}
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, err
	}
	return values, nil
}
