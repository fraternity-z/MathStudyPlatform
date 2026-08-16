package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	mistakeapp "mathstudy/backend/internal/application/mistake"
)

// MistakeRepository persists mistake book read and write models in PostgreSQL.
type MistakeRepository struct {
	Repository
}

// NewMistakeRepository creates a PostgreSQL-backed mistake repository.
func NewMistakeRepository(db Querier) (MistakeRepository, error) {
	base, err := NewRepository(db)
	if err != nil {
		return MistakeRepository{}, err
	}
	return MistakeRepository{Repository: base}, nil
}

// WithTx runs fn in one database transaction when the repository is pool-backed.
func (r MistakeRepository) WithTx(ctx context.Context, fn func(context.Context, mistakeapp.Repository) error) error {
	if fn == nil {
		return errors.New("mistake transaction function is nil")
	}
	return withRepositoryTx(ctx, "mistake", r.Repository, func(base Repository) MistakeRepository {
		return MistakeRepository{Repository: base}
	}, func(txRepo MistakeRepository) error {
		return fn(ctx, txRepo)
	})
}

// LockStudentTracking serializes mastery writes with exercise submissions.
func (r MistakeRepository) LockStudentTracking(ctx context.Context, userID string) error {
	return lockStudentTracking(ctx, r.DB(), userID)
}

// ListMistakes returns submitted incorrect attempts with their diagnosis and content.
func (r MistakeRepository) ListMistakes(ctx context.Context, userID string, filter mistakeapp.ListFilter) ([]mistakeapp.MistakeRow, error) {
	rows, err := r.DB().Query(ctx, `
		SELECT `+mistakeSelectColumns+`
		FROM public.content_attempts ca
		JOIN public.diagnosis_reports dr ON ca.id = dr.attempt_id
		JOIN public.contents c ON ca.content_id = c.id
		`+mistakeDailyAssignmentJoin+`
		WHERE
			ca.student_id = $1 AND
			ca.is_correct = false AND
			ca.submitted_at IS NOT NULL AND
			($2 = '' OR dr.error_type::text = $2) AND
			($3 = '' OR EXISTS (
				SELECT 1
				FROM json_array_elements_text(`+mistakeQuestionConceptIDs+`) AS concept(value)
				WHERE concept.value = $3
			)) AND
			coalesce(ca.review_question_difficulty, daily_assignment.question_difficulty, c.difficulty) >= $4 AND
			coalesce(ca.review_question_difficulty, daily_assignment.question_difficulty, c.difficulty) <= $5 AND
			($6::timestamp IS NULL OR ca.submitted_at >= $6) AND
			($7::timestamp IS NULL OR ca.submitted_at <= $7)
		ORDER BY ca.submitted_at DESC, ca.id DESC`,
		userID,
		filter.ErrorType,
		filter.ConceptID,
		filter.DifficultyMin,
		filter.DifficultyMax,
		filter.DateFrom,
		filter.DateTo,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	mistakes := []mistakeapp.MistakeRow{}
	for rows.Next() {
		row, err := scanMistakeRow(rows)
		if err != nil {
			return nil, err
		}
		mistakes = append(mistakes, row)
	}
	return mistakes, rows.Err()
}

// ListMistakePage returns one filtered mistake page with SQL-level sorting and aggregates.
func (r MistakeRepository) ListMistakePage(ctx context.Context, userID string, query mistakeapp.ListQuery) ([]mistakeapp.MistakeListRow, int, error) {
	args := []any{
		userID,
		query.ErrorType,
		query.ConceptID,
		query.DifficultyMin,
		query.DifficultyMax,
		query.DateFrom,
		query.DateTo,
		query.ReviewStatus,
		query.DueStatus,
		query.Stage,
		query.ErrorCountMin,
		query.Now,
	}
	whereMastery := mistakeMasteryPredicate(query.MasteryStatus)
	var total int
	if err := r.DB().QueryRow(ctx, `
		SELECT count(*)::int`+mistakeListFromWhere+`
			AND `+whereMastery+`
			AND `+mistakeReviewStatusPredicate()+`
			AND `+mistakeDueStatusPredicate()+`
			AND ($10::integer IS NULL OR review_task.stage = $10)
			AND ($11 <= 0 OR coalesce(ec.error_count, 1) >= $11)`, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	if total == 0 {
		return []mistakeapp.MistakeListRow{}, 0, nil
	}
	pageArgs := append(args, query.PageSize, (query.Page-1)*query.PageSize)
	rows, err := r.DB().Query(ctx, `
		SELECT `+mistakeSelectColumns+`,
		       coalesce(ec.error_count, 1)::int AS error_count,
		       mastery.avg_mastery::double precision AS avg_mastery,
		       review_task.id,
		       review_task.status,
		       review_task.revision,
		       review_task.due_at,
		       review_task.mastered_at,
		       review_task.stage,
		       review_task.review_count,
		       review_task.successful_review_count,
		       review_task.last_outcome,
		       review_task.last_reviewed_at,
		       (review_task.due_at IS NOT NULL
		           AND review_task.due_at <= $12
		           AND review_task.status IN ('pending', 'verification_due')) AS review_is_due,
		       coalesce(
		           daily_assignment.reviewable
		           AND review_task.daily_assignment_id = daily_assignment.id
		           AND review_task.source_attempt_id = ca.id
		           AND review_task.status IN ('pending', 'verification_due')
		           AND review_task.due_at > $12,
		           false
		       ) AS daily_correction,
		       EXISTS (
		           SELECT 1
		           WHERE review_task.source_attempt_id = ca.id
		             AND review_task.status IN ('pending', 'verification_due')
		             AND review_task.due_at > $12
		       ) AS is_early_practice`+mistakeListFromWhere+`
			AND `+whereMastery+`
			AND `+mistakeReviewStatusPredicate()+`
			AND `+mistakeDueStatusPredicate()+`
			AND ($10::integer IS NULL OR review_task.stage = $10)
			AND ($11 <= 0 OR coalesce(ec.error_count, 1) >= $11)
		ORDER BY `+mistakeListOrderBy(query.SortBy, query.SortOrder)+`
		LIMIT $13 OFFSET $14`, pageArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := []mistakeapp.MistakeListRow{}
	for rows.Next() {
		item, err := scanMistakeListRow(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}

// GetMistakeByAttempt returns one attempt with diagnosis and content for detail views.
func (r MistakeRepository) GetMistakeByAttempt(ctx context.Context, userID string, attemptID string) (mistakeapp.MistakeRow, bool, error) {
	row := r.DB().QueryRow(ctx, `
		SELECT `+mistakeSelectColumns+`
		FROM public.content_attempts ca
		JOIN public.diagnosis_reports dr ON ca.id = dr.attempt_id
		JOIN public.contents c ON ca.content_id = c.id
		`+mistakeDailyAssignmentJoin+`
		LEFT JOIN public.mistake_record_archives archive
		  ON archive.attempt_id = ca.id
		 AND archive.student_id = ca.student_id
		WHERE ca.id = $1
		  AND ca.student_id = $2
		  AND ca.is_correct = false
		  AND ca.submitted_at IS NOT NULL
		  AND `+mistakeRepresentativeAttemptPredicate+`
		  AND archive.attempt_id IS NULL`,
		attemptID,
		userID,
	)
	return scanOptionalMistakeRow(row)
}

// GetAttemptContent returns one attempt and content pair for write use cases.
func (r MistakeRepository) GetAttemptContent(ctx context.Context, userID string, attemptID string) (mistakeapp.AttemptContent, bool, error) {
	row := r.DB().QueryRow(ctx, `
		SELECT
			ca.id,
			ca.content_id,
			ca.student_answer,
			ca.student_steps,
			ca.is_correct,
			ca.score,
			ca.submitted_at,
				ca.time_spent_seconds,
				daily_assignment.id,
				CASE
					WHEN daily_assignment.id IS NULL THEN c.status = 'PUBLISHED'::public.contentstatus AND c.deleted_at IS NULL
					ELSE daily_assignment.reviewable
				END,
				daily_assignment.id IS NULL,
				c.id,
			c.type::text,
			coalesce(daily_assignment.question_title, c.title),
			coalesce(daily_assignment.question_body, c.body),
			coalesce(daily_assignment.question_difficulty, c.difficulty),
			CASE
				WHEN json_typeof(coalesce(daily_assignment.question_concept_ids, c.concept_ids)) = 'array'
					THEN coalesce(daily_assignment.question_concept_ids, c.concept_ids)
				ELSE '[]'::json
			END,
			coalesce(daily_assignment.question_meta, c.meta)
		FROM public.content_attempts ca
		JOIN public.contents c ON ca.content_id = c.id
		`+mistakeDailyAssignmentJoin+`
		WHERE ca.id = $1 AND ca.student_id = $2`,
		attemptID,
		userID,
	)

	var attempt mistakeapp.Attempt
	var content mistakeapp.Content
	if err := scanAttemptAndContent(row, &attempt, &content); err != nil {
		if err == pgx.ErrNoRows {
			return mistakeapp.AttemptContent{}, false, nil
		}
		return mistakeapp.AttemptContent{}, false, err
	}
	return mistakeapp.AttemptContent{Attempt: attempt, Content: content}, true, nil
}

// ListAttemptHistory returns submitted attempts for the same content, excluding the current attempt.
func (r MistakeRepository) ListAttemptHistory(ctx context.Context, userID string, contentID string, excludeAttemptID string) ([]mistakeapp.AttemptHistoryRow, error) {
	rows, err := r.DB().Query(ctx, `
		SELECT id, submitted_at, is_correct, score
		FROM public.content_attempts
		WHERE
			student_id = $1 AND
			content_id = $2 AND
			id <> $3 AND
			submitted_at IS NOT NULL
		ORDER BY submitted_at DESC`,
		userID,
		contentID,
		excludeAttemptID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	history := []mistakeapp.AttemptHistoryRow{}
	for rows.Next() {
		var item mistakeapp.AttemptHistoryRow
		var submittedAt pgtype.Timestamp
		if err := rows.Scan(&item.AttemptID, &submittedAt, &item.IsCorrect, &item.Score); err != nil {
			return nil, err
		}
		item.SubmittedAt = timestampPtr(submittedAt)
		history = append(history, item)
	}
	return history, rows.Err()
}

// GetProfile returns the student's mastery vector.
func (r MistakeRepository) GetProfile(ctx context.Context, userID string) (mistakeapp.StudentProfile, bool, error) {
	var masteryRaw []byte
	err := r.DB().QueryRow(ctx, `
		SELECT mastery_vector
		FROM public.student_profiles
		WHERE student_id = $1`,
		userID,
	).Scan(&masteryRaw)
	if err != nil {
		if err == pgx.ErrNoRows {
			return mistakeapp.StudentProfile{}, false, nil
		}
		return mistakeapp.StudentProfile{}, false, err
	}
	mastery, err := decodeFloatMap(masteryRaw)
	if err != nil {
		return mistakeapp.StudentProfile{}, false, fmt.Errorf("decode mastery vector: %w", err)
	}
	return mistakeapp.StudentProfile{MasteryVector: mastery}, true, nil
}

// ErrorCountsByContent returns incorrect attempt counts grouped by content.
func (r MistakeRepository) ErrorCountsByContent(ctx context.Context, userID string) (map[string]int, error) {
	rows, err := r.DB().Query(ctx, `
		SELECT content_id, count(id)::int
		FROM public.content_attempts
		WHERE student_id = $1 AND is_correct = false AND submitted_at IS NOT NULL
		GROUP BY content_id`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := map[string]int{}
	for rows.Next() {
		var contentID string
		var count int
		if err := rows.Scan(&contentID, &count); err != nil {
			return nil, err
		}
		counts[contentID] = count
	}
	return counts, rows.Err()
}

// KnowledgeNames resolves concept IDs for student-facing mistake projections.
func (r MistakeRepository) KnowledgeNames(ctx context.Context, conceptIDs []string) (map[string]string, error) {
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

// CountSubmittedAttempts counts submitted attempts in an optional time window.
func (r MistakeRepository) CountSubmittedAttempts(ctx context.Context, userID string, start *time.Time, end *time.Time) (int, error) {
	var count int
	err := r.DB().QueryRow(ctx, `
		SELECT count(id)::int
		FROM public.content_attempts
		WHERE
			student_id = $1 AND
			submitted_at IS NOT NULL AND
			($2::timestamp IS NULL OR submitted_at >= $2) AND
			($3::timestamp IS NULL OR submitted_at <= $3)`,
		userID,
		start,
		end,
	).Scan(&count)
	return count, err
}

// UpdateProfileMastery replaces a student's mastery vector.
func (r MistakeRepository) UpdateProfileMastery(ctx context.Context, userID string, mastery map[string]float64, updatedAt time.Time) (bool, error) {
	raw, err := json.Marshal(mastery)
	if err != nil {
		return false, err
	}
	tag, err := r.DB().Exec(ctx, `
		UPDATE public.student_profiles
		SET mastery_vector = $2::json, updated_at = $3
		WHERE student_id = $1`,
		userID,
		string(raw),
		updatedAt,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// DeleteAttempt deletes one regular attempt while preserving immutable daily-task evidence.
func (r MistakeRepository) DeleteAttempt(ctx context.Context, userID string, attemptID string) (bool, error) {
	tag, err := r.DB().Exec(ctx, `
		DELETE FROM public.content_attempts attempt
		WHERE attempt.id = $1
		  AND attempt.student_id = $2
		  AND NOT EXISTS (
			  SELECT 1
			  FROM public.daily_question_assignments assignment
			  WHERE assignment.student_id = attempt.student_id
			    AND (
				    assignment.id = attempt.daily_assignment_id
				    OR assignment.first_attempt_id = attempt.id
				    OR assignment.corrected_attempt_id = attempt.id
			    )
		  )`,
		attemptID,
		userID,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

const mistakeDailyAssignmentJoin = `
			LEFT JOIN LATERAL (
				SELECT
					assignment.id,
					assignment.status = 'completed'
						AND assignment.first_attempt_id IS NOT NULL
						AND assignment.first_result = 'incorrect'
						AND assignment.corrected_attempt_id IS NULL AS reviewable,
					assignment.question_title,
					assignment.question_body,
					assignment.question_difficulty,
					assignment.question_concept_ids,
					assignment.question_meta,
					assignment.question_generated_by_student_id
				FROM public.daily_question_assignments assignment
				WHERE assignment.student_id = ca.student_id
				  AND assignment.content_id = ca.content_id
				  AND (
					assignment.id = ca.daily_assignment_id
					OR (
						ca.daily_assignment_id IS NULL
						AND (
							assignment.first_attempt_id = ca.id
							OR assignment.corrected_attempt_id = ca.id
						)
					)
				  )
				ORDER BY (assignment.id = ca.daily_assignment_id) DESC NULLS LAST
				LIMIT 1
			) daily_assignment ON true`

const mistakeQuestionConceptIDs = `CASE
	WHEN json_typeof(coalesce(ca.review_question_concept_ids, daily_assignment.question_concept_ids, c.concept_ids)) = 'array'
		THEN coalesce(ca.review_question_concept_ids, daily_assignment.question_concept_ids, c.concept_ids)
	ELSE '[]'::json
END`

const mistakeRepresentativeAttemptPredicate = `NOT EXISTS (
	SELECT 1
	FROM public.content_attempts newer_attempt
	JOIN public.diagnosis_reports newer_diagnosis
	  ON newer_diagnosis.attempt_id = newer_attempt.id
	LEFT JOIN public.mistake_record_archives newer_archive
	  ON newer_archive.attempt_id = newer_attempt.id
	 AND newer_archive.student_id = newer_attempt.student_id
	WHERE newer_attempt.student_id = ca.student_id
	  AND newer_attempt.content_id = ca.content_id
	  AND newer_attempt.is_correct = false
	  AND newer_attempt.submitted_at IS NOT NULL
	  AND newer_archive.attempt_id IS NULL
	  AND (
	      newer_attempt.submitted_at > ca.submitted_at
	      OR (
	          newer_attempt.submitted_at = ca.submitted_at
	          AND newer_attempt.id > ca.id
	      )
	  )
)`

const mistakeListFromWhere = `
			FROM (
				SELECT DISTINCT ON (candidate.content_id) candidate.id
				FROM public.content_attempts candidate
				JOIN public.diagnosis_reports candidate_diagnosis ON candidate_diagnosis.attempt_id = candidate.id
				LEFT JOIN public.mistake_record_archives candidate_archive
				  ON candidate_archive.attempt_id = candidate.id
				 AND candidate_archive.student_id = candidate.student_id
				WHERE candidate.student_id = $1
				  AND candidate.is_correct = false
				  AND candidate.submitted_at IS NOT NULL
				  AND candidate_archive.attempt_id IS NULL
				ORDER BY candidate.content_id, candidate.submitted_at DESC, candidate.id DESC
			) latest_mistake
			JOIN public.content_attempts ca ON ca.id = latest_mistake.id
			JOIN public.diagnosis_reports dr ON ca.id = dr.attempt_id
			JOIN public.contents c ON ca.content_id = c.id` + mistakeDailyAssignmentJoin + `
			LEFT JOIN public.mistake_review_tasks review_task
			  ON review_task.student_id = ca.student_id
			 AND review_task.content_id = ca.content_id
			LEFT JOIN public.student_profiles sp ON sp.student_id = ca.student_id
		LEFT JOIN (
			SELECT content_id, count(id)::int AS error_count
			FROM public.content_attempts
			WHERE student_id = $1 AND is_correct = false AND submitted_at IS NOT NULL
			GROUP BY content_id
		) ec ON ec.content_id = ca.content_id
		LEFT JOIN LATERAL (
			SELECT CASE
				WHEN coalesce(json_array_length(` + mistakeQuestionConceptIDs + `), 0) = 0 THEN 0.5
				ELSE coalesce(avg(coalesce((sp.mastery_vector ->> concept.value)::double precision, 0.5)), 0.5)
			END AS avg_mastery
			FROM json_array_elements_text(` + mistakeQuestionConceptIDs + `) AS concept(value)
			) mastery ON true
			WHERE
				($2 = '' OR dr.error_type::text = $2) AND
			($3 = '' OR EXISTS (
				SELECT 1
				FROM json_array_elements_text(` + mistakeQuestionConceptIDs + `) AS concept(value)
				WHERE concept.value = $3
			)) AND
			coalesce(ca.review_question_difficulty, daily_assignment.question_difficulty, c.difficulty) >= $4 AND
			coalesce(ca.review_question_difficulty, daily_assignment.question_difficulty, c.difficulty) <= $5 AND
			($6::timestamp IS NULL OR ca.submitted_at >= $6) AND
			($7::timestamp IS NULL OR ca.submitted_at <= $7)`

const mistakeSelectColumns = `
	ca.id,
	ca.content_id,
	ca.student_answer,
	ca.student_steps,
	ca.is_correct,
	ca.score,
	ca.submitted_at,
	ca.time_spent_seconds,
	daily_assignment.id,
	true,
	daily_assignment.id IS NULL,
	c.id,
	c.type::text,
	coalesce(ca.review_question_title, daily_assignment.question_title, c.title),
	coalesce(ca.review_question_body, daily_assignment.question_body, c.body),
	coalesce(ca.review_question_difficulty, daily_assignment.question_difficulty, c.difficulty),
	` + mistakeQuestionConceptIDs + `,
	coalesce(ca.review_question_meta, daily_assignment.question_meta, c.meta),
	dr.error_type::text,
	dr.error_subtype,
	dr.severity,
	dr.explanation,
	dr.suggestion,
	dr.related_concept_ids,
	dr.error_step_index`

func mistakeMasteryPredicate(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "weak":
		return "mastery.avg_mastery < 0.4"
	case "improving":
		return "mastery.avg_mastery >= 0.4 AND mastery.avg_mastery < 0.7"
	case "mastered":
		return "mastery.avg_mastery >= 0.7"
	default:
		return "TRUE"
	}
}

// mistakeReviewStatusPredicate returns SQL assembled only from a fixed set of
// predicates. User-provided values are passed as parameters; they never enter
// this fragment, which keeps the dynamic list query injection-safe.
func mistakeReviewStatusPredicate() string {
	return `CASE lower($8::text)
		WHEN '' THEN TRUE
		WHEN 'all' THEN TRUE
		WHEN 'pending' THEN review_task.status = 'pending'
		WHEN 'verification_due' THEN review_task.status = 'verification_due'
		WHEN 'mastered' THEN review_task.status = 'mastered'
		WHEN 'archived' THEN review_task.status = 'archived'
		WHEN 'none' THEN review_task.id IS NULL
		ELSE TRUE
	END`
}

func mistakeDueStatusPredicate() string {
	return `CASE lower($9::text)
		WHEN '' THEN TRUE
		WHEN 'all' THEN TRUE
		WHEN 'due' THEN review_task.status IN ('pending', 'verification_due') AND review_task.due_at <= $12
		WHEN 'scheduled' THEN review_task.status IN ('pending', 'verification_due') AND review_task.due_at > $12
		ELSE TRUE
	END`
}

func mistakeListOrderBy(sortBy string, sortOrder string) string {
	direction := "DESC"
	if strings.EqualFold(strings.TrimSpace(sortOrder), "asc") {
		direction = "ASC"
	}
	switch strings.ToLower(strings.TrimSpace(sortBy)) {
	case "error_count":
		return "error_count " + direction + ", ca.id " + direction
	case "mastery":
		return "avg_mastery " + direction + ", ca.id " + direction
	case "due_at", "review_due_at":
		return "review_task.due_at " + direction + " NULLS LAST, ca.id " + direction
	case "stage", "review_stage":
		return "review_task.stage " + direction + " NULLS LAST, ca.id " + direction
	default:
		return "ca.submitted_at " + direction + " NULLS LAST, ca.id " + direction
	}
}

func scanOptionalMistakeRow(row pgx.Row) (mistakeapp.MistakeRow, bool, error) {
	mistake, err := scanMistake(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			return mistakeapp.MistakeRow{}, false, nil
		}
		return mistakeapp.MistakeRow{}, false, err
	}
	return mistake, true, nil
}

type rowScanner interface {
	Scan(...any) error
}

func scanMistakeRow(rows pgx.Rows) (mistakeapp.MistakeRow, error) {
	return scanMistake(rows)
}

func scanMistakeListRow(rows pgx.Rows) (mistakeapp.MistakeListRow, error) {
	var attempt mistakeapp.Attempt
	var content mistakeapp.Content
	var diagnosis mistakeapp.Diagnosis
	var studentStepsRaw []byte
	var conceptIDsRaw []byte
	var metaRaw []byte
	var submittedAt pgtype.Timestamp
	var dailyAssignmentID pgtype.Text
	var errorType pgtype.Text
	var errorSubtype pgtype.Text
	var relatedConceptIDsRaw []byte
	var errorStepIndex pgtype.Int4
	var errorCount int
	var avgMastery float64
	var reviewTaskID pgtype.Text
	var reviewStatus pgtype.Text
	var reviewRevision pgtype.Int8
	var reviewDueAt pgtype.Timestamp
	var reviewMasteredAt pgtype.Timestamp
	var reviewStage pgtype.Int4
	var reviewCount pgtype.Int4
	var successfulReviewCount pgtype.Int4
	var reviewLastOutcome pgtype.Bool
	var reviewLastReviewedAt pgtype.Timestamp
	var reviewIsDue bool
	var dailyCorrection bool
	var isEarlyPractice bool

	if err := rows.Scan(
		&attempt.ID,
		&attempt.ContentID,
		&attempt.StudentAnswer,
		&studentStepsRaw,
		&attempt.IsCorrect,
		&attempt.Score,
		&submittedAt,
		&attempt.TimeSpentSeconds,
		&dailyAssignmentID,
		&attempt.CanReview,
		&attempt.CanDelete,
		&content.ID,
		&content.Type,
		&content.Title,
		&content.Body,
		&content.Difficulty,
		&conceptIDsRaw,
		&metaRaw,
		&errorType,
		&errorSubtype,
		&diagnosis.Severity,
		&diagnosis.Explanation,
		&diagnosis.Suggestion,
		&relatedConceptIDsRaw,
		&errorStepIndex,
		&errorCount,
		&avgMastery,
		&reviewTaskID,
		&reviewStatus,
		&reviewRevision,
		&reviewDueAt,
		&reviewMasteredAt,
		&reviewStage,
		&reviewCount,
		&successfulReviewCount,
		&reviewLastOutcome,
		&reviewLastReviewedAt,
		&reviewIsDue,
		&dailyCorrection,
		&isEarlyPractice,
	); err != nil {
		return mistakeapp.MistakeListRow{}, err
	}
	attempt.SubmittedAt = timestampPtr(submittedAt)
	if dailyAssignmentID.Valid {
		attempt.DailyAssignmentID = dailyAssignmentID.String
	}
	studentSteps, err := decodeStringSlice(studentStepsRaw)
	if err != nil {
		return mistakeapp.MistakeListRow{}, fmt.Errorf("decode student steps: %w", err)
	}
	conceptIDs, err := decodeStringSlice(conceptIDsRaw)
	if err != nil {
		return mistakeapp.MistakeListRow{}, fmt.Errorf("decode concept ids: %w", err)
	}
	meta, err := decodeObjectMap(metaRaw)
	if err != nil {
		return mistakeapp.MistakeListRow{}, fmt.Errorf("decode content meta: %w", err)
	}
	relatedConceptIDs, err := decodeStringSlice(relatedConceptIDsRaw)
	if err != nil {
		return mistakeapp.MistakeListRow{}, fmt.Errorf("decode related concept ids: %w", err)
	}
	diagnosis.ErrorType = textPtr(errorType)
	if errorSubtype.Valid {
		diagnosis.ErrorSubtype = errorSubtype.String
	}
	diagnosis.ErrorStepIndex = intPtr(errorStepIndex)
	attempt.StudentSteps = studentSteps
	content.ConceptIDs = conceptIDs
	content.Meta = meta
	diagnosis.RelatedConceptIDs = relatedConceptIDs
	var reviewStageValue *int
	if reviewStage.Valid {
		value := int(reviewStage.Int32)
		reviewStageValue = &value
	}
	return mistakeapp.MistakeListRow{
		Row:                   mistakeapp.MistakeRow{Attempt: attempt, Content: content, Diagnosis: diagnosis},
		AvgMastery:            avgMastery,
		ErrorCount:            errorCount,
		LastReviewedAt:        timestampPtr(reviewLastReviewedAt),
		IsEarlyPractice:       isEarlyPractice,
		ReviewTaskID:          textValue(reviewTaskID),
		ReviewStatus:          textValue(reviewStatus),
		ReviewRevision:        int64Ptr(reviewRevision),
		ReviewDueAt:           timestampPtr(reviewDueAt),
		ReviewMasteredAt:      timestampPtr(reviewMasteredAt),
		ReviewStage:           reviewStageValue,
		ReviewCount:           intValue(reviewCount),
		SuccessfulReviewCount: intValue(successfulReviewCount),
		ReviewLastOutcome:     boolPtr(reviewLastOutcome),
		ReviewLastReviewedAt:  timestampPtr(reviewLastReviewedAt),
		ReviewIsDue:           reviewIsDue,
		DailyCorrection:       dailyCorrection,
	}, nil
}

func scanMistake(scanner rowScanner) (mistakeapp.MistakeRow, error) {
	var attempt mistakeapp.Attempt
	var content mistakeapp.Content
	var diagnosis mistakeapp.Diagnosis
	var studentStepsRaw []byte
	var conceptIDsRaw []byte
	var metaRaw []byte
	var submittedAt pgtype.Timestamp
	var dailyAssignmentID pgtype.Text
	var errorType pgtype.Text
	var errorSubtype pgtype.Text
	var relatedConceptIDsRaw []byte
	var errorStepIndex pgtype.Int4

	if err := scanner.Scan(
		&attempt.ID,
		&attempt.ContentID,
		&attempt.StudentAnswer,
		&studentStepsRaw,
		&attempt.IsCorrect,
		&attempt.Score,
		&submittedAt,
		&attempt.TimeSpentSeconds,
		&dailyAssignmentID,
		&attempt.CanReview,
		&attempt.CanDelete,
		&content.ID,
		&content.Type,
		&content.Title,
		&content.Body,
		&content.Difficulty,
		&conceptIDsRaw,
		&metaRaw,
		&errorType,
		&errorSubtype,
		&diagnosis.Severity,
		&diagnosis.Explanation,
		&diagnosis.Suggestion,
		&relatedConceptIDsRaw,
		&errorStepIndex,
	); err != nil {
		return mistakeapp.MistakeRow{}, err
	}
	attempt.SubmittedAt = timestampPtr(submittedAt)
	if dailyAssignmentID.Valid {
		attempt.DailyAssignmentID = dailyAssignmentID.String
	}
	studentSteps, err := decodeStringSlice(studentStepsRaw)
	if err != nil {
		return mistakeapp.MistakeRow{}, fmt.Errorf("decode student steps: %w", err)
	}
	conceptIDs, err := decodeStringSlice(conceptIDsRaw)
	if err != nil {
		return mistakeapp.MistakeRow{}, fmt.Errorf("decode concept ids: %w", err)
	}
	meta, err := decodeObjectMap(metaRaw)
	if err != nil {
		return mistakeapp.MistakeRow{}, fmt.Errorf("decode content meta: %w", err)
	}
	relatedConceptIDs, err := decodeStringSlice(relatedConceptIDsRaw)
	if err != nil {
		return mistakeapp.MistakeRow{}, fmt.Errorf("decode related concept ids: %w", err)
	}
	diagnosis.ErrorType = textPtr(errorType)
	if errorSubtype.Valid {
		diagnosis.ErrorSubtype = errorSubtype.String
	}
	diagnosis.ErrorStepIndex = intPtr(errorStepIndex)
	attempt.StudentSteps = studentSteps
	content.ConceptIDs = conceptIDs
	content.Meta = meta
	diagnosis.RelatedConceptIDs = relatedConceptIDs
	return mistakeapp.MistakeRow{Attempt: attempt, Content: content, Diagnosis: diagnosis}, nil
}

func scanAttemptAndContent(scanner rowScanner, attempt *mistakeapp.Attempt, content *mistakeapp.Content) error {
	var studentStepsRaw []byte
	var conceptIDsRaw []byte
	var metaRaw []byte
	var submittedAt pgtype.Timestamp
	var dailyAssignmentID pgtype.Text
	if err := scanner.Scan(
		&attempt.ID,
		&attempt.ContentID,
		&attempt.StudentAnswer,
		&studentStepsRaw,
		&attempt.IsCorrect,
		&attempt.Score,
		&submittedAt,
		&attempt.TimeSpentSeconds,
		&dailyAssignmentID,
		&attempt.CanReview,
		&attempt.CanDelete,
		&content.ID,
		&content.Type,
		&content.Title,
		&content.Body,
		&content.Difficulty,
		&conceptIDsRaw,
		&metaRaw,
	); err != nil {
		return err
	}
	attempt.SubmittedAt = timestampPtr(submittedAt)
	if dailyAssignmentID.Valid {
		attempt.DailyAssignmentID = dailyAssignmentID.String
	}
	studentSteps, err := decodeStringSlice(studentStepsRaw)
	if err != nil {
		return fmt.Errorf("decode student steps: %w", err)
	}
	conceptIDs, err := decodeStringSlice(conceptIDsRaw)
	if err != nil {
		return fmt.Errorf("decode concept ids: %w", err)
	}
	meta, err := decodeObjectMap(metaRaw)
	if err != nil {
		return fmt.Errorf("decode content meta: %w", err)
	}
	attempt.StudentSteps = studentSteps
	content.ConceptIDs = conceptIDs
	content.Meta = meta
	return nil
}
