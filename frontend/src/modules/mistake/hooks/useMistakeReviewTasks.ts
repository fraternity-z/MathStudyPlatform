import { useCallback, useEffect, useRef, useState } from 'react';
import { toAppError, type AppError } from '@/libs/http/apiClient';
import {
  fetchReviewTasks,
  type ReviewTaskQueryParams,
  type PaginationInfo,
  type ReviewTask,
  type ReviewTaskCounts,
  type ReviewTaskView,
} from '@/modules/mistake/services/mistakeService';
import type { LoadingState } from '@/types';

const initialPagination: PaginationInfo = {
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 0,
};

const initialCounts: ReviewTaskCounts = {
  active: 0,
  dueNow: 0,
  mastered: 0,
};

export type MistakeReviewTaskFilters = Omit<
  ReviewTaskQueryParams,
  'view' | 'page' | 'pageSize'
>;

export function buildReviewTaskRequestKey(
  view: ReviewTaskView,
  filters: MistakeReviewTaskFilters = {},
  page = 1,
): string {
  return [
    view,
    filters.conceptId?.trim() || '',
    filters.errorType?.trim() || '',
    filters.dueStatus || (view === 'due' ? 'due' : 'all'),
    Number.isInteger(filters.stage) && (filters.stage ?? 0) >= 0 ? filters.stage : '',
    Number.isInteger(filters.errorCountMin) && (filters.errorCountMin ?? 0) > 0
      ? filters.errorCountMin
      : '',
    filters.sortBy || '',
    filters.sortOrder || '',
    Math.max(1, page),
  ].join('\u0000');
}

export function useMistakeReviewTasks(
  view: ReviewTaskView,
  filters: MistakeReviewTaskFilters | number = {},
  requestedPage = 1,
) {
  const [tasks, setTasks] = useState<ReviewTask[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>(initialPagination);
  const [counts, setCounts] = useState<ReviewTaskCounts>(initialCounts);
  const [tasksLoading, setTasksLoading] = useState<LoadingState>('idle');
  const [tasksError, setTasksError] = useState<AppError | null>(null);
  const [resolvedRequestKey, setResolvedRequestKey] = useState('');
  const [reloadVersion, setReloadVersion] = useState(0);
  const requestIdRef = useRef(0);
  const page = Math.max(1, typeof filters === 'number' ? filters : requestedPage);
  const filterParams: MistakeReviewTaskFilters = typeof filters === 'number' ? {} : filters;
  const normalizedConceptId = filterParams.conceptId?.trim() || undefined;
  const normalizedErrorType = filterParams.errorType?.trim() || undefined;
  const normalizedDueStatus = filterParams.dueStatus || (view === 'due' ? 'due' : 'all');
  const normalizedStage = Number.isInteger(filterParams.stage) && (filterParams.stage ?? 0) >= 0
    ? filterParams.stage
    : undefined;
  const normalizedErrorCountMin = Number.isInteger(filterParams.errorCountMin)
    && (filterParams.errorCountMin ?? 0) > 0
    ? filterParams.errorCountMin
    : undefined;
  const normalizedSortBy = filterParams.sortBy;
  const normalizedSortOrder = filterParams.sortOrder;
  const requestKey = buildReviewTaskRequestKey(view, {
    conceptId: normalizedConceptId,
    errorType: normalizedErrorType,
    dueStatus: normalizedDueStatus,
    stage: normalizedStage,
    errorCountMin: normalizedErrorCountMin,
    sortBy: normalizedSortBy,
    sortOrder: normalizedSortOrder,
  }, page);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();

    const loadTasks = async () => {
      setTasksLoading('loading');
      setTasksError(null);
      try {
        const response = await fetchReviewTasks(
          {
            view,
            page,
            pageSize: 20,
            conceptId: normalizedConceptId,
            errorType: normalizedErrorType,
            dueStatus: normalizedDueStatus,
            stage: normalizedStage,
            errorCountMin: normalizedErrorCountMin,
            sortBy: normalizedSortBy,
            sortOrder: normalizedSortOrder,
          },
          controller.signal
        );
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;
        const lastPage = Math.max(response.pagination.totalPages, 1);
        if (page > lastPage) {
          setTasks([]);
          setPagination({ ...response.pagination, page: lastPage });
          setCounts(response.counts);
          setResolvedRequestKey(requestKey);
          setTasksLoading('success');
          return;
        }
        setTasks(response.items);
        setPagination(response.pagination);
        setCounts(response.counts);
        setResolvedRequestKey(requestKey);
        setTasksLoading('success');
      } catch (error) {
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;
        setTasksLoading('error');
        setTasksError(toAppError(error, '获取复习任务失败'));
      }
    };

    void loadTasks();

    return () => controller.abort();
  }, [
    normalizedConceptId,
    normalizedErrorType,
    normalizedDueStatus,
    normalizedStage,
    normalizedErrorCountMin,
    normalizedSortBy,
    normalizedSortOrder,
    page,
    reloadVersion,
    requestKey,
    view,
  ]);

  const reloadTasks = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, [setReloadVersion]);

  return {
    tasks,
    pagination,
    counts,
    tasksLoading,
    tasksError,
    resolvedRequestKey,
    reloadTasks,
  };
}
