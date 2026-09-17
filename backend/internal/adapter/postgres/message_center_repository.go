package postgres

import (
	"context"

	messagecenterapp "mathstudy/backend/internal/application/messagecenter"
	"mathstudy/backend/internal/domain/user"
)

// MessageCenterRepository loads compact, cross-feature message center summaries.
type MessageCenterRepository struct {
	Repository
}

// NewMessageCenterRepository creates a PostgreSQL-backed message center repository.
func NewMessageCenterRepository(db Querier) (MessageCenterRepository, error) {
	base, err := NewRepository(db)
	if err != nil {
		return MessageCenterRepository{}, err
	}
	return MessageCenterRepository{Repository: base}, nil
}

// Summary returns pending counts and at most five compact previews for a user.
func (r MessageCenterRepository) Summary(ctx context.Context, userID string, role user.Role) (messagecenterapp.Summary, error) {
	if role == user.RoleStudent {
		return r.studentSummary(ctx, userID)
	}
	if role == user.RoleTeacher {
		return r.teacherSummary(ctx, userID)
	}
	return messagecenterapp.Summary{}, messagecenterapp.ErrForbidden
}

func (r MessageCenterRepository) studentSummary(ctx context.Context, studentID string) (messagecenterapp.Summary, error) {
	var summary messagecenterapp.Summary
	if err := r.DB().QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM public.conversation_messages cm
			 JOIN public.conversations c ON c.id = cm.conversation_id
			 WHERE c.student_id = $1 AND c.student_archived = false
			   AND cm.sender_role = 'teacher' AND cm.read_at IS NULL),
			(SELECT COUNT(*) FROM public.notice_recipients nr
			 WHERE nr.student_id = $1
			   AND NOT EXISTS (SELECT 1 FROM public.notice_confirmations nc
			                   WHERE nc.notice_id = nr.notice_id AND nc.student_id = nr.student_id)),
			(SELECT COUNT(*) FROM public.question_threads qt
			 WHERE qt.student_id = $1
			   AND EXISTS (SELECT 1 FROM public.question_thread_messages qtm
			               WHERE qtm.thread_id = qt.id AND qtm.sender_role = 'teacher' AND qtm.read_at IS NULL)),
			(SELECT COUNT(*) FROM public.forum_notifications n
			 WHERE n.recipient_id = $1 AND n.read_at IS NULL
			   AND `+forumNotificationTargetActiveSQL+`)`, studentID,
	).Scan(&summary.ConversationCount, &summary.NoticeCount, &summary.ThreadCount, &summary.ForumCount); err != nil {
		return messagecenterapp.Summary{}, err
	}

	rows, err := r.DB().Query(ctx, `
		SELECT id, type, title, summary, occurred_at, pending
		FROM (
			SELECT c.id, 'conversation'::text AS type,
				LEFT(COALESCE(u.display_name, u.username), 120) AS title,
					LEFT(COALESCE((SELECT CASE WHEN cm.text <> '' THEN cm.text WHEN jsonb_array_length(cm.attachments) > 0 THEN '[附件]' ELSE '' END FROM public.conversation_messages cm WHERE cm.conversation_id = c.id ORDER BY cm.created_at DESC, cm.id DESC LIMIT 1), '新的私信'), 240) AS summary,
				c.last_message_at AS occurred_at,
				EXISTS (SELECT 1 FROM public.conversation_messages cm WHERE cm.conversation_id = c.id AND cm.sender_role = 'teacher' AND cm.read_at IS NULL) AS pending
			FROM public.conversations c
			JOIN public.users u ON u.id = c.teacher_id
			WHERE c.student_id = $1 AND c.student_archived = false
			UNION ALL
			SELECT n.id, 'notice'::text, LEFT(n.title, 120), LEFT('通知 · ' || n.class_name, 240), n.created_at,
				NOT EXISTS (SELECT 1 FROM public.notice_confirmations nc WHERE nc.notice_id = nr.notice_id AND nc.student_id = nr.student_id)
			FROM public.notice_recipients nr
			JOIN public.notices n ON n.id = nr.notice_id
			WHERE nr.student_id = $1
			UNION ALL
			SELECT qt.id, 'thread'::text, LEFT(qt.title, 120), LEFT('答疑 · ' || qt.status, 240), qt.updated_at,
				EXISTS (SELECT 1 FROM public.question_thread_messages qtm
					WHERE qtm.thread_id = qt.id AND qtm.sender_role = 'teacher' AND qtm.read_at IS NULL)
			FROM public.question_threads qt
			WHERE qt.student_id = $1
			UNION ALL
			SELECT latest.post_id, 'forum'::text, LEFT(latest.title, 120), LEFT(latest.summary, 240), latest.created_at,
				EXISTS (
					SELECT 1
					FROM public.forum_notifications n
					WHERE n.recipient_id = $1
					  AND n.post_id = latest.post_id
					  AND n.read_at IS NULL
					  AND `+forumNotificationTargetActiveSQL+`
				)
			FROM (
				SELECT DISTINCT ON (n.post_id) n.post_id, n.title, n.summary, n.created_at, n.id
				FROM public.forum_notifications n
				WHERE n.recipient_id = $1 AND n.post_id IS NOT NULL
				  AND `+forumNotificationTargetActiveSQL+`
				ORDER BY n.post_id, n.created_at DESC, n.id DESC
			) AS latest
		) AS previews
			ORDER BY pending DESC, occurred_at DESC, id DESC, type
		LIMIT 5`, studentID)
	if err != nil {
		return messagecenterapp.Summary{}, err
	}
	defer rows.Close()
	items, err := scanPreviewItems(rows)
	if err != nil {
		return messagecenterapp.Summary{}, err
	}
	summary.Items = items
	return summary, nil
}

func (r MessageCenterRepository) teacherSummary(ctx context.Context, teacherID string) (messagecenterapp.Summary, error) {
	var summary messagecenterapp.Summary
	if err := r.DB().QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM public.conversation_messages cm
			 JOIN public.conversations c ON c.id = cm.conversation_id
			 WHERE c.teacher_id = $1 AND c.teacher_archived = false
			   AND cm.sender_role = 'student' AND cm.read_at IS NULL),
			(SELECT COUNT(*) FROM public.notices n
			 WHERE n.teacher_id = $1
			   AND EXISTS (SELECT 1 FROM public.notice_recipients nr
			               WHERE nr.notice_id = n.id
			                 AND NOT EXISTS (SELECT 1 FROM public.notice_confirmations nc WHERE nc.notice_id = nr.notice_id AND nc.student_id = nr.student_id))),
			(SELECT COUNT(*) FROM public.question_threads qt
			 WHERE qt.teacher_id = $1 AND qt.status IN ('待回复', '需跟进')),
			(SELECT COUNT(*) FROM public.forum_notifications n
			 WHERE n.recipient_id = $1 AND n.read_at IS NULL
			   AND `+forumNotificationTargetActiveSQL+`)`, teacherID,
	).Scan(&summary.ConversationCount, &summary.NoticeCount, &summary.ThreadCount, &summary.ForumCount); err != nil {
		return messagecenterapp.Summary{}, err
	}

	rows, err := r.DB().Query(ctx, `
		SELECT id, type, title, summary, occurred_at, pending
		FROM (
			SELECT c.id, 'conversation'::text AS type,
				LEFT(COALESCE(u.display_name, u.username), 120) AS title,
					LEFT(COALESCE((SELECT CASE WHEN cm.text <> '' THEN cm.text WHEN jsonb_array_length(cm.attachments) > 0 THEN '[附件]' ELSE '' END FROM public.conversation_messages cm WHERE cm.conversation_id = c.id ORDER BY cm.created_at DESC, cm.id DESC LIMIT 1), '新的私信'), 240) AS summary,
				c.last_message_at AS occurred_at,
				EXISTS (SELECT 1 FROM public.conversation_messages cm WHERE cm.conversation_id = c.id AND cm.sender_role = 'student' AND cm.read_at IS NULL) AS pending
			FROM public.conversations c
			JOIN public.users u ON u.id = c.student_id
			WHERE c.teacher_id = $1 AND c.teacher_archived = false
			UNION ALL
			SELECT n.id, 'notice'::text, LEFT(n.title, 120), LEFT('通知 · ' || n.class_name, 240), n.created_at,
				EXISTS (SELECT 1 FROM public.notice_recipients nr
					WHERE nr.notice_id = n.id
					  AND NOT EXISTS (SELECT 1 FROM public.notice_confirmations nc WHERE nc.notice_id = nr.notice_id AND nc.student_id = nr.student_id))
			FROM public.notices n
			WHERE n.teacher_id = $1
			UNION ALL
			SELECT qt.id, 'thread'::text, LEFT(qt.title, 120), LEFT('答疑 · ' || qt.status, 240), qt.updated_at,
				qt.status IN ('待回复', '需跟进')
			FROM public.question_threads qt
			WHERE qt.teacher_id = $1
			UNION ALL
			SELECT latest.post_id, 'forum'::text, LEFT(latest.title, 120), LEFT(latest.summary, 240), latest.created_at,
				EXISTS (
					SELECT 1
					FROM public.forum_notifications n
					WHERE n.recipient_id = $1
					  AND n.post_id = latest.post_id
					  AND n.read_at IS NULL
					  AND `+forumNotificationTargetActiveSQL+`
				)
			FROM (
				SELECT DISTINCT ON (n.post_id) n.post_id, n.title, n.summary, n.created_at, n.id
				FROM public.forum_notifications n
				WHERE n.recipient_id = $1 AND n.post_id IS NOT NULL
				  AND `+forumNotificationTargetActiveSQL+`
				ORDER BY n.post_id, n.created_at DESC, n.id DESC
			) AS latest
		) AS previews
			ORDER BY pending DESC, occurred_at DESC, id DESC, type
		LIMIT 5`, teacherID)
	if err != nil {
		return messagecenterapp.Summary{}, err
	}
	defer rows.Close()
	items, err := scanPreviewItems(rows)
	if err != nil {
		return messagecenterapp.Summary{}, err
	}
	summary.Items = items
	return summary, nil
}

func scanPreviewItems(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
}) ([]messagecenterapp.PreviewItem, error) {
	items := make([]messagecenterapp.PreviewItem, 0)
	for rows.Next() {
		var item messagecenterapp.PreviewItem
		if err := rows.Scan(&item.ID, &item.Type, &item.Title, &item.Summary, &item.OccurredAt, &item.Pending); err != nil {
			return nil, err
		}
		item.OccurredAt = messageCenterWallTime(item.OccurredAt)
		items = append(items, item)
	}
	return items, rows.Err()
}
