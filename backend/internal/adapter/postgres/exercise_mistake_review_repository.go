package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	exerciseapp "mathstudy/backend/internal/application/exercise"
)

// GetMistakeReviewTask loads one student-owned task and its trusted question snapshot.
func (r ExerciseRepository) GetMistakeReviewTask(ctx context.Context, studentID string, taskID string) (exerciseapp.MistakeReviewTask, bool, error) {
	return r.getMistakeReviewTask(ctx, studentID, taskID, false)
}

// GetMistakeReviewTaskForUpdate locks one task until the submission transaction finishes.
func (r ExerciseRepository) GetMistakeReviewTaskForUpdate(ctx context.Context, studentID string, taskID string) (exerciseapp.MistakeReviewTask, bool, error) {
	return r.getMistakeReviewTask(ctx, studentID, taskID, true)
}

func (r ExerciseRepository) getMistakeReviewTask(ctx context.Context, studentID string, taskID string, forUpdate bool) (exerciseapp.MistakeReviewTask, bool, error) {
	query := mistakeReviewTaskSelect + `
		WHERE task.student_id = $1 AND task.id = $2`
	if forUpdate {
		query += ` FOR UPDATE OF task`
	}
	return scanOptionalExerciseMistakeReviewTask(r.DB().QueryRow(ctx, query, studentID, taskID))
}

// GetMistakeReviewTaskByContentForUpdate finds the single review plan for a student and question.
func (r ExerciseRepository) GetMistakeReviewTaskByContentForUpdate(ctx context.Context, studentID string, contentID string) (exerciseapp.MistakeReviewTask, bool, error) {
	row := r.DB().QueryRow(ctx, mistakeReviewTaskSelect+`
		WHERE task.student_id = $1 AND task.content_id = $2
		FOR UPDATE OF task`, studentID, contentID)
	return scanOptionalExerciseMistakeReviewTask(row)
}

// CountIncorrectAttempts keeps a newly opened plan's error count consistent with retained history.
func (r ExerciseRepository) CountIncorrectAttempts(ctx context.Context, studentID string, contentID string) (int, error) {
	var count int
	err := r.DB().QueryRow(ctx, `
		SELECT count(*)::int
		FROM public.content_attempts
		WHERE student_id = $1
		  AND content_id = $2
		  AND (is_correct = false OR process_evaluation->>'status' = 'incorrect')
		  AND submitted_at IS NOT NULL`,
		studentID,
		contentID,
	).Scan(&count)
	return count, err
}

// InsertMistakeReviewTask creates the first review plan for one incorrect answer.
func (r ExerciseRepository) InsertMistakeReviewTask(ctx context.Context, task exerciseapp.MistakeReviewTask) error {
	conceptIDsRaw, err := marshalReviewConceptIDs(task.Exercise.ConceptIDs)
	if err != nil {
		return err
	}
	metaRaw, err := json.Marshal(task.Exercise.Meta)
	if err != nil {
		return err
	}
	_, err = r.DB().Exec(ctx, `
		INSERT INTO public.mistake_review_tasks (
			id, student_id, content_id, question_title, question_body,
			question_difficulty, question_concept_ids, question_meta,
			question_generated_by_student_id, source_attempt_id, daily_assignment_id,
			status, stage, review_count, successful_review_count, error_count,
			due_at, last_review_attempt_id, last_outcome, last_reviewed_at,
			mastered_at, archived_at, revision, created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7::json, $8::json, nullif($9, ''),
		        $10, nullif($11, ''), $12, $13, $14, $15, $16, $17,
		        nullif($18, ''), $19, $20, $21, $22, $23, $24, $25)
		ON CONFLICT (student_id, content_id) DO NOTHING`,
		task.ID,
		task.StudentID,
		task.ContentID,
		task.Exercise.Title,
		task.Exercise.Body,
		task.Exercise.Difficulty,
		string(conceptIDsRaw),
		string(metaRaw),
		task.Exercise.GeneratedByStudentID,
		task.SourceAttemptID,
		task.DailyAssignmentID,
		task.Status,
		task.Stage,
		task.ReviewCount,
		task.SuccessfulReviewCount,
		task.ErrorCount,
		task.DueAt,
		task.LastReviewAttemptID,
		task.LastOutcome,
		task.LastReviewedAt,
		task.MasteredAt,
		task.ArchivedAt,
		task.Revision,
		task.CreatedAt,
		task.UpdatedAt,
	)
	return err
}

// UpdateMistakeReviewTask persists an application-layer review transition.
func (r ExerciseRepository) UpdateMistakeReviewTask(ctx context.Context, task exerciseapp.MistakeReviewTask) error {
	conceptIDsRaw, err := marshalReviewConceptIDs(task.Exercise.ConceptIDs)
	if err != nil {
		return err
	}
	metaRaw, err := json.Marshal(task.Exercise.Meta)
	if err != nil {
		return err
	}
	tag, err := r.DB().Exec(ctx, `
		UPDATE public.mistake_review_tasks
		SET question_title = $3,
		    question_body = $4,
		    question_difficulty = $5,
		    question_concept_ids = $6::json,
		    question_meta = $7::json,
		    question_generated_by_student_id = nullif($8, ''),
		    source_attempt_id = nullif($9, ''),
		    daily_assignment_id = nullif($10, ''),
		    status = $11,
		    stage = $12,
		    review_count = $13,
		    successful_review_count = $14,
		    error_count = $15,
		    due_at = $16,
		    last_review_attempt_id = nullif($17, ''),
		    last_outcome = $18,
		    last_reviewed_at = $19,
		    mastered_at = $20,
		    archived_at = $21,
		    revision = $22,
		    updated_at = $23
		WHERE id = $1 AND student_id = $2 AND revision = $22 - 1`,
		task.ID,
		task.StudentID,
		task.Exercise.Title,
		task.Exercise.Body,
		task.Exercise.Difficulty,
		string(conceptIDsRaw),
		string(metaRaw),
		task.Exercise.GeneratedByStudentID,
		task.SourceAttemptID,
		task.DailyAssignmentID,
		task.Status,
		task.Stage,
		task.ReviewCount,
		task.SuccessfulReviewCount,
		task.ErrorCount,
		task.DueAt,
		task.LastReviewAttemptID,
		task.LastOutcome,
		task.LastReviewedAt,
		task.MasteredAt,
		task.ArchivedAt,
		task.Revision,
		task.UpdatedAt,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return exerciseapp.ErrReviewTaskStale
	}
	return nil
}

// GetReviewSubmissionResponse returns the response stored for an idempotent task
// submission and rejects reuse against another payload.
func (r ExerciseRepository) GetReviewSubmissionResponse(
	ctx context.Context,
	taskID string,
	studentID string,
	submissionKey string,
	submissionDigest string,
) (exerciseapp.SubmitResponse, bool, error) {
	var storedDigest pgtype.Text
	var raw []byte
	err := r.DB().QueryRow(ctx, `
		SELECT attempt.review_submission_digest,
		       attempt.review_submission_response
		FROM public.content_attempts attempt
		WHERE attempt.review_task_id = $1
		  AND attempt.student_id = $2
		  AND attempt.review_submission_key = $3`,
		taskID,
		studentID,
		submissionKey,
	).Scan(&storedDigest, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return exerciseapp.SubmitResponse{}, false, nil
	}
	if err != nil {
		return exerciseapp.SubmitResponse{}, false, err
	}
	if !storedDigest.Valid || storedDigest.String != submissionDigest {
		return exerciseapp.SubmitResponse{}, false, exerciseapp.ErrSubmissionConflict
	}
	if len(raw) == 0 {
		return exerciseapp.SubmitResponse{}, false, fmt.Errorf("review submission response is incomplete")
	}
	var response exerciseapp.SubmitResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return exerciseapp.SubmitResponse{}, false, fmt.Errorf("decode review submission response: %w", err)
	}
	return response, true, nil
}

// SaveReviewSubmissionResponse completes a review submission's idempotency record.
func (r ExerciseRepository) SaveReviewSubmissionResponse(
	ctx context.Context,
	attemptID string,
	studentID string,
	submissionKey string,
	submissionDigest string,
	response exerciseapp.SubmitResponse,
) error {
	raw, err := json.Marshal(response)
	if err != nil {
		return err
	}
	tag, err := r.DB().Exec(ctx, `
		UPDATE public.content_attempts
		SET review_submission_response = $5::json
		WHERE id = $1
		  AND student_id = $2
		  AND review_submission_key = $3
		  AND review_submission_digest = $4
		  AND review_task_id IS NOT NULL`,
		attemptID,
		studentID,
		submissionKey,
		submissionDigest,
		string(raw),
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return exerciseapp.ErrSubmissionConflict
	}
	return nil
}

const mistakeReviewTaskSelect = `
	SELECT task.id,
	       task.student_id,
	       task.content_id,
	       task.source_attempt_id,
	       task.daily_assignment_id,
	       task.status,
	       task.stage,
	       task.review_count,
	       task.successful_review_count,
	       task.error_count,
	       task.due_at,
	       task.last_review_attempt_id,
	       task.last_outcome,
	       task.last_reviewed_at,
	       task.mastered_at,
	       task.archived_at,
	       task.revision,
	       task.created_at,
	       task.updated_at,
	       task.content_id,
	       NULL::character varying,
	       task.question_generated_by_student_id,
	       'PUBLISHED',
	       task.question_title,
	       task.question_body,
	       task.question_difficulty,
	       task.question_concept_ids,
	       task.question_meta,
	       coalesce(
	           assignment.status = 'completed'
	           AND assignment.first_result = 'incorrect'
	           AND assignment.corrected_attempt_id IS NULL,
	           false
	       )
	FROM public.mistake_review_tasks task
	LEFT JOIN public.daily_question_assignments assignment
	  ON assignment.id = task.daily_assignment_id
	 AND assignment.student_id = task.student_id
	 AND assignment.content_id = task.content_id`

func marshalReviewConceptIDs(conceptIDs []string) ([]byte, error) {
	if conceptIDs == nil {
		conceptIDs = []string{}
	}
	return json.Marshal(conceptIDs)
}

func scanOptionalExerciseMistakeReviewTask(scanner rowScanner) (exerciseapp.MistakeReviewTask, bool, error) {
	task, err := scanExerciseMistakeReviewTask(scanner)
	if errors.Is(err, pgx.ErrNoRows) {
		return exerciseapp.MistakeReviewTask{}, false, nil
	}
	if err != nil {
		return exerciseapp.MistakeReviewTask{}, false, err
	}
	return task, true, nil
}

func scanExerciseMistakeReviewTask(scanner rowScanner) (exerciseapp.MistakeReviewTask, error) {
	var task exerciseapp.MistakeReviewTask
	var sourceAttemptID pgtype.Text
	var dailyAssignmentID pgtype.Text
	var dueAt pgtype.Timestamp
	var lastReviewAttemptID pgtype.Text
	var lastOutcome pgtype.Bool
	var lastReviewedAt pgtype.Timestamp
	var masteredAt pgtype.Timestamp
	var archivedAt pgtype.Timestamp
	var ownerTeacherID pgtype.Text
	var generatedByStudentID pgtype.Text
	var conceptIDsRaw []byte
	var metaRaw []byte
	if err := scanner.Scan(
		&task.ID,
		&task.StudentID,
		&task.ContentID,
		&sourceAttemptID,
		&dailyAssignmentID,
		&task.Status,
		&task.Stage,
		&task.ReviewCount,
		&task.SuccessfulReviewCount,
		&task.ErrorCount,
		&dueAt,
		&lastReviewAttemptID,
		&lastOutcome,
		&lastReviewedAt,
		&masteredAt,
		&archivedAt,
		&task.Revision,
		&task.CreatedAt,
		&task.UpdatedAt,
		&task.Exercise.ID,
		&ownerTeacherID,
		&generatedByStudentID,
		&task.Exercise.Status,
		&task.Exercise.Title,
		&task.Exercise.Body,
		&task.Exercise.Difficulty,
		&conceptIDsRaw,
		&metaRaw,
		&task.DailyCorrectionAvailable,
	); err != nil {
		return exerciseapp.MistakeReviewTask{}, err
	}
	if sourceAttemptID.Valid {
		task.SourceAttemptID = sourceAttemptID.String
	}
	if dailyAssignmentID.Valid {
		task.DailyAssignmentID = dailyAssignmentID.String
	}
	if dueAt.Valid {
		value := dueAt.Time
		task.DueAt = &value
	}
	if lastReviewAttemptID.Valid {
		task.LastReviewAttemptID = lastReviewAttemptID.String
	}
	if lastOutcome.Valid {
		value := lastOutcome.Bool
		task.LastOutcome = &value
	}
	if lastReviewedAt.Valid {
		value := lastReviewedAt.Time
		task.LastReviewedAt = &value
	}
	if masteredAt.Valid {
		value := masteredAt.Time
		task.MasteredAt = &value
	}
	if archivedAt.Valid {
		value := archivedAt.Time
		task.ArchivedAt = &value
	}
	if ownerTeacherID.Valid {
		task.Exercise.OwnerTeacherID = ownerTeacherID.String
	}
	if generatedByStudentID.Valid {
		task.Exercise.GeneratedByStudentID = generatedByStudentID.String
	}
	conceptIDs, err := decodeStringSlice(conceptIDsRaw)
	if err != nil {
		return exerciseapp.MistakeReviewTask{}, fmt.Errorf("decode review task concept ids: %w", err)
	}
	meta, err := decodeObjectMap(metaRaw)
	if err != nil {
		return exerciseapp.MistakeReviewTask{}, fmt.Errorf("decode review task meta: %w", err)
	}
	task.Exercise.ConceptIDs = conceptIDs
	task.Exercise.Meta = meta
	return task, nil
}
