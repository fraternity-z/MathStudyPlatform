-- Compute immutable lexical features at write time rather than for every
-- matching chunk on every search. Keep old expression indexes for app rollback.
ALTER TABLE public.document_chunks
    ADD COLUMN search_vector tsvector
        GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
    ADD COLUMN search_han_terms text[]
        GENERATED ALWAYS AS (public.resource_han_terms_v1(content)) STORED;

ALTER TABLE public.contents
    ADD COLUMN resource_search_vector tsvector
        GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(title, ''))) STORED,
    ADD COLUMN resource_search_han_terms text[]
        GENERATED ALWAYS AS (public.resource_han_terms_v1(coalesce(title, ''))) STORED;

CREATE INDEX ix_document_chunks_stored_fts
    ON public.document_chunks USING gin (search_vector)
    WHERE deleted_at IS NULL;
CREATE INDEX ix_document_chunks_stored_han
    ON public.document_chunks USING gin (search_han_terms)
    WHERE deleted_at IS NULL;
CREATE INDEX ix_contents_resource_stored_fts
    ON public.contents USING gin (resource_search_vector)
    WHERE deleted_at IS NULL AND status = 'PUBLISHED';
CREATE INDEX ix_contents_resource_stored_han
    ON public.contents USING gin (resource_search_han_terms)
    WHERE deleted_at IS NULL AND status = 'PUBLISHED';
