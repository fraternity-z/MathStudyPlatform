-- A learner-controlled study sequence, not an inferred mastery score.
CREATE TABLE public.session_study_progress (
    session_id varchar(36) PRIMARY KEY REFERENCES public.learning_sessions(id) ON DELETE CASCADE,
    topic varchar(200) NOT NULL CHECK (length(btrim(topic)) > 0),
    foundation varchar(20) NOT NULL CHECK (foundation IN ('beginner', 'familiar', 'review')),
    step integer NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 5),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    message_count integer NOT NULL CHECK (message_count >= 0),
    updated_at timestamp without time zone NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);
