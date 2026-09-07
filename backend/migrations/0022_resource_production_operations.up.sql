ALTER TABLE public.vector_index_generations
    ADD COLUMN release_approved boolean NOT NULL DEFAULT true;

CREATE TABLE public.resource_operations_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id varchar(36) NOT NULL,
    action varchar(32) NOT NULL CHECK (action IN ('promote', 'rollback', 'retry_job')),
    target_id varchar(36) NOT NULL,
    evidence_sha256 varchar(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamp NOT NULL DEFAULT (statement_timestamp() AT TIME ZONE 'UTC')
);
CREATE INDEX resource_operations_audit_created_idx ON public.resource_operations_audit(created_at);
