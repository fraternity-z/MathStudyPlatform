package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	sessionapp "mathstudy/backend/internal/application/session"
)

func (r SessionRepository) GetStudyProgress(ctx context.Context, sessionID, userID string) (*sessionapp.StudyProgress, error) {
	var progress sessionapp.StudyProgress
	var evidence sessionapp.StudyEvidence
	err := r.DB().QueryRow(ctx, `SELECT p.topic, p.foundation, p.step, p.revision,
		COALESCE(latest.action, ''), COALESCE(reply.completion_status = 'completed' AND reply.agent_type = 'TUTOR' AND btrim(reply.content) <> '', false),
		COALESCE(question.sequence < latest.sequence AND question_reply.completion_status = 'completed'
		    AND question_reply.agent_type = 'TUTOR' AND btrim(question_reply.content) <> '', false)
		FROM public.session_study_progress p JOIN public.learning_sessions s ON s.id = p.session_id
		LEFT JOIN LATERAL (SELECT t.* FROM public.session_study_turns t
		    WHERE t.session_id=p.session_id AND t.revision=p.revision ORDER BY t.sequence DESC LIMIT 1) latest ON true
		LEFT JOIN public.session_messages reply ON reply.reply_to=latest.user_message_id
		LEFT JOIN LATERAL (SELECT t.* FROM public.session_study_turns t
		    WHERE t.session_id=p.session_id AND t.revision=p.revision AND t.action='start'
		    ORDER BY t.sequence DESC LIMIT 1) question ON true
		LEFT JOIN public.session_messages question_reply ON question_reply.reply_to=question.user_message_id
		WHERE s.id = $1 AND s.student_id = $2`, sessionID, userID).
		Scan(&progress.Topic, &progress.Foundation, &progress.Step, &progress.Revision, &evidence.Action, &evidence.Completed, &evidence.HasQuestion)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	progress.SetAvailability(evidence)
	return &progress, nil
}

// Serialize progress changes and the user turn that captures a stage snapshot.
// Locks are released before any model call.
func (r SessionRepository) InsertStudyMessage(ctx context.Context, userID string, message sessionapp.Message, revision int64, action string) error {
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
		if err := current.InsertMessage(ctx, message); err != nil {
			return err
		}
		if revision == 0 {
			return nil
		}
		_, err = current.DB().Exec(ctx, `INSERT INTO public.session_study_turns (session_id, user_message_id, revision, action)
		    VALUES ($1,$2,$3,$4)`, message.SessionID, message.ID, revision, action)
		return err
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
			progress, err := current.GetStudyProgress(ctx, sessionID, userID)
			if err != nil {
				return err
			}
			if progress == nil || progress.Revision != request.Revision || !progress.CanAdvance {
				return sessionapp.ErrStudyConflict
			}
			tag, err := current.DB().Exec(ctx, `UPDATE public.session_study_progress p
				SET step = step + 1, revision = revision + 1, updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
				WHERE session_id = $1 AND revision = $2 AND step < 5`, sessionID, request.Revision)
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

func (r SessionRepository) CreateStudySession(ctx context.Context, session sessionapp.LearningSession, welcome sessionapp.Message, request sessionapp.StudyUpdate) (*sessionapp.StudyProgress, error) {
	var result *sessionapp.StudyProgress
	err := withRepositoryTx(ctx, "study create", r.Repository, func(base Repository) SessionRepository {
		return SessionRepository{Repository: base}
	}, func(current SessionRepository) error {
		created, err := current.insertSession(ctx, session)
		if err != nil {
			return err
		}
		if created {
			if err := current.InsertMessage(ctx, welcome); err != nil {
				return err
			}
			_, err = current.DB().Exec(ctx, `INSERT INTO public.session_study_progress
			    (session_id, topic, foundation, message_count, creation_key) VALUES ($1,$2,$3,1,$1)`, session.ID, request.Topic, request.Foundation)
			if err != nil {
				return err
			}
		} else {
			matches, err := current.Exists(ctx, `SELECT EXISTS (SELECT 1 FROM public.learning_sessions s
			    JOIN public.session_study_progress p ON p.session_id=s.id
			    WHERE s.id=$1 AND s.student_id=$2 AND s.mode='study' AND p.creation_key=$1 AND p.topic=$3 AND p.foundation=$4)`,
				session.ID, session.StudentID, request.Topic, request.Foundation)
			if err != nil {
				return err
			}
			if !matches {
				return sessionapp.ErrSessionIDConflict
			}
		}
		result, err = current.GetStudyProgress(ctx, session.ID, session.StudentID)
		return err
	})
	return result, err
}
