-- Reply outcomes belong to chat persistence, not to localized message text.
ALTER TABLE public.session_messages
    ADD COLUMN reply_to varchar(36) REFERENCES public.session_messages(id) ON DELETE CASCADE,
    ADD COLUMN completion_status varchar(20) CHECK (completion_status IN ('completed', 'stopped', 'interrupted', 'unavailable'));
CREATE UNIQUE INDEX session_messages_reply_to_key ON public.session_messages(reply_to) WHERE reply_to IS NOT NULL;

-- No inferred backfill: retain legacy progress, require fresh evidence in its current stage.
CREATE TABLE public.session_study_turns (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id varchar(36) NOT NULL REFERENCES public.session_study_progress(session_id) ON DELETE CASCADE,
    user_message_id varchar(36) NOT NULL UNIQUE REFERENCES public.session_messages(id) ON DELETE CASCADE,
    revision bigint NOT NULL CHECK (revision > 0),
    action varchar(20) NOT NULL CHECK (action IN ('start', 'rephrase', 'reply', 'discuss'))
);
CREATE INDEX session_study_turns_stage_idx ON public.session_study_turns(session_id, revision, sequence DESC);

-- Only sessions created through the atomic study endpoint can replay its creation request.
ALTER TABLE public.session_study_progress ADD COLUMN creation_key varchar(36) UNIQUE;
