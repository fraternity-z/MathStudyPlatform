-- A durable tutor association, separate from the mutable exercise cursor.
CREATE TABLE public.session_exercise_tutors (
    session_id varchar(36) PRIMARY KEY REFERENCES public.learning_sessions(id) ON DELETE CASCADE,
    student_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    -- Retain the binding after question deletion so tutoring fails closed.
    exercise_id varchar(36) NOT NULL,
    is_current boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX session_exercise_tutors_current_idx
    ON public.session_exercise_tutors (student_id, exercise_id) WHERE is_current;
