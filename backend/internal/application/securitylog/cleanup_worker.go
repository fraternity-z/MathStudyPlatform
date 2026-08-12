package securitylog

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	defaultCleanupInterval = time.Hour
	defaultCleanupTimeout  = 30 * time.Second
)

// CleanupRunner runs one bounded security-log retention cycle.
type CleanupRunner interface {
	Cleanup(context.Context) (CleanupResponse, error)
}

// CleanupWorkerConfig controls how often cleanup runs and bounds each cycle.
type CleanupWorkerConfig struct {
	Interval time.Duration
	Timeout  time.Duration
}

// CleanupWorker periodically enforces security-log retention.
type CleanupWorker struct {
	runner CleanupRunner
	logger *slog.Logger
	config CleanupWorkerConfig
}

// NewCleanupWorker creates a cleanup worker. Run must be started by the application lifecycle.
func NewCleanupWorker(runner CleanupRunner, logger *slog.Logger, config CleanupWorkerConfig) (*CleanupWorker, error) {
	if runner == nil {
		return nil, errors.New("security log cleanup runner is nil")
	}
	if config.Interval < 0 {
		return nil, errors.New("security log cleanup interval must not be negative")
	}
	if config.Interval == 0 {
		config.Interval = defaultCleanupInterval
	}
	if config.Timeout < 0 {
		return nil, errors.New("security log cleanup timeout must not be negative")
	}
	if config.Timeout == 0 {
		config.Timeout = defaultCleanupTimeout
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &CleanupWorker{runner: runner, logger: logger, config: config}, nil
}

// Run cleans up immediately after startup, then repeats after each interval.
func (w *CleanupWorker) Run(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return nil
		}
		w.cleanup(ctx)

		timer := time.NewTimer(w.config.Interval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil
		case <-timer.C:
		}
	}
}

func (w *CleanupWorker) cleanup(ctx context.Context) {
	cleanupCtx, cancel := context.WithTimeout(ctx, w.config.Timeout)
	response, err := w.runner.Cleanup(cleanupCtx)
	cancel()
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		errorCode := "repository_error"
		if errors.Is(err, context.DeadlineExceeded) {
			errorCode = "timeout"
		}
		w.logger.Error("security log cleanup failed", "error_code", errorCode)
		return
	}
	w.logger.Info(
		"security log cleanup completed",
		"archived_count", response.ArchivedCount,
		"deleted_count", response.DeletedCount,
		"remaining_count", response.Volume.Total,
	)
}
