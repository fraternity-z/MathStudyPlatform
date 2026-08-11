-- Existing attachment fields cannot prove who originally uploaded a URL, so
-- historical objects remain unregistered until an audited import or re-upload.
CREATE TABLE public.local_upload_objects (
    url character varying(300) PRIMARY KEY,
    owner_id character varying(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at timestamp without time zone DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai') NOT NULL,
    CONSTRAINT ck_local_upload_objects_url CHECK (
        url LIKE '/uploads/images/%'
        OR url LIKE '/uploads/documents/%'
        OR url LIKE '/uploads/videos/%'
    )
);

CREATE INDEX ix_local_upload_objects_owner_id
    ON public.local_upload_objects (owner_id);

CREATE INDEX ix_content_assets_url
    ON public.content_assets (url);

CREATE INDEX ix_conversation_messages_attachments_gin
    ON public.conversation_messages USING gin (attachments jsonb_path_ops);

CREATE INDEX ix_question_thread_messages_attachments_gin
    ON public.question_thread_messages USING gin (attachments jsonb_path_ops);

CREATE INDEX ix_notices_attachments_gin
    ON public.notices USING gin (attachments jsonb_path_ops);

CREATE INDEX ix_forum_posts_attachments_gin
    ON public.forum_posts USING gin (attachments jsonb_path_ops);

CREATE INDEX ix_forum_replies_attachments_gin
    ON public.forum_replies USING gin (attachments jsonb_path_ops);

CREATE INDEX ix_session_messages_attachments_gin
    ON public.session_messages USING gin ((attachments::jsonb) jsonb_path_ops);
