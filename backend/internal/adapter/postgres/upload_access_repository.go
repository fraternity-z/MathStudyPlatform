package postgres

import (
	"context"
	"errors"
	"strings"

	"mathstudy/backend/internal/platform/uploadpath"
)

const canAccessLocalUploadSQL = `
WITH attachment_path AS (
    SELECT
        jsonb_build_array($1::text) AS legacy_value,
        jsonb_build_array(jsonb_build_object('url', $1::text)) AS structured_value
),
owned_object AS (
    SELECT owner_id
    FROM public.local_upload_objects
    WHERE url = $1
),
attachment_matches AS (
    SELECT (conversation.student_id = $2 OR conversation.teacher_id = $2) AS allowed
    FROM public.conversation_messages AS message
    JOIN public.conversations AS conversation ON conversation.id = message.conversation_id
    JOIN owned_object AS object ON object.owner_id = message.sender_id
    CROSS JOIN attachment_path AS path
    WHERE message.attachments @> path.legacy_value
       OR message.attachments @> path.structured_value

    UNION ALL

    SELECT (thread.student_id = $2 OR thread.teacher_id = $2) AS allowed
    FROM public.question_thread_messages AS message
    JOIN public.question_threads AS thread ON thread.id = message.thread_id
    JOIN owned_object AS object ON object.owner_id = message.sender_id
    CROSS JOIN attachment_path AS path
    WHERE message.attachments @> path.legacy_value
       OR message.attachments @> path.structured_value

    UNION ALL

    SELECT (
        notice.teacher_id = $2
        OR EXISTS (
            SELECT 1
            FROM public.notice_recipients AS recipient
            WHERE recipient.notice_id = notice.id
              AND recipient.student_id = $2
        )
    ) AS allowed
    FROM public.notices AS notice
    JOIN owned_object AS object ON object.owner_id = notice.teacher_id
    CROSS JOIN attachment_path AS path
    WHERE notice.attachments @> path.legacy_value
       OR notice.attachments @> path.structured_value

    UNION ALL

    SELECT (
        post.author_id = $2
        OR EXISTS (
            SELECT 1
            FROM public.users viewer
            WHERE viewer.id = $2
              AND viewer.role = 'ADMIN'::public.userrole
        )
        OR (post.deleted_at IS NULL AND post.status IN ('open', 'resolved'))
    ) AS allowed
    FROM public.forum_posts AS post
    JOIN owned_object AS object ON object.owner_id = post.author_id
    CROSS JOIN attachment_path AS path
    WHERE post.attachments @> path.legacy_value
       OR post.attachments @> path.structured_value

    UNION ALL

    SELECT (
        reply.author_id = $2
        OR EXISTS (
            SELECT 1
            FROM public.users viewer
            WHERE viewer.id = $2
              AND viewer.role = 'ADMIN'::public.userrole
        )
        OR (
            reply.deleted_at IS NULL
            AND reply.status = 'active'
            AND post.deleted_at IS NULL
            AND post.status IN ('open', 'resolved')
        )
    ) AS allowed
    FROM public.forum_replies AS reply
    JOIN public.forum_posts AS post ON post.id = reply.post_id
    JOIN owned_object AS object ON object.owner_id = reply.author_id
    CROSS JOIN attachment_path AS path
    WHERE reply.attachments @> path.legacy_value
       OR reply.attachments @> path.structured_value

    UNION ALL

    SELECT (session.student_id = $2) AS allowed
    FROM public.session_messages AS message
    JOIN public.learning_sessions AS session ON session.id = message.session_id
    JOIN owned_object AS object ON object.owner_id = session.student_id
    CROSS JOIN attachment_path AS path
    WHERE message.attachments::jsonb @> path.legacy_value
       OR message.attachments::jsonb @> path.structured_value
)
SELECT EXISTS (
    SELECT 1
    FROM attachment_matches
    WHERE allowed

    UNION ALL

    SELECT 1
    FROM public.local_upload_objects AS object
    WHERE object.url = $1
      AND object.owner_id = $2

    UNION ALL

    SELECT 1
    FROM public.content_assets AS asset
    JOIN public.contents AS content ON content.id = asset.content_id
    JOIN public.local_upload_objects AS object
      ON object.url = asset.url
     AND object.owner_id = content.owner_teacher_id
    WHERE asset.url = $1
      AND (
          content.owner_teacher_id = $2
          OR (
              content.status = 'PUBLISHED'::public.contentstatus
              AND content.deleted_at IS NULL
              AND content.type IN ('VIDEO'::public.contenttype, 'ARTICLE'::public.contenttype)
          )
      )
)`

// UploadAccessRepository records ownership and resolves object-level access to local uploads.
type UploadAccessRepository struct {
	Repository
}

// NewUploadAccessRepository creates a PostgreSQL-backed upload access repository.
func NewUploadAccessRepository(db Querier) (UploadAccessRepository, error) {
	base, err := NewRepository(db)
	if err != nil {
		return UploadAccessRepository{}, err
	}
	return UploadAccessRepository{Repository: base}, nil
}

// RecordLocalUpload registers the authenticated owner of a newly stored local object.
func (r UploadAccessRepository) RecordLocalUpload(ctx context.Context, userID string, localURL string) error {
	userID, localURL, err := normalizeLocalUploadAccessInput(userID, localURL)
	if err != nil {
		return err
	}
	tag, err := r.DB().Exec(ctx, `
		INSERT INTO public.local_upload_objects (url, owner_id)
		VALUES ($1, $2)
		ON CONFLICT (url) DO UPDATE
		SET owner_id = EXCLUDED.owner_id
		WHERE public.local_upload_objects.owner_id = EXCLUDED.owner_id`, localURL, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("local upload URL is registered to another owner")
	}
	return nil
}

// CanAccessLocalUpload reports whether a user owns or may view a persisted local object.
func (r UploadAccessRepository) CanAccessLocalUpload(ctx context.Context, userID string, localURL string) (bool, error) {
	userID, localURL, err := normalizeLocalUploadAccessInput(userID, localURL)
	if err != nil {
		return false, err
	}

	var allowed bool
	if err := r.DB().QueryRow(ctx, canAccessLocalUploadSQL, localURL, userID).Scan(&allowed); err != nil {
		return false, err
	}
	return allowed, nil
}

func normalizeLocalUploadAccessInput(userID string, localURL string) (string, string, error) {
	userID = strings.TrimSpace(userID)
	localURL = strings.TrimSpace(localURL)
	if userID == "" {
		return "", "", errors.New("upload access user ID is empty")
	}
	if !uploadpath.IsLocalPath(localURL) {
		return "", "", errors.New("upload access local URL is invalid")
	}
	return userID, localURL, nil
}
