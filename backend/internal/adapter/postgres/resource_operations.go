package postgres

import (
	"context"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	resourceapp "mathstudy/backend/internal/application/resource"
)

// ApplyIngestionOperation keeps administrative changes and their audit record atomic.
func (r ResourceRepository) ApplyIngestionOperation(ctx context.Context, actor, action, target, evidence string, now time.Time) error {
	digest, err := hex.DecodeString(evidence)
	if !validResourceSearchID(actor) || !validResourceSearchID(target) || err != nil || len(digest) != 32 || hex.EncodeToString(digest) != evidence {
		return resourceapp.ErrIngestionInvalid
	}
	if action != "promote" && action != "rollback" && action != "retry_job" {
		return resourceapp.ErrIngestionInvalid
	}
	return r.withIngestionTx(ctx, func(tx ResourceRepository) error {
		var id string
		err := tx.DB().QueryRow(ctx, `SELECT id FROM public.users WHERE id=$1 AND role='ADMIN' AND is_active=true AND status='ACTIVE' FOR SHARE`, actor).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return resourceapp.ErrAuthorizationDenied
		}
		if err != nil {
			return err
		}
		if action == "retry_job" {
			if err := tx.retryOperationsJob(ctx, target, now); err != nil {
				return err
			}
		} else {
			if err := tx.switchOperationsGeneration(ctx, target, action == "rollback", now); err != nil {
				return err
			}
		}
		_, err = tx.DB().Exec(ctx, `INSERT INTO public.resource_operations_audit(actor_id,action,target_id,evidence_sha256,created_at) VALUES($1,$2,$3,$4,$5)`, actor, action, target, evidence, now)
		return err
	})
}

func (r ResourceRepository) switchOperationsGeneration(ctx context.Context, target string, rollback bool, now time.Time) error {
	var ignored any
	if err := r.DB().QueryRow(ctx, `SELECT pg_advisory_xact_lock(hashtext('resource_embedding'))`).Scan(&ignored); err != nil {
		return err
	}
	g, err := scanIngestionGeneration(r.DB().QueryRow(ctx, ingestionGenerationSelect+` WHERE g.id=$1 AND g.tenant_id=$2 AND m.status='active' FOR UPDATE OF g`, target, resourceSearchDefaultTenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return resourceapp.ErrIngestionConflict
	}
	if err != nil {
		return err
	}
	if rollback {
		if g.State != "retired" || !g.RetainUntil.After(now) {
			return resourceapp.ErrIngestionConflict
		}
	} else if g.State != "ready" {
		return resourceapp.ErrIngestionConflict
	}
	var kb string
	if err := r.DB().QueryRow(ctx, `SELECT id FROM public.knowledge_bases WHERE id=$1 AND status='active' FOR UPDATE`, g.KnowledgeBaseID).Scan(&kb); err != nil {
		return err
	}
	var competing bool
	if err := r.DB().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.vector_index_generations WHERE knowledge_base_id=$1 AND id<>$2 AND state IN ('building','ready'))`, kb, g.ID).Scan(&competing); err != nil {
		return err
	}
	if competing {
		return resourceapp.ErrIngestionConflict
	}
	if _, err := r.DB().Exec(ctx, `UPDATE public.vector_index_generations SET state='ready',release_approved=true,retired_at=NULL WHERE id=$1`, g.ID); err != nil {
		return err
	}
	g.State = "ready"
	if err := r.activateIngestionGeneration(ctx, g, now); err != nil {
		return err
	}
	var active bool
	if err := r.DB().QueryRow(ctx, `SELECT state='active' FROM public.vector_index_generations WHERE id=$1`, g.ID).Scan(&active); err != nil {
		return err
	}
	if !active {
		return resourceapp.ErrIngestionConflict
	}
	return nil
}

func (r ResourceRepository) retryOperationsJob(ctx context.Context, target string, now time.Time) error {
	var id string
	err := r.DB().QueryRow(ctx, `SELECT j.id FROM public.resource_processing_jobs j JOIN public.vector_index_generations g ON g.id=j.generation_id
		WHERE j.id=$1 AND j.tenant_id=$2 AND j.status IN ('dead','failed')
		AND (j.job_type='purge' OR g.state IN ('active','building','ready')) FOR UPDATE OF j`, target, resourceSearchDefaultTenantID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return resourceapp.ErrIngestionConflict
	}
	if err != nil {
		return err
	}
	_, err = r.DB().Exec(ctx, `WITH retried AS (UPDATE public.resource_processing_jobs SET status='pending',stage='queued',attempt_count=0,available_at=$2,claimed_by=NULL,lease_expires_at=NULL,last_error_code=NULL,last_error_message=NULL,finished_at=NULL,updated_at=$2 WHERE id=$1 RETURNING outbox_event_id)
		UPDATE public.outbox_events SET processed_at=NULL,dead_at=NULL,available_at=$2,lease_owner=NULL,lease_expires_at=NULL,retry_count=0,error_code=NULL,last_error=NULL WHERE id IN (SELECT outbox_event_id FROM retried)`, id, now)
	return err
}

// IngestionOperationsSnapshot exposes only bounded operational metadata.
func (r ResourceRepository) IngestionOperationsSnapshot(ctx context.Context) (map[string]any, error) {
	stats, err := r.IngestionQueueStats(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := r.DB().Query(ctx, `SELECT id,resource_id,generation_id,status,coalesce(last_error_code,''),attempt_count FROM public.resource_processing_jobs
		WHERE tenant_id=$1 AND generation_id IS NOT NULL AND status IN ('dead','failed') ORDER BY updated_at,id LIMIT 100`, resourceSearchDefaultTenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var id, resource, generation, status, code string
		var attempts int
		if err := rows.Scan(&id, &resource, &generation, &status, &code, &attempts); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{"job_id": id, "resource_id": resource, "generation_id": generation, "status": status, "error_code": code, "attempts": attempts})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"queue": stats, "failed_jobs": items, "failed_jobs_limit": 100}, nil
}
