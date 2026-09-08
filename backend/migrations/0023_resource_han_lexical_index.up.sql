-- Version this immutable function: changing tokenization in place would leave
-- expression indexes inconsistent with new queries. Keep punctuation/Latin
-- boundaries and use distinct overlapping Han pairs, never query-specific data.
CREATE FUNCTION public.resource_han_terms_v1(source text) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT coalesce(array_agg(DISTINCT pair COLLATE "C" ORDER BY pair COLLATE "C"), ARRAY[]::text[])
    FROM (
        SELECT (character || lead(character) OVER (ORDER BY position)) COLLATE "C" AS pair
        FROM regexp_split_to_table(source, '') WITH ORDINALITY AS chars(character, position)
    ) pairs
    WHERE pair ~ U&'^[\3400-\4DBF\4E00-\9FFF\F900-\FAFF\+020000-\+02EBEF\+030000-\+0323AF]{2}$'
$$;

CREATE INDEX ix_document_chunks_search_han
    ON public.document_chunks USING gin (public.resource_han_terms_v1(content))
    WHERE deleted_at IS NULL;

CREATE INDEX ix_contents_resource_search_han
    ON public.contents USING gin (public.resource_han_terms_v1(coalesce(title, '')))
    WHERE deleted_at IS NULL AND status = 'PUBLISHED';
