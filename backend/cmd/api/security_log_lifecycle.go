package main

import (
	"context"
	"log/slog"
	"time"

	securitylogapp "mathstudy/backend/internal/application/securitylog"
)

func startSecurityLogCleanupWorker(
	worker *securitylogapp.CleanupWorker,
	enabled bool,
	shutdownTimeout time.Duration,
	logger *slog.Logger,
) func() {
	if !enabled || worker == nil {
		return func() {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := worker.Run(ctx); err != nil {
			logger.Error("security log cleanup worker stopped", "error_code", "worker_error")
		}
	}()

	return func() {
		cancel()
		timer := time.NewTimer(shutdownTimeout)
		defer timer.Stop()
		select {
		case <-done:
			logger.Info("security log cleanup worker stopped")
		case <-timer.C:
			logger.Warn("security log cleanup worker shutdown timed out")
		}
	}
}
