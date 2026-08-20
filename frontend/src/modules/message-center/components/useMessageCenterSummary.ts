import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import {
  messageCenterService,
  type MessageCenterSummary,
} from '@/modules/message-center/services/messageCenterService';
import { toAppError, type AppError } from '@/libs/http/appError';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 5_000;

interface SummarySnapshot {
  cacheKey: string | null;
  summary: MessageCenterSummary | null;
  isRefreshing: boolean;
  error: AppError | null;
  updatedAt: number;
}

export interface UseMessageCenterSummaryOptions {
  cacheKey?: string;
  enabled?: boolean;
  pollIntervalMs?: number;
}

export interface UseMessageCenterSummaryResult {
  summary: MessageCenterSummary | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: AppError | null;
  refresh: () => Promise<MessageCenterSummary>;
}

let snapshot: SummarySnapshot = {
  cacheKey: null,
  summary: null,
  isRefreshing: false,
  error: null,
  updatedAt: 0,
};
let refreshRequest: Promise<MessageCenterSummary> | null = null;
let refreshAfterMutation = false;
let cacheGeneration = 0;
const listeners = new Set<() => void>();
const pollingConsumers = new Map<number, number>();
let nextPollingConsumerID = 0;
let pollTimer: ReturnType<typeof window.setInterval> | null = null;
let globalListenersAttached = false;

function getSnapshot(): SummarySnapshot {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function updateSnapshot(update: Partial<SummarySnapshot>): void {
  snapshot = { ...snapshot, ...update };
  listeners.forEach((listener) => listener());
}

function normalizeError(error: unknown): AppError {
  return toAppError(error, '消息汇总加载失败');
}

export function refreshMessageCenterSummary(): Promise<MessageCenterSummary> {
  if (refreshRequest) return refreshRequest;

  const requestGeneration = cacheGeneration;
  updateSnapshot({ isRefreshing: true, error: null });
  const request = messageCenterService.summary()
    .then((summary) => {
      if (requestGeneration !== cacheGeneration) return summary;
      updateSnapshot({
        summary,
        isRefreshing: false,
        error: null,
        updatedAt: Date.now(),
      });
      return summary;
    })
    .catch((error: unknown) => {
      if (requestGeneration === cacheGeneration) {
        updateSnapshot({ isRefreshing: false, error: normalizeError(error) });
      }
      throw error;
    })
    .finally(() => {
      if (refreshRequest !== request) return;
      refreshRequest = null;
      const shouldRefreshAfterMutation = refreshAfterMutation;
      refreshAfterMutation = false;
      if (shouldRefreshAfterMutation || (requestGeneration !== cacheGeneration && pollingConsumers.size > 0)) {
        refreshWithoutUnhandledRejection();
      }
    });

  refreshRequest = request;
  return refreshRequest;
}

export function refreshMessageCenterSummaryAfterMutation(): void {
  if (refreshRequest) {
    refreshAfterMutation = true;
    return;
  }
  refreshWithoutUnhandledRejection();
}

function setSummaryCacheKey(cacheKey: string): void {
  if (snapshot.cacheKey === cacheKey) return;

  cacheGeneration += 1;
  updateSnapshot({
    cacheKey,
    summary: null,
    isRefreshing: true,
    error: null,
    updatedAt: 0,
  });
}

function refreshWithoutUnhandledRejection(): void {
  void refreshMessageCenterSummary().catch(() => undefined);
}

function currentPollInterval(): number {
  return Math.min(...pollingConsumers.values());
}

function shouldPoll(intervalMs: number): boolean {
  return typeof document === 'undefined'
    || (document.visibilityState !== 'hidden' && Date.now() - snapshot.updatedAt >= intervalMs);
}

function pollIfStale(): void {
  if (pollingConsumers.size === 0) return;
  const intervalMs = currentPollInterval();
  if (shouldPoll(intervalMs)) refreshWithoutUnhandledRejection();
}

function handleVisibilityChange(): void {
  if (document.visibilityState !== 'hidden') pollIfStale();
}

function attachGlobalListeners(): void {
  if (globalListenersAttached || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  globalListenersAttached = true;
}

function detachGlobalListeners(): void {
  if (!globalListenersAttached || typeof document === 'undefined') return;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  globalListenersAttached = false;
}

function restartPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  if (pollingConsumers.size === 0) {
    detachGlobalListeners();
    return;
  }

  attachGlobalListeners();
  pollTimer = window.setInterval(pollIfStale, currentPollInterval());
}

function addPollingConsumer(intervalMs: number): () => void {
  const consumerID = ++nextPollingConsumerID;
  pollingConsumers.set(consumerID, Math.max(MIN_POLL_INTERVAL_MS, intervalMs));
  restartPolling();

  return () => {
    pollingConsumers.delete(consumerID);
    restartPolling();
  };
}

export function useMessageCenterSummary(
  options: UseMessageCenterSummaryOptions = {},
): UseMessageCenterSummaryResult {
  const {
    cacheKey,
    enabled = true,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;
  const currentSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const cacheMatches = cacheKey === undefined || currentSnapshot.cacheKey === cacheKey;

  useLayoutEffect(() => {
    if (enabled && cacheKey !== undefined) setSummaryCacheKey(cacheKey);
  }, [cacheKey, enabled]);

  useEffect(() => {
    if (!enabled) return;

    if (shouldPoll(pollIntervalMs)) refreshWithoutUnhandledRejection();
    if (pollIntervalMs <= 0) return;
    return addPollingConsumer(pollIntervalMs);
  }, [enabled, pollIntervalMs]);

  return {
    summary: cacheMatches ? currentSnapshot.summary : null,
    isLoading: cacheMatches
      ? currentSnapshot.summary === null && currentSnapshot.isRefreshing
      : enabled,
    isRefreshing: cacheMatches ? currentSnapshot.isRefreshing : false,
    error: cacheMatches ? currentSnapshot.error : null,
    refresh: refreshMessageCenterSummary,
  };
}
