package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	sessionapp "mathstudy/backend/internal/application/session"
)

func (r SessionRepository) GetStudyProgress(ctx context.Context, sessionID, userID string) (*sessionapp.StudyProgress, error) {
	var progress sessionapp.StudyProgress
	err := r.DB().QueryRow(ctx, `SELECT p.topic, p.foundation, p.step, p.revision
		FROM public.session_study_progress p JOIN public.learning_sessions s ON s.id = p.session_id
		WHERE s.id = $1 AND s.student_id = $2`, sessionID, userID).
		Scan(&progress.Topic, &progress.Foundation, &progress.Step, &progress.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &progress, nil
}

// Serialize progress changes and the user turn that captures a stage snapshot.
// Locks are released before any model call.
func (r SessionRepository) InsertStudyMessage(ctx context.Context, userID string, message sessionapp.Message, revision int64) error {
	return withRepositoryTx(ctx, "study message", r.Repository, func(base Repository) SessionRepository {
		return SessionRepository{Repository: base}
	}, func(current SessionRepository) error {
		var id string
		err := current.DB().QueryRow(ctx, `SELECT id FROM public.learning_sessions
			WHERE id=$1 AND student_id=$2 AND mode='study' AND is_active=true FOR UPDATE`, message.SessionID, userID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return sessionapp.ErrNotFound
		}
		if err != nil {
			return err
		}
		progress, err := current.GetStudyProgress(ctx, message.SessionID, userID)
		if err != nil {
			return err
		}
		actual := int64(0)
		if progress != nil {
			actual = progress.Revision
		}
		if actual != revision {
			return sessionapp.ErrStudyConflict
		}
		return current.InsertMessage(ctx, message)
	})
}

func (r SessionRepository) UpdateStudyProgress(ctx context.Context, sessionID, userID string, request sessionapp.StudyUpdate) (*sessionapp.StudyProgress, error) {
	var result *sessionapp.StudyProgress
	err := withRepositoryTx(ctx, "study progress", r.Repository, func(base Repository) SessionRepository {
		return SessionRepository{Repository: base}
	}, func(current SessionRepository) error {
		var mode string
		err := current.DB().QueryRow(ctx, `SELECT mode FROM public.learning_sessions
			WHERE id = $1 AND student_id = $2 AND is_active = true FOR UPDATE`, sessionID, userID).Scan(&mode)
		if errors.Is(err, pgx.ErrNoRows) {
			return sessionapp.ErrNotFound
		}
		if err != nil {
			return err
		}
		if mode != "study" {
			return sessionapp.ErrInvalidStudy
		}
		if request.Action == "start" {
			tag, err := current.DB().Exec(ctx, `INSERT INTO public.session_study_progress (session_id, topic, foundation, message_count)
				VALUES ($1::varchar,$2,$3,(SELECT count(*) FROM public.session_messages WHERE session_id=$1::varchar))
				ON CONFLICT (session_id) DO NOTHING`, sessionID, request.Topic, request.Foundation)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return sessionapp.ErrStudyConflict
			}
		} else {
			// Require a completed tutor turn in this step; stopped/failed output cannot advance it.
			// The check step also needs a second user turn (the learner's response).
			tag, err := current.DB().Exec(ctx, `UPDATE public.session_study_progress p
				SET step = step + 1, revision = revision + 1, updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
				message_count = (SELECT count(*) FROM public.session_messages WHERE session_id = $1)
				WHERE session_id = $1 AND revision = $2 AND step < 5
				AND (SELECT count(*) FROM public.session_messages m WHERE m.session_id = p.session_id)
				    >= p.message_count + CASE WHEN p.step = 3 THEN 4 ELSE 2 END
				AND (SELECT m.role = 'ASSISTANT' AND m.agent_type = 'TUTOR'
				     AND btrim(m.content) <> '' AND m.content NOT LIKE '%> 已停止生成%' AND m.content NOT LIKE '%> 生成已中断%'
				     FROM public.session_messages m WHERE m.session_id = p.session_id
				     ORDER BY m.created_at DESC, m.id DESC LIMIT 1)`, sessionID, request.Revision)
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return sessionapp.ErrStudyConflict
			}
		}
		result, err = current.GetStudyProgress(ctx, sessionID, userID)
		return err
	})
	return result, err
}
