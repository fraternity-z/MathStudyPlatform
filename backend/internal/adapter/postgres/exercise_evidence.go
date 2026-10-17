package postgres

import (
	"context"
	"time"

	exerciseapp "mathstudy/backend/internal/application/exercise"
	"mathstudy/backend/internal/platform/questiondedupe"
)

// HasPriorExerciseExposure runs under the student tracking lock, across all
// submission entry points and all history, using immutable question snapshots.
func (r ExerciseRepository) HasPriorExerciseExposure(ctx context.Context, studentID string, exercise exerciseapp.Exercise) (bool, error) {
	var found bool
	err := r.DB().QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM public.content_attempts
		WHERE student_id = $1 AND submitted_at IS NOT NULL AND (
			content_id = $2 OR (
				public.learning_question_body_v1($3) <> ''
				AND md5(public.learning_question_body_v1(review_question_body)) = md5(public.learning_question_body_v1($3))
				AND public.learning_question_body_v1(review_question_body) = public.learning_question_body_v1($3)
			)
		))`, studentID, exercise.ID, exercise.Body).Scan(&found)
	if err != nil || found {
		return found, err
	}
	key := questiondedupe.DerivativeKey(exercise.Body)
	if key == "" {
		return false, nil
	}
	// Inspect immutable first exposures across history, including legacy attempts.
	// This conservative fallback is used only for the recognized mathematical contract.
	rows, err := r.DB().Query(ctx, `SELECT DISTINCT review_question_body
		FROM public.content_attempts WHERE student_id = $1 AND submitted_at IS NOT NULL
			AND review_question_body IS NOT NULL`, studentID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			return false, err
		}
		if key == questiondedupe.DerivativeKey(body) {
			return true, nil
		}
	}
	return false, rows.Err()
}

func (r ExerciseRepository) StartExerciseStudyTime(ctx context.Context, studentID, exerciseID string, now time.Time) error {
	// Bound storage to currently useful clocks, including abandoned questions.
	if _, err := r.DB().Exec(ctx, `DELETE FROM public.exercise_study_sessions
		WHERE student_id = $1 AND started_at < $2`, studentID, now.Add(-exerciseapp.MaxStudyTimeSeconds*time.Second)); err != nil {
		return err
	}
	_, err := r.DB().Exec(ctx, `INSERT INTO public.exercise_study_sessions(student_id, exercise_id, started_at)
		VALUES ($1, $2, $3) ON CONFLICT (student_id, exercise_id) DO NOTHING`, studentID, exerciseID, now)
	return err
}

// ConsumeExerciseStudyTime is called once inside the submission transaction.
// Student-level serialization and the latest submission boundary prevent two
// questions/devices from claiming overlapping wall time. AI grading is excluded.
func (r ExerciseRepository) ConsumeExerciseStudyTime(ctx context.Context, studentID, exerciseID string, reported int, cutoff time.Time) (int, error) {
	var seconds int
	err := r.DB().QueryRow(ctx, `WITH clock AS (
		DELETE FROM public.exercise_study_sessions WHERE student_id = $1 AND exercise_id = $2 RETURNING started_at
	), latest AS (
		SELECT max(submitted_at) AS submitted_at FROM public.content_attempts WHERE student_id = $1
	)
	SELECT coalesce((SELECT CASE WHEN clock.started_at < $3::timestamp - interval '2 hours' THEN 0
		ELSE greatest(0, least($4, floor(extract(epoch FROM ($3::timestamp - greatest(clock.started_at, latest.submitted_at))))::int)) END
		FROM clock CROSS JOIN latest), 0)`, studentID, exerciseID, cutoff, reported).Scan(&seconds)
	return seconds, err
}
