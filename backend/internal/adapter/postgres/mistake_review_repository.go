package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	mistakeapp "mathstudy/backend/internal/application/mistake"
)

// mistakeReviewTaskOrderBy maps the public sort contract to fixed SQL
// fragments. The client can choose direction, but never a column expression.
func mistakeReviewTaskOrderBy(sortBy string, sortOrder string) string {
	direction := "DESC"
	if strings.EqualFold(strings.TrimSpace(sortOrder), "asc") {
		direction = "ASC"
	}
	switch strings.ToLower(strings.TrimSpace(sortBy)) {
	case "due_at":
		return "task.due_at " + direction + " NULLS LAST, task.updated_at DESC, task.id"
	case "mastered_at":
		return "task.mastered_at " + direction + " NULLS LAST, task.updated_at DESC, task.id DESC"
	case "error_count":
		return "task.error_count " + direction + ", task.updated_at DESC, task.id"
	case "mastery":
		return "mastery.avg_mastery " + direction + " NULLS LAST, task.updated_at DESC, task.id"
	case "stage":
		return "task.stage " + direction + ", task.updated_at DESC, task.id"
	default:
		return "task.due_at ASC NULLS LAST, task.updated_at DESC, task.id"
	}
}

// ListReviewTasks returns one server-sorted task page.
func (r MistakeRepository) ListReviewTasks(ctx context.Context, userID string, query mistakeapp.ReviewTaskQuery) ([]mistakeapp.ReviewTaskRow, int, error) {
	orderBy := mistakeReviewTaskOrderBy(query.SortBy, query.SortOrder)
	viewPredicate := `
		(
			($2 = 'mastered' AND task.status = 'mastered')
			OR (
				$2 = 'due'
				AND task.status IN ('pending', 'verification_due')
				AND ($5 <> '' OR $7 = 'all' OR ($7 = 'due' AND task.due_at <= $6) OR ($7 = 'scheduled' AND task.due_at > $6))
			)
		)
		AND ($3 = '' OR EXISTS (
			SELECT 1
			FROM json_array_elements_text(
				CASE
					WHEN json_typeof(task.question_concept_ids) = 'array' THEN task.question_concept_ids
					ELSE '[]'::json
				END
			) AS selected_concept(value)
			WHERE selected_concept.value = $3
		))
		AND ($4 = '' OR diagnosis.error_type::text = $4)
		AND ($5 = '' OR task.id = $5)
		AND ($8::integer IS NULL OR task.stage = $8)
		AND ($9 <= 0 OR task.error_count >= $9)
		AND ($10 = '' OR task.status = $10)`
	args := []any{
		userID,
		query.View,
		query.ConceptID,
		query.ErrorType,
		query.TaskID,
		query.Now,
		query.DueStatus,
		query.Stage,
		query.ErrorCountMin,
		query.Status,
	}
	var total int
	if err := r.DB().QueryRow(ctx, `
			SELECT count(*)::int
			FROM public.mistake_review_tasks task
			LEFT JOIN public.content_attempts source_attempt
			  ON source_attempt.id = task.source_attempt_id
			 AND source_attempt.student_id = task.student_id
			LEFT JOIN public.diagnosis_reports diagnosis ON diagnosis.attempt_id = source_attempt.id
			WHERE task.student_id = $1 AND `+viewPredicate,
		args...,
	).Scan(&total); err != nil {
		return nil, 0, err
	}
	if total == 0 {
		return []mistakeapp.ReviewTaskRow{}, 0, nil
	}
	rows, err := r.DB().Query(ctx, `
		SELECT task.id,
		       task.status,
		       task.revision,
		       task.due_at,
		       task.mastered_at,
		       task.source_attempt_id,
		       coalesce(source_attempt.student_answer, ''),
		       task.daily_assignment_id,
		       task.stage,
		       task.review_count,
		       task.successful_review_count,
		       task.error_count,
		       task.last_outcome,
		       task.last_reviewed_at,
		       task.content_id,
		       task.question_title,
		       task.question_body,
		       task.question_difficulty,
		       CASE
		           WHEN json_typeof(task.question_concept_ids) = 'array' THEN task.question_concept_ids
		           ELSE '[]'::json
		       END,
		       task.question_meta,
		       diagnosis.error_type::text,
		       coalesce(diagnosis.error_subtype, ''),
		       coalesce(diagnosis.severity, ''),
		       coalesce(diagnosis.explanation, ''),
		       coalesce(diagnosis.suggestion, ''),
		       coalesce(diagnosis.related_concept_ids, '[]'::json),
		       diagnosis.error_step_index,
		       mastery.avg_mastery::double precision
		FROM public.mistake_review_tasks task
		LEFT JOIN public.content_attempts source_attempt
		  ON source_attempt.id = task.source_attempt_id
		 AND source_attempt.student_id = task.student_id
		LEFT JOIN public.diagnosis_reports diagnosis ON diagnosis.attempt_id = source_attempt.id
		LEFT JOIN public.student_profiles profile ON profile.student_id = task.student_id
		LEFT JOIN LATERAL (
			SELECT CASE
				WHEN json_array_length(
					CASE
						WHEN json_typeof(task.question_concept_ids) = 'array' THEN task.question_concept_ids
						ELSE '[]'::json
					END
				) = 0 THEN 0.5
				ELSE coalesce(avg(coalesce((profile.mastery_vector ->> concept.value)::double precision, 0.5)), 0.5)
			END AS avg_mastery
			FROM json_array_elements_text(
				CASE
					WHEN json_typeof(task.question_concept_ids) = 'array' THEN task.question_concept_ids
					ELSE '[]'::json
				END
			) AS concept(value)
		) mastery ON true
		WHERE task.student_id = $1 AND `+viewPredicate+`
		ORDER BY `+orderBy+`
		LIMIT $11 OFFSET $12`,
		append(args, query.PageSize, (query.Page-1)*query.PageSize)...,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := make([]mistakeapp.ReviewTaskRow, 0, query.PageSize)
	for rows.Next() {
		item, err := scanMistakeReviewTaskRow(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}

// CountReviewTasks returns active, currently due, and verified plan counts.
func (r MistakeRepository) CountReviewTasks(ctx context.Context, userID string, now time.Time) (mistakeapp.ReviewTaskCounts, error) {
	var counts mistakeapp.ReviewTaskCounts
	err := r.DB().QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status IN ('pending', 'verification_due'))::int,
		       count(*) FILTER (WHERE status IN ('pending', 'verification_due') AND due_at <= $2)::int,
		       count(*) FILTER (WHERE status = 'mastered')::int
		FROM public.mistake_review_tasks
		WHERE student_id = $1`,
		userID,
		now,
	).Scan(&counts.Active, &counts.DueNow, &counts.Mastered)
	return counts, err
}

// GetReviewTaskByAttempt resolves the current aggregated task for an owned attempt's content.
func (r MistakeRepository) GetReviewTaskByAttempt(ctx context.Context, userID string, attemptID string) (mistakeapp.ReviewTaskAssociation, bool, error) {
	var task mistakeapp.ReviewTaskAssociation
	var dueAt pgtype.Timestamp
	var masteredAt pgtype.Timestamp
	var archivedAt pgtype.Timestamp
	err := r.DB().QueryRow(ctx, `
			SELECT task.id, coalesce(task.source_attempt_id, ''), task.status, task.revision,
			       task.due_at, task.mastered_at, task.archived_at
			FROM public.content_attempts attempt
		JOIN public.mistake_review_tasks task
		  ON task.student_id = attempt.student_id
		 AND task.content_id = attempt.content_id
		WHERE attempt.id = $1 AND attempt.student_id = $2`,
		attemptID,
		userID,
	).Scan(&task.ID, &task.SourceAttemptID, &task.Status, &task.Revision, &dueAt, &masteredAt, &archivedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return mistakeapp.ReviewTaskAssociation{}, false, nil
	}
	if err != nil {
		return mistakeapp.ReviewTaskAssociation{}, false, err
	}
	if dueAt.Valid {
		value := dueAt.Time
		task.DueAt = &value
	}
	if masteredAt.Valid {
		value := masteredAt.Time
		task.MasteredAt = &value
	}
	if archivedAt.Valid {
		value := archivedAt.Time
		task.ArchivedAt = &value
	}
	return task, true, nil
}

// ArchiveMistakeRecord hides one aggregated mistake card and retires its review plan atomically.
func (r MistakeRepository) ArchiveMistakeRecord(ctx context.Context, userID string, attemptID string, archivedAt time.Time) (bool, error) {
	var archived bool
	err := r.DB().QueryRow(ctx, `
				WITH target AS (
					SELECT attempt.id,
					       attempt.student_id,
					       attempt.content_id,
					       archive.attempt_id IS NOT NULL AS already_archived,
					       NOT EXISTS (
					           SELECT 1
					           FROM public.content_attempts newer_attempt
					           JOIN public.diagnosis_reports newer_diagnosis
					             ON newer_diagnosis.attempt_id = newer_attempt.id
					           LEFT JOIN public.mistake_record_archives newer_archive
					             ON newer_archive.attempt_id = newer_attempt.id
					            AND newer_archive.student_id = newer_attempt.student_id
					           WHERE newer_attempt.student_id = attempt.student_id
					             AND newer_attempt.content_id = attempt.content_id
					             AND newer_attempt.is_correct = false
					             AND newer_attempt.submitted_at IS NOT NULL
					             AND newer_archive.attempt_id IS NULL
					             AND (
					                 newer_attempt.submitted_at > attempt.submitted_at
					                 OR (
					                     newer_attempt.submitted_at = attempt.submitted_at
					                     AND newer_attempt.id > attempt.id
					                 )
					             )
					       ) AS is_current
					FROM public.content_attempts attempt
					JOIN public.diagnosis_reports diagnosis ON diagnosis.attempt_id = attempt.id
					LEFT JOIN public.mistake_record_archives archive
					  ON archive.attempt_id = attempt.id
					 AND archive.student_id = attempt.student_id
					WHERE attempt.id = $1
					  AND attempt.student_id = $2
					  AND attempt.is_correct = false
					  AND attempt.submitted_at IS NOT NULL
				), accepted_target AS (
					SELECT *
					FROM target
					WHERE already_archived OR is_current
				), archive_scope AS (
					SELECT candidate.id, candidate.student_id
					FROM accepted_target target
					JOIN public.content_attempts candidate
					  ON candidate.student_id = target.student_id
					 AND candidate.content_id = target.content_id
					LEFT JOIN public.mistake_record_archives archive
					  ON archive.attempt_id = candidate.id
					 AND archive.student_id = candidate.student_id
					WHERE target.already_archived = false
					  AND candidate.is_correct = false
					  AND candidate.submitted_at IS NOT NULL
					  AND archive.attempt_id IS NULL
				), archived_record AS (
					INSERT INTO public.mistake_record_archives (attempt_id, student_id, archived_at)
					SELECT archive_scope.id, archive_scope.student_id, $3
					FROM archive_scope
					ON CONFLICT (attempt_id) DO NOTHING
					RETURNING attempt_id
			), archived_task AS (
				UPDATE public.mistake_review_tasks task
				SET status = 'archived',
				    due_at = NULL,
				    archived_at = $3,
					    revision = task.revision + 1,
					    updated_at = $3
					FROM accepted_target target
					JOIN archived_record ON archived_record.attempt_id = target.id
					WHERE task.student_id = target.student_id
					  AND task.content_id = target.content_id
					  AND task.status <> 'archived'
					RETURNING task.id
			)
				SELECT EXISTS (SELECT 1 FROM accepted_target)`,
		attemptID,
		userID,
		archivedAt,
	).Scan(&archived)
	return archived, err
}

func scanMistakeReviewTaskRow(scanner rowScanner) (mistakeapp.ReviewTaskRow, error) {
	var row mistakeapp.ReviewTaskRow
	var dueAt pgtype.Timestamp
	var masteredAt pgtype.Timestamp
	var sourceAttemptID pgtype.Text
	var dailyAssignmentID pgtype.Text
	var lastOutcome pgtype.Bool
	var lastReviewedAt pgtype.Timestamp
	var conceptIDsRaw []byte
	var metaRaw []byte
	var errorType pgtype.Text
	var relatedConceptIDsRaw []byte
	var errorStepIndex pgtype.Int4
	if err := scanner.Scan(
		&row.Association.ID,
		&row.Association.Status,
		&row.Association.Revision,
		&dueAt,
		&masteredAt,
		&sourceAttemptID,
		&row.SourceStudentAnswer,
		&dailyAssignmentID,
		&row.Stage,
		&row.ReviewCount,
		&row.SuccessfulReviewCount,
		&row.ErrorCount,
		&lastOutcome,
		&lastReviewedAt,
		&row.Content.ID,
		&row.Content.Title,
		&row.Content.Body,
		&row.Content.Difficulty,
		&conceptIDsRaw,
		&metaRaw,
		&errorType,
		&row.Diagnosis.ErrorSubtype,
		&row.Diagnosis.Severity,
		&row.Diagnosis.Explanation,
		&row.Diagnosis.Suggestion,
		&relatedConceptIDsRaw,
		&errorStepIndex,
		&row.AvgMastery,
	); err != nil {
		return mistakeapp.ReviewTaskRow{}, err
	}
	row.Content.Type = "PROBLEM"
	if sourceAttemptID.Valid {
		row.SourceAttemptID = sourceAttemptID.String
		row.Association.SourceAttemptID = sourceAttemptID.String
	}
	if dailyAssignmentID.Valid {
		row.DailyAssignmentID = dailyAssignmentID.String
	}
	if dueAt.Valid {
		value := dueAt.Time
		row.Association.DueAt = &value
	}
	if masteredAt.Valid {
		value := masteredAt.Time
		row.Association.MasteredAt = &value
	}
	if lastOutcome.Valid {
		value := lastOutcome.Bool
		row.LastOutcome = &value
	}
	if lastReviewedAt.Valid {
		value := lastReviewedAt.Time
		row.LastReviewedAt = &value
	}
	if errorType.Valid {
		value := errorType.String
		row.Diagnosis.ErrorType = &value
	}
	if errorStepIndex.Valid {
		value := int(errorStepIndex.Int32)
		row.Diagnosis.ErrorStepIndex = &value
	}
	conceptIDs, err := decodeStringSlice(conceptIDsRaw)
	if err != nil {
		return mistakeapp.ReviewTaskRow{}, fmt.Errorf("decode review task concept ids: %w", err)
	}
	meta, err := decodeObjectMap(metaRaw)
	if err != nil {
		return mistakeapp.ReviewTaskRow{}, fmt.Errorf("decode review task meta: %w", err)
	}
	relatedConceptIDs, err := decodeStringSlice(relatedConceptIDsRaw)
	if err != nil {
		return mistakeapp.ReviewTaskRow{}, fmt.Errorf("decode review task related concepts: %w", err)
	}
	row.Content.ConceptIDs = conceptIDs
	row.Content.Meta = meta
	row.Diagnosis.RelatedConceptIDs = relatedConceptIDs
	return row, nil
}
