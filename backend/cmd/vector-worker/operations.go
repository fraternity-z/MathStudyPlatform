package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	resourceapp "mathstudy/backend/internal/application/resource"
)

type operationsRepository interface {
	IngestionOperationsSnapshot(context.Context) (map[string]any, error)
	ApplyIngestionOperation(context.Context, string, string, string, string, time.Time) error
}

func writeOperationsStatus(ctx context.Context, rt runtime, output io.Writer) error {
	repo, ok := rt.repo.(operationsRepository)
	if !ok {
		return resourceapp.ErrIngestionUnavailable
	}
	result, err := repo.IngestionOperationsSnapshot(ctx)
	if err != nil {
		return err
	}
	generations, err := rt.repo.ListIngestionGenerations(ctx, "", 100)
	if err != nil {
		return err
	}
	items := make([]map[string]any, 0, len(generations))
	for _, g := range generations {
		items = append(items, map[string]any{"id": g.ID, "knowledge_base_id": g.KnowledgeBaseID, "generation": g.Number, "state": g.State, "retain_until": g.RetainUntil})
	}
	result["generations"], result["generations_limit"] = items, 100
	return json.NewEncoder(output).Encode(result)
}

func runAuditedOperation(ctx context.Context, rt runtime, o options, output io.Writer) error {
	repo, ok := rt.repo.(operationsRepository)
	if !ok {
		return resourceapp.ErrIngestionUnavailable
	}
	target := o.generationID
	if o.command == "retry-job" {
		target = o.jobID
	} else {
		found := false
		after := ""
		for page := 0; page < 10000; page++ {
			items, err := rt.repo.ListIngestionGenerations(ctx, after, 100)
			if err != nil {
				return err
			}
			for _, g := range items {
				if g.ID != target {
					continue
				}
				found = true
				if rt.verifyGeneration == nil {
					return resourceapp.ErrIngestionUnavailable
				}
				if err := rt.verifyGeneration(ctx, g); err != nil {
					return err
				}
				report, err := reconcileObserved(ctx, rt, g, false, o.maxPages)
				if err != nil {
					return err
				}
				if !report.Complete || report.Missing != 0 || report.Mismatched != 0 || report.Extra != 0 {
					return errors.New("generation must pass a complete, zero-difference reconciliation")
				}
			}
			if found || len(items) < 100 {
				break
			}
			after = items[len(items)-1].ID
		}
		if !found {
			return errors.New("generation scope was not found")
		}
	}
	if o.apply {
		if err := repo.ApplyIngestionOperation(ctx, o.actorID, strings.ReplaceAll(o.command, "-", "_"), target, o.evidence, time.Now().UTC()); err != nil {
			return err
		}
	}
	return json.NewEncoder(output).Encode(map[string]any{"command": o.command, "target_id": target, "dry_run": !o.apply, "evidence_sha256": o.evidence})
}
