package postgres

import (
	"context"

	resourceapp "mathstudy/backend/internal/application/resource"
)

func (r ResourceRepository) requireIngestionKnowledgeBase(ctx context.Context, userID, kbID string) error {
	var allowed bool
	if err := r.DB().QueryRow(ctx, `SELECT public.resource_kb_access($1,$2,'publish')`, userID, kbID).Scan(&allowed); err != nil {
		return err
	}
	if !allowed {
		return resourceapp.ErrAuthorizationDenied
	}
	return nil
}

// Caller holds the ingestion transaction lock, so concurrent registrations cannot
// both consume the last document, byte or queue slot.
func (r ResourceRepository) checkIngestionQuota(ctx context.Context, kbID string, bytes int64) error {
	var allowed bool
	err := r.DB().QueryRow(ctx, `SELECT
		(SELECT count(*) FROM public.resource_documents d WHERE d.tenant_id=t.id AND d.deleted_at IS NULL)<t.resource_document_limit
		AND (SELECT coalesce(sum(d.byte_size),0) FROM public.resource_documents d WHERE d.tenant_id=t.id)+$2<=t.resource_byte_limit
		AND (SELECT count(*) FROM public.resource_processing_jobs j WHERE j.tenant_id=t.id AND j.status IN ('pending','running'))<t.resource_job_limit
		FROM public.tenants t JOIN public.knowledge_bases kb ON kb.tenant_id=t.id WHERE kb.id=$1`, kbID, bytes).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return resourceapp.ErrIngestionQuotaExceeded
	}
	return nil
}

// Caller holds the ingestion transaction lock. Retries consume a queue slot,
// including outstanding upload reservations, but reuse existing documents/bytes.
func (r ResourceRepository) checkIngestionRetryQuota(ctx context.Context, kbID string) error {
	var tenantAllowed, globalAllowed bool
	err := r.DB().QueryRow(ctx, `SELECT
		(SELECT count(*) FROM public.resource_processing_jobs j WHERE j.tenant_id=t.id AND j.status IN ('pending','running'))+
		(SELECT count(*) FROM public.resource_ingestion_uploads u WHERE u.tenant_id=t.id AND NOT (`+ingestionUploadReferencedSQL+`))<t.resource_job_limit,
		(SELECT count(*) FROM public.resource_processing_jobs WHERE status IN ('pending','running'))+
		(SELECT count(*) FROM public.resource_ingestion_uploads u WHERE NOT (`+ingestionUploadReferencedSQL+`))<1000
		FROM public.tenants t JOIN public.knowledge_bases kb ON kb.tenant_id=t.id WHERE kb.id=$1`, kbID).Scan(&tenantAllowed, &globalAllowed)
	if err != nil {
		return err
	}
	if !tenantAllowed {
		return resourceapp.ErrIngestionQuotaExceeded
	}
	if !globalAllowed {
		return resourceapp.ErrIngestionQueueFull
	}
	return nil
}
