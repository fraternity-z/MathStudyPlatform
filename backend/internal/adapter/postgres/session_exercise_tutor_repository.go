package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	sessionapp "mathstudy/backend/internal/application/session"
)

func (r SessionRepository) PrepareExerciseTutor(ctx context.Context, session sessionapp.LearningSession, messages []sessionapp.Message, request sessionapp.FirstChatRequest, exerciseID string) (string, error) {
	var resolvedID string
	err := withRepositoryTx(ctx, "exercise tutor create", r.Repository, func(base Repository) SessionRepository {
		return SessionRepository{Repository: base}
	}, func(current SessionRepository) error {
		// Separate from learning tracking locks: hint chats never write mastery.
		if _, err := current.DB().Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('exercise-tutor:' || $1 || ':' || $2, 0))`, session.StudentID, exerciseID); err != nil {
			return err
		}
		err := current.DB().QueryRow(ctx, `
            SELECT t.session_id FROM public.session_exercise_tutors t
            JOIN public.learning_sessions s ON s.id = t.session_id AND s.student_id = t.student_id
            WHERE t.student_id = $1 AND t.exercise_id = $2 AND t.is_current AND s.is_active`,
			session.StudentID, exerciseID).Scan(&resolvedID)
		if err == nil {
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if _, err := current.DB().Exec(ctx, `UPDATE public.session_exercise_tutors SET is_current = false WHERE student_id = $1 AND exercise_id = $2 AND is_current`, session.StudentID, exerciseID); err != nil {
			return err
		}
		inserted, err := current.insertSession(ctx, session)
		if err != nil {
			return err
		}
		if !inserted {
			return sessionapp.ErrSessionIDConflict
		}
		for _, message := range messages {
			if err := current.InsertMessage(ctx, message); err != nil {
				return err
			}
		}
		if err := current.insertFirstChatRequest(ctx, request); err != nil {
			return err
		}
		if _, err := current.DB().Exec(ctx, `INSERT INTO public.session_exercise_tutors (session_id, student_id, exercise_id) VALUES ($1, $2, $3)`, session.ID, session.StudentID, exerciseID); err != nil {
			return err
		}
		resolvedID = session.ID
		return nil
	})
	return resolvedID, err
}

func (r SessionRepository) GetTutorExerciseID(ctx context.Context, sessionID, studentID string) (string, error) {
	var exerciseID string
	err := r.DB().QueryRow(ctx, `SELECT t.exercise_id FROM public.session_exercise_tutors t
        JOIN public.learning_sessions s ON s.id = t.session_id AND s.student_id = t.student_id
        WHERE t.session_id = $1 AND t.student_id = $2`, sessionID, studentID).Scan(&exerciseID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return exerciseID, err
}
