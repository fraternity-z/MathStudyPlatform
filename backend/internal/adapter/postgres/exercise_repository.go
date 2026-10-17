package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	exerciseapp "mathstudy/backend/internal/application/exercise"
)

// ExerciseRepository persists adaptive exercise flow data in PostgreSQL.
type ExerciseRepository struct {
	Repository
}

// NewExerciseRepository creates a PostgreSQL-backed exercise repository.
func NewExerciseRepository(db Querier) (ExerciseRepository, error) {
	base, err := NewRepository(db)
	if err != nil {
		return ExerciseRepository{}, err
	}
	return ExerciseRepository{Repository: base}, nil
}

// WithTx runs fn in one database transaction when the repository is pool-backed.
func (r ExerciseRepository) WithTx(ctx context.Context, fn func(context.Context, exerciseapp.Repository) error) error {
	if fn == nil {
		return errors.New("exercise transaction function is nil")
	}
	return withRepositoryTx(ctx, "exercise", r.Repository, func(base Repository) ExerciseRepository {
		return ExerciseRepository{Repository: base}
	}, func(txRepo ExerciseRepository) error {
		return fn(ctx, txRepo)
	})
}

// LockStudentTracking serializes all exercise-state writes for one student
// until the surrounding submission transaction ends.
func (r ExerciseRepository) LockStudentTracking(ctx context.Context, userID string) error {
	return lockStudentTracking(ctx, r.DB(), userID)
}

// GetTeacherIDForStudent returns the teacher for the student's current class.
func (r ExerciseRepository) GetTeacherIDForStudent(ctx context.Context, userID string) (string, bool, error) {
	var teacherID string
	err := r.DB().QueryRow(ctx, `
		SELECT c.teacher_id
		FROM public.classes c
		JOIN public.class_enrollments ce ON ce.class_id = c.id
		WHERE ce.student_id = $1`,
		userID,
	).Scan(&teacherID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", false, nil
		}
		return "", false, err
	}
	return teacherID, true, nil
}

// GetLatestSession returns the newest learning session for one student.
func (r ExerciseRepository) GetLatestSession(ctx context.Context, userID string) (exerciseapp.LearningSession, bool, error) {
	row := r.DB().QueryRow(ctx, `
		SELECT id, student_id, current_content_id, contents_attempted
		FROM public.learning_sessions
		WHERE student_id = $1
		ORDER BY started_at DESC
		LIMIT 1`,
		userID,
	)
	return scanOptionalExerciseSession(row)
}

// CreateSession inserts a blank active session.
func (r ExerciseRepository) CreateSession(ctx context.Context, userID string, now time.Time) (exerciseapp.LearningSession, error) {
	id, err := newUUID()
	if err != nil {
		return exerciseapp.LearningSession{}, err
	}
	row := r.DB().QueryRow(ctx, `
		INSERT INTO public.learning_sessions (
			id,
			student_id,
			is_active,
			current_topic,
			current_content_id,
			contents_attempted,
			concepts_discussed,
			started_at,
			ended_at
		)
		VALUES ($1, $2, true, NULL, NULL, '[]'::json, '[]'::json, $3, NULL)
		RETURNING id, student_id, current_content_id, contents_attempted`,
		id,
		userID,
		now,
	)
	session, ok, err := scanOptionalExerciseSession(row)
	if err != nil {
		return exerciseapp.LearningSession{}, err
	}
	if !ok {
		return exerciseapp.LearningSession{}, pgx.ErrNoRows
	}
	return session, nil
}

// UpdateSessionCurrentContent stores or clears the current pending exercise.
func (r ExerciseRepository) UpdateSessionCurrentContent(ctx context.Context, sessionID string, contentID *string) error {
	_, err := r.DB().Exec(ctx, `
		UPDATE public.learning_sessions
		SET current_content_id = $2
		WHERE id = $1`,
		sessionID,
		contentID,
	)
	return err
}

// UpdateSessionAfterSubmit appends attempted content and clears it when it is the current class exercise.
func (r ExerciseRepository) UpdateSessionAfterSubmit(ctx context.Context, sessionID string, exerciseID string, attempted []string) error {
	raw, err := json.Marshal(attempted)
	if err != nil {
		return err
	}
	_, err = r.DB().Exec(ctx, `
		UPDATE public.learning_sessions
		SET
			contents_attempted = $3::json,
			current_content_id = CASE WHEN current_content_id = $2 THEN NULL ELSE current_content_id END
		WHERE id = $1`,
		sessionID,
		exerciseID,
		string(raw),
	)
	return err
}

// GetExercise returns a non-deleted problem content row.
func (r ExerciseRepository) GetExercise(ctx context.Context, exerciseID string) (exerciseapp.Exercise, bool, error) {
	row := r.DB().QueryRow(ctx, `
		SELECT `+exerciseSelectColumns+`
		FROM public.contents
		WHERE id = $1 AND type = 'PROBLEM' AND deleted_at IS NULL`,
		exerciseID,
	)
	return scanOptionalExercise(row)
}

// GetExerciseForUpdate holds a shared row lock until the surrounding submit transaction ends.
func (r ExerciseRepository) GetExerciseForUpdate(ctx context.Context, exerciseID string) (exerciseapp.Exercise, bool, error) {
	row := r.DB().QueryRow(ctx, `
		SELECT `+exerciseSelectColumns+`
		FROM public.contents
		WHERE id = $1 AND type = 'PROBLEM' AND deleted_at IS NULL
		FOR SHARE`,
		exerciseID,
	)
	return scanOptionalExercise(row)
}

// GetDailyAssignment returns the submission binding without locking it.
func (r ExerciseRepository) GetDailyAssignment(ctx context.Context, assignmentID string, studentID string) (exerciseapp.DailyAssignmentBinding, bool, error) {
	return r.getDailyAssignment(ctx, assignmentID, studentID, false)
}

// GetDailyAssignmentForUpdate serializes first-result and correction attachment.
func (r ExerciseRepository) GetDailyAssignmentForUpdate(ctx context.Context, assignmentID string, studentID string) (exerciseapp.DailyAssignmentBinding, bool, error) {
	return r.getDailyAssignment(ctx, assignmentID, studentID, true)
}

// GetDailySubmissionResponse returns the committed response for one idempotent daily submission.
func (r ExerciseRepository) GetDailySubmissionResponse(
	ctx context.Context,
	assignmentID string,
	studentID string,
	submissionKey string,
) (exerciseapp.SubmitResponse, bool, error) {
	var raw []byte
	err := r.DB().QueryRow(ctx, `
		SELECT attempt.daily_submission_response
		FROM public.content_attempts attempt
		WHERE attempt.daily_assignment_id = $1
		  AND attempt.student_id = $2
		  AND attempt.daily_submission_key = $3
		  AND attempt.daily_submission_response IS NOT NULL`,
		assignmentID,
		studentID,
		submissionKey,
	).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return exerciseapp.SubmitResponse{}, false, nil
	}
	if err != nil {
		return exerciseapp.SubmitResponse{}, false, err
	}
	var response exerciseapp.SubmitResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return exerciseapp.SubmitResponse{}, false, fmt.Errorf("decode daily submission response: %w", err)
	}
	return response, true, nil
}

// GetMistakeRedoSubmissionResponse returns the committed response for one
// student-scoped redo submission and rejects reuse against another payload.
func (r ExerciseRepository) GetMistakeRedoSubmissionResponse(
	ctx context.Context,
	studentID string,
	originalAttemptID string,
	submissionKey string,
	submissionDigest string,
) (exerciseapp.SubmitResponse, bool, error) {
	var storedOriginalAttemptID pgtype.Text
	var storedDigest string
	var raw []byte
	err := r.DB().QueryRow(ctx, `
		SELECT attempt.mistake_redo_original_attempt_id,
		       attempt.mistake_redo_submission_digest,
		       attempt.mistake_redo_submission_response
		FROM public.content_attempts attempt
		WHERE attempt.student_id = $1
		  AND attempt.mistake_redo_submission_id = $2`,
		studentID,
		submissionKey,
	).Scan(&storedOriginalAttemptID, &storedDigest, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return exerciseapp.SubmitResponse{}, false, nil
	}
	if err != nil {
		return exerciseapp.SubmitResponse{}, false, err
	}
	if (storedOriginalAttemptID.Valid && storedOriginalAttemptID.String != originalAttemptID) || storedDigest != submissionDigest {
		return exerciseapp.SubmitResponse{}, false, exerciseapp.ErrSubmissionConflict
	}
	if len(raw) == 0 {
		return exerciseapp.SubmitResponse{}, false, fmt.Errorf("mistake redo submission response is incomplete")
	}
	var response exerciseapp.SubmitResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return exerciseapp.SubmitResponse{}, false, fmt.Errorf("decode mistake redo submission response: %w", err)
	}
	return response, true, nil
}

// GetRegularSubmissionResponse returns the committed response for one
// student-scoped ordinary exercise submission.
func (r ExerciseRepository) GetRegularSubmissionResponse(
	ctx context.Context,
	studentID string,
	submissionKey string,
	submissionDigest string,
) (exerciseapp.SubmitResponse, bool, error) {
	var storedDigest string
	var raw []byte
	err := r.DB().QueryRow(ctx, `
		SELECT attempt.regular_submission_digest,
		       attempt.regular_submission_response
		FROM public.content_attempts attempt
		WHERE attempt.student_id = $1
		  AND attempt.regular_submission_id = $2`,
		studentID,
		submissionKey,
	).Scan(&storedDigest, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return exerciseapp.SubmitResponse{}, false, nil
	}
	if err != nil {
		return exerciseapp.SubmitResponse{}, false, err
	}
	if storedDigest != submissionDigest {
		return exerciseapp.SubmitResponse{}, false, exerciseapp.ErrSubmissionConflict
	}
	if len(raw) == 0 {
		return exerciseapp.SubmitResponse{}, false, fmt.Errorf("regular submission response is incomplete")
	}
	var response exerciseapp.SubmitResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return exerciseapp.SubmitResponse{}, false, fmt.Errorf("decode regular submission response: %w", err)
	}
	return response, true, nil
}

func (r ExerciseRepository) getDailyAssignment(
	ctx context.Context,
	assignmentID string,
	studentID string,
	forUpdate bool,
) (exerciseapp.DailyAssignmentBinding, bool, error) {
	query := dailyAssignmentBindingSelect + `
		WHERE assignment.id = $1 AND assignment.student_id = $2`
	if forUpdate {
		query += ` FOR UPDATE OF assignment`
	}
	row := r.DB().QueryRow(ctx, query, assignmentID, studentID)
	return scanOptionalDailyAssignmentBinding(row)
}

// HasReadyDailyAssignmentContent prevents the regular solution route from
// bypassing a daily assignment's own first-attempt gate.
func (r ExerciseRepository) HasReadyDailyAssignmentContent(ctx context.Context, studentID string, contentID string) (bool, error) {
	var assigned bool
	err := r.DB().QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM public.daily_question_assignments assignment
			WHERE assignment.student_id = $1
			  AND assignment.content_id = $2
			  AND assignment.status = 'ready'
		)`, studentID, contentID).Scan(&assigned)
	return assigned, err
}

// GetMistakeRedoAttemptBinding revalidates the original error evidence while
// the caller holds the per-student submission lock.
func (r ExerciseRepository) GetMistakeRedoAttemptBinding(
	ctx context.Context,
	studentID string,
	attemptID string,
) (exerciseapp.MistakeRedoAttemptBinding, bool, error) {
	var binding exerciseapp.MistakeRedoAttemptBinding
	var ownerTeacherID pgtype.Text
	var generatedByStudentID pgtype.Text
	var conceptIDsRaw []byte
	var metaRaw []byte
	err := r.DB().QueryRow(ctx, `
		SELECT ca.content_id,
		       coalesce(ca.mistake_redo_original_attempt_id, ''),
		       ca.is_correct,
		       coalesce(ca.process_evaluation->>'status' = 'incorrect', false),
		       ca.submitted_at IS NOT NULL,
		       EXISTS (
		           SELECT 1
		           FROM public.diagnosis_reports diagnosis
		           WHERE diagnosis.attempt_id = ca.id
		       ),
		       EXISTS (
		           SELECT 1
		           FROM public.mistake_record_archives archive
		           WHERE archive.attempt_id = ca.id
		             AND archive.student_id = ca.student_id
		       ),
		       ca.content_id,
		       c.owner_teacher_id,
		       coalesce(
		           ca.review_question_generated_by_student_id,
		           daily_assignment.question_generated_by_student_id,
		           c.generated_by_student_id
		       ),
		       'PUBLISHED'::text,
		       coalesce(ca.review_question_title, daily_assignment.question_title, c.title),
		       coalesce(ca.review_question_body, daily_assignment.question_body, c.body),
		       coalesce(ca.review_question_difficulty, daily_assignment.question_difficulty, c.difficulty),
		       `+mistakeQuestionConceptIDs+`,
		       coalesce(ca.review_question_meta, daily_assignment.question_meta, c.meta)
		FROM public.content_attempts ca
		JOIN public.contents c ON c.id = ca.content_id
		`+mistakeDailyAssignmentJoin+`
		WHERE ca.id = $1
		  AND ca.student_id = $2
		  AND `+mistakeRepresentativeAttemptPredicate+`
		FOR SHARE OF ca, c`,
		attemptID,
		studentID,
	).Scan(
		&binding.ContentID,
		&binding.RedoOriginalAttemptID,
		&binding.IsCorrect,
		&binding.ProcessIncorrect,
		&binding.IsSubmitted,
		&binding.HasDiagnosis,
		&binding.IsArchived,
		&binding.Exercise.ID,
		&ownerTeacherID,
		&generatedByStudentID,
		&binding.Exercise.Status,
		&binding.Exercise.Title,
		&binding.Exercise.Body,
		&binding.Exercise.Difficulty,
		&conceptIDsRaw,
		&metaRaw,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return exerciseapp.MistakeRedoAttemptBinding{}, false, nil
	}
	if err != nil {
		return exerciseapp.MistakeRedoAttemptBinding{}, false, err
	}
	if ownerTeacherID.Valid {
		binding.Exercise.OwnerTeacherID = ownerTeacherID.String
	}
	if generatedByStudentID.Valid {
		binding.Exercise.GeneratedByStudentID = generatedByStudentID.String
	}
	conceptIDs, err := decodeStringSlice(conceptIDsRaw)
	if err != nil {
		return exerciseapp.MistakeRedoAttemptBinding{}, false, fmt.Errorf("decode mistake redo concept ids: %w", err)
	}
	meta, err := decodeObjectMap(metaRaw)
	if err != nil {
		return exerciseapp.MistakeRedoAttemptBinding{}, false, fmt.Errorf("decode mistake redo meta: %w", err)
	}
	binding.Exercise.ConceptIDs = conceptIDs
	binding.Exercise.Meta = meta
	return binding, true, nil
}

// ApplyDailyAttempt records the immutable first result or the first successful correction.
func (r ExerciseRepository) ApplyDailyAttempt(ctx context.Context, update exerciseapp.DailyAttemptUpdate) error {
	result, err := r.DB().Exec(ctx, `
		UPDATE public.daily_question_assignments
		SET
			first_attempt_id = CASE WHEN status = 'ready' THEN $4 ELSE first_attempt_id END,
			first_result = CASE
				WHEN status = 'ready' AND $5 THEN 'correct'
				WHEN status = 'ready' THEN 'incorrect'
				ELSE first_result
			END,
			corrected_attempt_id = CASE
				WHEN status = 'completed' AND first_result = 'incorrect' AND $5 THEN $4
				ELSE corrected_attempt_id
			END,
			status = 'completed',
			completed_at = CASE WHEN status = 'ready' THEN $6 ELSE completed_at END,
			counts_toward_streak = CASE WHEN status = 'ready' THEN $7 ELSE counts_toward_streak END,
			opened_at = coalesce(opened_at, $6),
			updated_at = $6
		WHERE
			id = $1 AND
			student_id = $2 AND
			content_id = $3 AND
			(
				status = 'ready' OR
				(status = 'completed' AND first_result = 'incorrect' AND corrected_attempt_id IS NULL)
			)`,
		update.AssignmentID,
		update.StudentID,
		update.ContentID,
		update.AttemptID,
		update.IsCorrect,
		update.SubmittedAt,
		update.OnTime,
	)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return exerciseapp.ErrDailyAssignmentClosed
	}
	return nil
}

func scanOptionalDailyAssignmentBinding(scanner rowScanner) (exerciseapp.DailyAssignmentBinding, bool, error) {
	var binding exerciseapp.DailyAssignmentBinding
	var assignmentDate time.Time
	var contentID pgtype.Text
	var firstAttemptID pgtype.Text
	var firstResult pgtype.Text
	var correctedAttemptID pgtype.Text
	var questionID pgtype.Text
	var title pgtype.Text
	var body pgtype.Text
	var difficulty pgtype.Float8
	var conceptIDsRaw []byte
	var metaRaw []byte
	var generatedBy pgtype.Text
	if err := scanner.Scan(
		&binding.ID,
		&binding.StudentID,
		&assignmentDate,
		&contentID,
		&binding.Status,
		&firstAttemptID,
		&firstResult,
		&correctedAttemptID,
		&questionID,
		&title,
		&body,
		&difficulty,
		&conceptIDsRaw,
		&metaRaw,
		&generatedBy,
	); err != nil {
		if err == pgx.ErrNoRows {
			return exerciseapp.DailyAssignmentBinding{}, false, nil
		}
		return exerciseapp.DailyAssignmentBinding{}, false, err
	}
	binding.AssignmentDate = assignmentDate.Format("2006-01-02")
	if contentID.Valid {
		binding.ContentID = contentID.String
	}
	if firstAttemptID.Valid {
		binding.FirstAttemptID = firstAttemptID.String
	}
	if firstResult.Valid {
		binding.FirstResult = firstResult.String
	}
	if correctedAttemptID.Valid {
		binding.CorrectedAttemptID = correctedAttemptID.String
	}
	if !questionID.Valid || !title.Valid || !body.Valid || !difficulty.Valid || conceptIDsRaw == nil || metaRaw == nil {
		return binding, true, nil
	}
	conceptIDs, err := decodeStringSlice(conceptIDsRaw)
	if err != nil {
		return exerciseapp.DailyAssignmentBinding{}, false, fmt.Errorf("decode daily assignment snapshot concept ids: %w", err)
	}
	meta, err := decodeObjectMap(metaRaw)
	if err != nil {
		return exerciseapp.DailyAssignmentBinding{}, false, fmt.Errorf("decode daily assignment snapshot meta: %w", err)
	}
	binding.Question = &exerciseapp.Exercise{
		ID:                   questionID.String,
		Status:               "PUBLISHED",
		Title:                title.String,
		Body:                 body.String,
		Difficulty:           difficulty.Float64,
		ConceptIDs:           conceptIDs,
		Meta:                 meta,
		GeneratedByStudentID: generatedBy.String,
	}
	return binding, true, nil
}

// GetKnowledgeConcept returns trusted knowledge context for AI exercise generation.
func (r ExerciseRepository) GetKnowledgeConcept(ctx context.Context, conceptID string) (exerciseapp.KnowledgeConcept, bool, error) {
	var concept exerciseapp.KnowledgeConcept
	var chapter pgtype.Text
	err := r.DB().QueryRow(ctx, `
		SELECT id, name, description, chapter
		FROM public.course_concepts
		WHERE id = $1`,
		conceptID,
	).Scan(&concept.ID, &concept.Name, &concept.Description, &chapter)
	if err != nil {
		if err == pgx.ErrNoRows {
			return exerciseapp.KnowledgeConcept{}, false, nil
		}
		return exerciseapp.KnowledgeConcept{}, false, err
	}
	if chapter.Valid {
		concept.Chapter = chapter.String
	}
	return concept, true, nil
}

// CreateGeneratedExercise persists one published student-owned AI exercise.
func (r ExerciseRepository) CreateGeneratedExercise(ctx context.Context, studentID string, generated exerciseapp.GeneratedQuestion, now time.Time) (exerciseapp.Exercise, error) {
	exerciseID, err := newUUID()
	if err != nil {
		return exerciseapp.Exercise{}, err
	}
	conceptIDsRaw, err := json.Marshal(generated.ConceptIDs)
	if err != nil {
		return exerciseapp.Exercise{}, fmt.Errorf("encode generated exercise concept ids: %w", err)
	}
	metaRaw, err := json.Marshal(generatedQuestionMeta(generated))
	if err != nil {
		return exerciseapp.Exercise{}, fmt.Errorf("encode generated exercise meta: %w", err)
	}
	row := r.DB().QueryRow(ctx, `
		INSERT INTO public.contents (
			id,
			type,
			owner_teacher_id,
			generated_by_student_id,
			status,
			title,
			body,
			difficulty,
			concept_ids,
			tags,
			meta,
			created_at,
			updated_at,
			published_at,
			deleted_at
		)
		VALUES ($1, 'PROBLEM'::public.contenttype, NULL, $2, 'PUBLISHED'::public.contentstatus, $3, $4, $5, $6::json, '[]'::json, $7::json, $8, $8, $8, NULL)
		RETURNING `+exerciseSelectColumns,
		exerciseID,
		studentID,
		generated.Title,
		generated.Body,
		generated.Difficulty,
		string(conceptIDsRaw),
		string(metaRaw),
		now,
	)
	exercise, ok, err := scanOptionalExercise(row)
	if err != nil {
		return exerciseapp.Exercise{}, err
	}
	if !ok {
		return exerciseapp.Exercise{}, pgx.ErrNoRows
	}
	return exercise, nil
}

// ListRecentContentIDs returns recent class-exercise IDs without self-practice attempts.
func (r ExerciseRepository) ListRecentContentIDs(ctx context.Context, userID string, limit int) ([]string, error) {
	rows, err := r.DB().Query(ctx, recentClassContentIDsSQL,
		userID,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

const recentClassContentIDsSQL = `
	SELECT ca.content_id
	FROM public.content_attempts ca
	JOIN public.contents c ON c.id = ca.content_id
	WHERE ca.student_id = $1 AND c.generated_by_student_id IS NULL
	ORDER BY ca.started_at DESC
	LIMIT $2`

// ListCandidateExercises returns published teacher-owned problems in a difficulty window.
func (r ExerciseRepository) ListCandidateExercises(ctx context.Context, filter exerciseapp.CandidateFilter) ([]exerciseapp.Exercise, error) {
	rows, err := r.DB().Query(ctx, `
		SELECT `+exerciseSelectColumns+`
		FROM public.contents content
		WHERE
			content.type = 'PROBLEM' AND
			content.status = 'PUBLISHED' AND
			content.deleted_at IS NULL AND
			content.owner_teacher_id = $1 AND
			content.difficulty >= $2 AND
			content.difficulty <= $3 AND
			(coalesce(cardinality($4::varchar[]), 0) = 0 OR NOT (content.id = ANY($4::varchar[]))) AND
			NOT EXISTS (
				SELECT 1
				FROM public.daily_question_assignments assignment
				WHERE assignment.student_id = $5
				  AND assignment.content_id = content.id
				  AND assignment.status = 'ready'
			)
		ORDER BY content.difficulty ASC, content.id ASC
		LIMIT $6`,
		filter.TeacherID,
		filter.DifficultyMin,
		filter.DifficultyMax,
		filter.ExcludeContent,
		filter.StudentID,
		filter.Limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	exercises := []exerciseapp.Exercise{}
	for rows.Next() {
		exercise, err := scanExercise(rows)
		if err != nil {
			return nil, err
		}
		exercises = append(exercises, exercise)
	}
	return exercises, rows.Err()
}

// GetProfile returns the student's exercise tracking profile.
func (r ExerciseRepository) GetProfile(ctx context.Context, userID string) (exerciseapp.StudentProfile, bool, error) {
	row := r.DB().QueryRow(ctx, `
		SELECT `+exerciseProfileColumns+`
		FROM public.student_profiles
		WHERE student_id = $1`,
		userID,
	)
	return scanOptionalExerciseProfile(row)
}

// CreateProfile inserts default tracking state or returns a concurrently created profile.
func (r ExerciseRepository) CreateProfile(ctx context.Context, userID string, now time.Time) (exerciseapp.StudentProfile, error) {
	profileID, err := newUUID()
	if err != nil {
		return exerciseapp.StudentProfile{}, err
	}
	row := r.DB().QueryRow(ctx, `
		INSERT INTO public.student_profiles (
			id,
			student_id,
			mastery_vector,
			error_tendency,
			preferred_difficulty,
			learning_pace,
			total_exercises,
			correct_count,
			total_study_time_minutes,
			recent_concepts,
			updated_at,
			portrait_version
		)
		VALUES ($1, $2, '{}'::json, '{}'::json, 0.5, 1.0, 0, 0, 0, '[]'::json, $3, 0)
		ON CONFLICT (student_id) DO UPDATE SET student_id = EXCLUDED.student_id
		RETURNING `+exerciseProfileColumns,
		profileID,
		userID,
		now,
	)
	profile, ok, err := scanOptionalExerciseProfile(row)
	if err != nil {
		return exerciseapp.StudentProfile{}, err
	}
	if !ok {
		return exerciseapp.StudentProfile{}, pgx.ErrNoRows
	}
	return profile, nil
}

// HasSubmittedAttempt reports whether the student has attempted the exercise.
func (r ExerciseRepository) HasSubmittedAttempt(ctx context.Context, userID string, exerciseID string) (bool, error) {
	return r.Exists(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM public.content_attempts
			WHERE student_id = $1 AND content_id = $2 AND submitted_at IS NOT NULL
		)`,
		userID,
		exerciseID,
	)
}

// ListDKTStates returns current DKT state rows for the requested concepts.
func (r ExerciseRepository) ListDKTStates(ctx context.Context, userID string, conceptIDs []string) (map[string]exerciseapp.DKTState, error) {
	states := map[string]exerciseapp.DKTState{}
	if len(conceptIDs) == 0 {
		return states, nil
	}
	rows, err := r.DB().Query(ctx, `
		SELECT
			id,
			student_id,
			concept_id,
			mastery_prob,
			confidence,
			attempt_count,
			correct_count,
			incorrect_count,
			sequence_length,
			attention_weight,
			last_outcome,
			last_exercise_id,
			last_attempt_at,
			created_at,
			updated_at
		FROM public.student_concept_dkt_states
		WHERE student_id = $1 AND concept_id = ANY($2::varchar[])`,
		userID,
		conceptIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var state exerciseapp.DKTState
		var lastOutcome pgtype.Bool
		var lastExerciseID pgtype.Text
		var lastAttemptAt pgtype.Timestamp
		if err := rows.Scan(
			&state.ID,
			&state.StudentID,
			&state.ConceptID,
			&state.MasteryProb,
			&state.Confidence,
			&state.AttemptCount,
			&state.CorrectCount,
			&state.IncorrectCount,
			&state.SequenceLength,
			&state.AttentionWeight,
			&lastOutcome,
			&lastExerciseID,
			&lastAttemptAt,
			&state.CreatedAt,
			&state.UpdatedAt,
		); err != nil {
			return nil, err
		}
		state.LastOutcome = boolPtr(lastOutcome)
		state.LastExerciseID = textPtr(lastExerciseID)
		state.LastAttemptAt = timestampPtr(lastAttemptAt)
		states[state.ConceptID] = state
	}
	return states, rows.Err()
}

// ListRecentInteractions returns recent submitted exercise events for sequence-based DKT.
func (r ExerciseRepository) ListRecentInteractions(ctx context.Context, userID string, excludeAttemptID string, limit int) ([]exerciseapp.LearningInteraction, error) {
	if limit < 1 {
		return []exerciseapp.LearningInteraction{}, nil
	}
	rows, err := r.DB().Query(ctx, `
		SELECT
			ca.id,
			ca.content_id,
			ca.review_question_concept_ids,
			ca.is_correct,
			ca.review_question_difficulty,
			ca.mastery_weight,
			ca.submitted_at
		FROM public.content_attempts ca
		WHERE ca.student_id = $1
		  AND ca.submitted_at IS NOT NULL
		  AND ca.id <> $2
		  AND ca.mastery_weight > 0
		ORDER BY ca.submitted_at DESC, ca.id DESC
		LIMIT $3`,
		userID,
		excludeAttemptID,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	interactions := []exerciseapp.LearningInteraction{}
	for rows.Next() {
		var interaction exerciseapp.LearningInteraction
		var conceptIDsRaw []byte
		if err := rows.Scan(
			&interaction.AttemptID,
			&interaction.ExerciseID,
			&conceptIDsRaw,
			&interaction.IsCorrect,
			&interaction.Difficulty,
			&interaction.MasteryWeight,
			&interaction.SubmittedAt,
		); err != nil {
			return nil, err
		}
		conceptIDs, err := decodeStringSlice(conceptIDsRaw)
		if err != nil {
			return nil, fmt.Errorf("decode interaction concept ids: %w", err)
		}
		interaction.ConceptIDs = conceptIDs
		interactions = append(interactions, interaction)
	}
	return interactions, rows.Err()
}

// InsertAttempt inserts a submitted answer attempt.
func (r ExerciseRepository) InsertAttempt(ctx context.Context, record exerciseapp.AttemptRecord) error {
	processRaw, err := json.Marshal(record.ProcessEvaluation)
	if err != nil {
		return err
	}
	stepsRaw, err := json.Marshal(record.StudentSteps)
	if err != nil {
		return err
	}
	var dailyAssignmentID any
	var dailySubmissionKey any
	if record.DailyAssignmentID != "" {
		dailyAssignmentID = record.DailyAssignmentID
		if record.DailySubmissionKey != "" {
			dailySubmissionKey = record.DailySubmissionKey
		}
	}
	var reviewTaskID any
	var reviewSubmissionKey any
	var reviewSubmissionDigest any
	var redoOriginalAttemptID any
	var redoSubmissionID any
	var redoSubmissionDigest any
	var regularSubmissionID any
	var regularSubmissionDigest any
	var reviewQuestionTitle any
	var reviewQuestionBody any
	var reviewQuestionConceptIDs any
	var reviewQuestionDifficulty any
	var reviewQuestionMeta any
	var reviewQuestionGeneratedByStudentID any
	if record.QuestionSnapshot == nil {
		return errors.New("submitted attempt question snapshot is nil")
	}
	if record.ReviewTaskID != "" {
		if record.ReviewSubmissionKey == "" || record.ReviewSubmissionDigest == "" {
			return errors.New("review submission idempotency binding is incomplete")
		}
		reviewTaskID = record.ReviewTaskID
		reviewSubmissionKey = record.ReviewSubmissionKey
		reviewSubmissionDigest = record.ReviewSubmissionDigest
	}
	if record.QuestionSnapshot != nil {
		reviewQuestionTitle = record.QuestionSnapshot.Title
		reviewQuestionBody = record.QuestionSnapshot.Body
		conceptIDs := record.QuestionSnapshot.ConceptIDs
		if conceptIDs == nil {
			conceptIDs = []string{}
		}
		conceptIDsRaw, marshalErr := json.Marshal(conceptIDs)
		if marshalErr != nil {
			return marshalErr
		}
		meta := record.QuestionSnapshot.Meta
		if meta == nil {
			meta = map[string]any{}
		}
		metaRaw, marshalErr := json.Marshal(meta)
		if marshalErr != nil {
			return marshalErr
		}
		reviewQuestionConceptIDs = string(conceptIDsRaw)
		reviewQuestionDifficulty = record.QuestionSnapshot.Difficulty
		reviewQuestionMeta = string(metaRaw)
		if record.QuestionSnapshot.GeneratedByStudentID != "" {
			reviewQuestionGeneratedByStudentID = record.QuestionSnapshot.GeneratedByStudentID
		}
	}
	if record.RedoOriginalAttemptID != "" || record.RedoSubmissionKey != "" || record.RedoSubmissionDigest != "" {
		if record.RedoOriginalAttemptID == "" || record.RedoSubmissionKey == "" || record.RedoSubmissionDigest == "" || record.ReviewTaskID != "" {
			return errors.New("mistake redo idempotency binding is incomplete")
		}
		redoOriginalAttemptID = record.RedoOriginalAttemptID
		redoSubmissionID = record.RedoSubmissionKey
		redoSubmissionDigest = record.RedoSubmissionDigest
	}
	if record.RegularSubmissionKey != "" || record.RegularSubmissionDigest != "" {
		if record.RegularSubmissionKey == "" || record.RegularSubmissionDigest == "" ||
			record.DailyAssignmentID != "" || record.ReviewTaskID != "" || record.RedoOriginalAttemptID != "" {
			return errors.New("regular submission idempotency binding is incomplete")
		}
		regularSubmissionID = record.RegularSubmissionKey
		regularSubmissionDigest = record.RegularSubmissionDigest
	}
	_, err = r.DB().Exec(ctx, `
		INSERT INTO public.content_attempts (
			id,
			content_id,
			student_id,
			daily_assignment_id,
			daily_submission_key,
			review_task_id,
			review_submission_key,
			review_submission_digest,
			mistake_redo_original_attempt_id,
			mistake_redo_submission_id,
			mistake_redo_submission_digest,
			regular_submission_id,
			regular_submission_digest,
			review_question_title,
			review_question_body,
			review_question_concept_ids,
			review_question_difficulty,
			review_question_meta,
			review_question_generated_by_student_id,
			mastery_weight,
			student_answer,
			student_steps,
			is_correct,
			score,
			started_at,
			submitted_at,
			time_spent_seconds,
			assistance_status,
			evidence_kind,
			process_evaluation,
			reported_time_spent_seconds
		)
			VALUES (
				$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::json, $17,
				$18::json, $19, $20, $21, $22::json, $23, $24, $25, $26, $27, $28, $29, $30::jsonb, $31
			)`,
		record.ID,
		record.ContentID,
		record.StudentID,
		dailyAssignmentID,
		dailySubmissionKey,
		reviewTaskID,
		reviewSubmissionKey,
		reviewSubmissionDigest,
		redoOriginalAttemptID,
		redoSubmissionID,
		redoSubmissionDigest,
		regularSubmissionID,
		regularSubmissionDigest,
		reviewQuestionTitle,
		reviewQuestionBody,
		reviewQuestionConceptIDs,
		reviewQuestionDifficulty,
		reviewQuestionMeta,
		reviewQuestionGeneratedByStudentID,
		record.MasteryWeight,
		record.StudentAnswer,
		string(stepsRaw),
		record.IsCorrect,
		record.Score,
		record.StartedAt,
		record.SubmittedAt,
		record.TimeSpentSeconds,
		record.AssistanceStatus,
		record.EvidenceKind,
		string(processRaw),
		record.ReportedTimeSpentSeconds,
	)
	return err
}

// SaveRegularSubmissionResponse completes an ordinary submission's
// idempotency record in the same transaction as its learning-state updates.
func (r ExerciseRepository) SaveRegularSubmissionResponse(
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
		SET regular_submission_response = $5::json
		WHERE id = $1
		  AND student_id = $2
		  AND regular_submission_id = $3
		  AND regular_submission_digest = $4
		  AND daily_assignment_id IS NULL
		  AND review_task_id IS NULL
		  AND mistake_redo_original_attempt_id IS NULL`,
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

// SaveMistakeRedoSubmissionResponse completes a historical redo's idempotency
// record in the same transaction as the attempt and tracking updates.
func (r ExerciseRepository) SaveMistakeRedoSubmissionResponse(
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
		SET mistake_redo_submission_response = $5::json
		WHERE id = $1
		  AND student_id = $2
		  AND mistake_redo_submission_id = $3
		  AND mistake_redo_submission_digest = $4
		  AND mistake_redo_original_attempt_id IS NOT NULL`,
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

// SaveDailySubmissionResponse completes the idempotency record in the attempt transaction.
func (r ExerciseRepository) SaveDailySubmissionResponse(
	ctx context.Context,
	attemptID string,
	studentID string,
	submissionKey string,
	response exerciseapp.SubmitResponse,
) error {
	raw, err := json.Marshal(response)
	if err != nil {
		return err
	}
	tag, err := r.DB().Exec(ctx, `
		UPDATE public.content_attempts
		SET daily_submission_response = $4::json
		WHERE id = $1
		  AND student_id = $2
		  AND daily_submission_key = $3
		  AND daily_assignment_id IS NOT NULL`,
		attemptID,
		studentID,
		submissionKey,
		string(raw),
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return exerciseapp.ErrDailyAssignmentClosed
	}
	return nil
}

// InsertDiagnosis inserts a lightweight diagnosis report.
func (r ExerciseRepository) InsertDiagnosis(ctx context.Context, record exerciseapp.DiagnosisRecord) error {
	relatedRaw, err := json.Marshal(record.RelatedConcept)
	if err != nil {
		return err
	}
	var errorType any
	if record.ErrorType != nil {
		errorType = *record.ErrorType
	}
	_, err = r.DB().Exec(ctx, `
		INSERT INTO public.diagnosis_reports (
			id,
			attempt_id,
			error_step_index,
			bifurcation_point,
			error_type,
			error_subtype,
			severity,
			related_concept_ids,
			related_misconception_ids,
			explanation,
			suggestion,
			recommended_resources,
			created_at
		)
		VALUES ($1, $2, NULL, NULL, $3::public.errortype, $4, $5, $6::json, '[]'::json, $7, $8, '[]'::json, $9)`,
		record.ID,
		record.AttemptID,
		errorType,
		record.ErrorSubtype,
		record.Severity,
		string(relatedRaw),
		record.Explanation,
		record.Suggestion,
		record.CreatedAt,
	)
	return err
}

// UpsertDKTStates writes student concept DKT states.
func (r ExerciseRepository) UpsertDKTStates(ctx context.Context, states []exerciseapp.DKTState) error {
	for _, state := range states {
		_, err := r.DB().Exec(ctx, `
			INSERT INTO public.student_concept_dkt_states (
				id,
				student_id,
				concept_id,
				mastery_prob,
				confidence,
				attempt_count,
				correct_count,
				incorrect_count,
				sequence_length,
				attention_weight,
				last_outcome,
				last_exercise_id,
				last_attempt_at,
				created_at,
				updated_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
			ON CONFLICT ON CONSTRAINT uq_student_concept_dkt_state DO UPDATE SET
				mastery_prob = EXCLUDED.mastery_prob,
				confidence = EXCLUDED.confidence,
				attempt_count = EXCLUDED.attempt_count,
				correct_count = EXCLUDED.correct_count,
				incorrect_count = EXCLUDED.incorrect_count,
				sequence_length = EXCLUDED.sequence_length,
				attention_weight = EXCLUDED.attention_weight,
				last_outcome = EXCLUDED.last_outcome,
				last_exercise_id = EXCLUDED.last_exercise_id,
				last_attempt_at = EXCLUDED.last_attempt_at,
				updated_at = EXCLUDED.updated_at`,
			state.ID,
			state.StudentID,
			state.ConceptID,
			state.MasteryProb,
			state.Confidence,
			state.AttemptCount,
			state.CorrectCount,
			state.IncorrectCount,
			state.SequenceLength,
			state.AttentionWeight,
			state.LastOutcome,
			state.LastExerciseID,
			state.LastAttemptAt,
			state.CreatedAt,
			state.UpdatedAt,
		)
		if err != nil {
			return err
		}
	}
	return nil
}

// UpdateProfileTracking stores updated mastery and counters.
func (r ExerciseRepository) UpdateProfileTracking(ctx context.Context, userID string, update exerciseapp.ProfileTrackingUpdate) error {
	masteryRaw, err := json.Marshal(update.MasteryVector)
	if err != nil {
		return err
	}
	errorRaw, err := json.Marshal(update.ErrorTendency)
	if err != nil {
		return err
	}
	_, err = r.DB().Exec(ctx, `
		UPDATE public.student_profiles
		SET
			mastery_vector = $2::json,
			error_tendency = $3::json,
			total_exercises = $4,
			correct_count = $5,
			updated_at = $6
		WHERE student_id = $1`,
		userID,
		string(masteryRaw),
		string(errorRaw),
		update.TotalExercises,
		update.CorrectCount,
		update.UpdatedAt,
	)
	return err
}

const exerciseSelectColumns = `
	id,
	owner_teacher_id,
	generated_by_student_id,
	status::text,
	title,
	body,
	difficulty,
	concept_ids,
	meta`

const dailyAssignmentBindingSelect = `
	SELECT assignment.id,
	       assignment.student_id,
	       assignment.assignment_date,
	       assignment.content_id,
	       assignment.status,
	       first_attempt.id,
	       assignment.first_result,
	       assignment.corrected_attempt_id,
	       CASE WHEN assignment.question_body IS NOT NULL THEN assignment.content_id ELSE content.id END,
	       coalesce(assignment.question_title, content.title),
	       coalesce(assignment.question_body, content.body),
	       coalesce(assignment.question_difficulty, content.difficulty),
	       coalesce(assignment.question_concept_ids, content.concept_ids),
	       coalesce(assignment.question_meta, content.meta),
	       coalesce(assignment.question_generated_by_student_id, content.generated_by_student_id)
	FROM public.daily_question_assignments assignment
	LEFT JOIN public.contents content
	  ON content.id = assignment.content_id
	 AND content.type = 'PROBLEM'::public.contenttype
	LEFT JOIN public.content_attempts first_attempt
	  ON first_attempt.id = assignment.first_attempt_id
	 AND first_attempt.student_id = assignment.student_id
	 AND first_attempt.content_id = assignment.content_id
	 AND (
		 first_attempt.daily_assignment_id = assignment.id
		 OR first_attempt.daily_assignment_id IS NULL
	 )`

const exerciseProfileColumns = `
	mastery_vector,
	error_tendency,
	preferred_difficulty,
	learning_pace,
	total_exercises,
	correct_count`

func scanOptionalExerciseProfile(row pgx.Row) (exerciseapp.StudentProfile, bool, error) {
	var profile exerciseapp.StudentProfile
	var masteryRaw []byte
	var errorRaw []byte
	err := row.Scan(
		&masteryRaw,
		&errorRaw,
		&profile.PreferredDifficulty,
		&profile.LearningPace,
		&profile.TotalExercises,
		&profile.CorrectCount,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return exerciseapp.StudentProfile{}, false, nil
		}
		return exerciseapp.StudentProfile{}, false, err
	}
	mastery, err := decodeFloatMap(masteryRaw)
	if err != nil {
		return exerciseapp.StudentProfile{}, false, fmt.Errorf("decode mastery vector: %w", err)
	}
	errorTendency, err := decodeFloatMap(errorRaw)
	if err != nil {
		return exerciseapp.StudentProfile{}, false, fmt.Errorf("decode error tendency: %w", err)
	}
	profile.MasteryVector = mastery
	profile.ErrorTendency = errorTendency
	return profile, true, nil
}

func scanOptionalExerciseSession(row pgx.Row) (exerciseapp.LearningSession, bool, error) {
	var session exerciseapp.LearningSession
	var currentContent pgtype.Text
	var attemptedRaw []byte
	err := row.Scan(&session.ID, &session.StudentID, &currentContent, &attemptedRaw)
	if err != nil {
		if err == pgx.ErrNoRows {
			return exerciseapp.LearningSession{}, false, nil
		}
		return exerciseapp.LearningSession{}, false, err
	}
	session.CurrentContentID = textPtr(currentContent)
	attempted, err := decodeStringSlice(attemptedRaw)
	if err != nil {
		return exerciseapp.LearningSession{}, false, fmt.Errorf("decode contents attempted: %w", err)
	}
	session.ContentsAttempted = attempted
	return session, true, nil
}

func scanOptionalExercise(row pgx.Row) (exerciseapp.Exercise, bool, error) {
	exercise, err := scanExercise(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			return exerciseapp.Exercise{}, false, nil
		}
		return exerciseapp.Exercise{}, false, err
	}
	return exercise, true, nil
}

func scanExercise(scanner rowScanner) (exerciseapp.Exercise, error) {
	var exercise exerciseapp.Exercise
	var ownerTeacherID pgtype.Text
	var generatedByStudentID pgtype.Text
	var conceptIDsRaw []byte
	var metaRaw []byte
	if err := scanner.Scan(
		&exercise.ID,
		&ownerTeacherID,
		&generatedByStudentID,
		&exercise.Status,
		&exercise.Title,
		&exercise.Body,
		&exercise.Difficulty,
		&conceptIDsRaw,
		&metaRaw,
	); err != nil {
		return exerciseapp.Exercise{}, err
	}
	if ownerTeacherID.Valid {
		exercise.OwnerTeacherID = ownerTeacherID.String
	}
	if generatedByStudentID.Valid {
		exercise.GeneratedByStudentID = generatedByStudentID.String
	}
	conceptIDs, err := decodeStringSlice(conceptIDsRaw)
	if err != nil {
		return exerciseapp.Exercise{}, fmt.Errorf("decode concept ids: %w", err)
	}
	meta, err := decodeObjectMap(metaRaw)
	if err != nil {
		return exerciseapp.Exercise{}, fmt.Errorf("decode content meta: %w", err)
	}
	exercise.ConceptIDs = conceptIDs
	exercise.Meta = meta
	return exercise, nil
}

func generatedQuestionMeta(generated exerciseapp.GeneratedQuestion) map[string]any {
	return map[string]any{
		"answer":                 generated.Answer,
		"answer_type":            generated.AnswerType,
		"type":                   generated.Type,
		"options":                generated.Options,
		"hints":                  generated.Hints,
		"solution_steps":         generated.SolutionSteps,
		"estimated_time_seconds": generated.EstimatedTimeSeconds,
		"knowledge_point_names":  generated.KnowledgePointNames,
		"learning_feedback":      generated.LearningFeedback,
	}
}
