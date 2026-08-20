import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { toAppError, toAppErrorFeedback, type AppError } from '@/libs/http/apiClient';
import {
  archiveMistake,
  fetchMistakes,
  type MistakeQueryParams,
  type MistakeRecord,
  type PaginationInfo,
} from '@/modules/mistake/services/mistakeService';
import type { LoadingState } from '@/types';

const initialPagination: PaginationInfo = {
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 0,
};

export function getDifficultyBadge(difficulty: number) {
  if (difficulty >= 0.7) return { variant: 'destructive' as const, label: '困难' };
  if (difficulty >= 0.4) return { variant: 'warning' as const, label: '中等' };
  return { variant: 'success' as const, label: '简单' };
}

export function getErrorTypeLabel(errorType: string | null) {
  const labels: Record<string, string> = {
    conceptual: '概念性错误',
    procedural: '过程性错误',
    logical: '逻辑错误',
    symbolic: '符号错误',
    calculation: '计算错误',
  };
  return errorType ? labels[errorType] || '未知错误' : '未分类';
}

export type MistakeBookFilters = Pick<
  MistakeQueryParams,
  'conceptId' | 'errorType' | 'dueStatus' | 'stage' | 'errorCountMin' | 'sortBy' | 'sortOrder'
>;

export function buildMistakeBookRequestKey(
  filters: MistakeBookFilters = {},
  page = 1,
): string {
  return [
    filters.conceptId?.trim() || '',
    filters.errorType?.trim() || '',
    filters.dueStatus || 'all',
    Number.isInteger(filters.stage) && (filters.stage ?? 0) >= 0 ? filters.stage : '',
    Number.isInteger(filters.errorCountMin) && (filters.errorCountMin ?? 0) > 0
      ? filters.errorCountMin
      : '',
    filters.sortBy || 'time',
    filters.sortOrder || 'desc',
    Math.max(1, page),
  ].join('\u0000');
}

export function useMistakeBook(
  filters: MistakeBookFilters | string = {},
  requestedPage = 1,
) {
  const { toast } = useToast();
  const filterParams: MistakeBookFilters = typeof filters === 'string'
    ? { conceptId: filters }
    : filters;
  const normalizedConceptId = filterParams.conceptId?.trim() || undefined;
  const normalizedErrorType = filterParams.errorType?.trim() || undefined;
  const normalizedDueStatus = filterParams.dueStatus || 'all';
  const normalizedStage = Number.isInteger(filterParams.stage) && (filterParams.stage ?? 0) >= 0
    ? filterParams.stage
    : undefined;
  const normalizedErrorCountMin = Number.isInteger(filterParams.errorCountMin)
    && (filterParams.errorCountMin ?? 0) > 0
    ? filterParams.errorCountMin
    : undefined;
  const normalizedSortBy = filterParams.sortBy || 'time';
  const normalizedSortOrder = filterParams.sortOrder || 'desc';
  const page = Math.max(1, requestedPage);
  const requestKey = buildMistakeBookRequestKey({
    conceptId: normalizedConceptId,
    errorType: normalizedErrorType,
    dueStatus: normalizedDueStatus,
    stage: normalizedStage,
    errorCountMin: normalizedErrorCountMin,
    sortBy: normalizedSortBy,
    sortOrder: normalizedSortOrder,
  }, page);
  const [mistakes, setMistakes] = useState<MistakeRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>(initialPagination);
  const [mistakesLoading, setMistakesLoading] = useState<LoadingState>('idle');
  const [mistakesError, setMistakesError] = useState<AppError | null>(null);
  const [resolvedRequestKey, setResolvedRequestKey] = useState('');
  const [reloadVersion, setReloadVersion] = useState(0);
  const [archivingIds, setArchivingIds] = useState<string[]>([]);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();

    setMistakesLoading('loading');
    setMistakesError(null);

    void fetchMistakes(
      {
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
    )
      .then((response) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;
        const lastPage = Math.max(response.pagination.totalPages, 1);
        if (page > lastPage) {
          setMistakes([]);
          setPagination({ ...response.pagination, page: lastPage });
          setResolvedRequestKey(requestKey);
          setMistakesLoading('success');
          return;
        }
        setMistakes(response.items);
        setPagination(response.pagination);
        setResolvedRequestKey(requestKey);
        setMistakesLoading('success');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;
        setMistakesLoading('error');
        setMistakesError(toAppError(error, '获取错题列表失败'));
      });

    return () => controller.abort();
  }, [
    normalizedConceptId,
    normalizedDueStatus,
    normalizedErrorCountMin,
    normalizedErrorType,
    normalizedSortBy,
    normalizedSortOrder,
    normalizedStage,
    page,
    reloadVersion,
    requestKey,
  ]);

  const reloadMistakes = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, []);

  const handleArchiveMistake = useCallback(async (attemptId: string) => {
    if (!window.confirm('归档后该题将从错题库隐藏，历史作答和诊断证据仍会保留。确定继续吗？')) {
      return false;
    }

    setArchivingIds((ids) => ids.includes(attemptId) ? ids : [...ids, attemptId]);
    try {
      const response = await archiveMistake(attemptId);
      if (!mountedRef.current) return false;
      toast({
        type: 'success',
        title: '错题已归档',
        description: response.message || '历史作答和诊断证据已保留',
      });
      setReloadVersion((version) => version + 1);
      return true;
    } catch (error) {
      if (!mountedRef.current) return false;
      const feedback = toAppErrorFeedback(error, '归档错题失败');
      if (feedback) toast(feedback);
      return false;
    } finally {
      if (mountedRef.current) {
        setArchivingIds((ids) => ids.filter((id) => id !== attemptId));
      }
    }
  }, [toast]);

  return {
    mistakes,
    pagination,
    mistakesLoading,
    mistakesError,
    resolvedRequestKey,
    archivingIds,
    handleArchiveMistake,
    reloadMistakes,
  };
}
