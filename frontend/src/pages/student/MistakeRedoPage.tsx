import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  History,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Progress } from '@/components/ui/Progress';
import { ExercisePanel, useExerciseViewModel } from '@/modules/exercise';
import type { Question } from '@/modules/exercise/services/exerciseService';
import {
  fetchReviewExerciseByAttempt,
  type ReviewExerciseResponse,
} from '@/modules/mistake/services/mistakeService';
import {
  getDifficultyBadge,
  getErrorTypeLabel,
} from '@/modules/mistake/hooks/useMistakeBook';
import { toAppError, type AppError } from '@/libs/http/apiClient';

const uncategorizedKnowledgePointId = '00000000-0000-0000-0000-000000000001';
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const toQuestion = (review: ReviewExerciseResponse): Question => ({
  id: review.exercise.id,
  title: review.exercise.title,
  content: review.exercise.content,
  difficulty: review.exercise.difficulty,
  type: review.exercise.type,
  source: 'review',
  knowledgePoints: review.exercise.knowledgePoints,
  knowledgePointNames: review.exercise.knowledgePointNames,
  hintsAvailable: review.exercise.hintsAvailable,
  estimatedTimeSeconds: review.exercise.estimatedTimeSeconds,
  options: review.exercise.options,
});

const validateReview = (review: ReviewExerciseResponse): string | null => {
  if (!review.exercise.id.trim() || !review.exercise.content.trim()) {
    return '这道错题缺少必要的题目内容，暂时无法重做';
  }
  if (
    review.exercise.type === 'multiple_choice'
    && (review.exercise.options?.length ?? 0) === 0
  ) {
    return '这道选择题缺少选项，暂时无法重做';
  }
  if (!review.context.originalAttemptId.trim()) {
    return '错题记录信息不完整，请重新加载后再试';
  }
  const hasReviewTaskId = Boolean(review.context.reviewTaskId?.trim());
  const hasReviewTaskRevision = review.context.reviewTaskRevision !== undefined;
  if (hasReviewTaskId !== hasReviewTaskRevision) {
    return '复习任务信息不完整，请重新加载后再试';
  }
  return null;
};

type LoadErrorKind = 'error' | 'not_due' | 'archived';

const getResponseErrorCode = (error: unknown): string => {
  return toAppError(error).code?.trim().toUpperCase() ?? '';
};

const getSafeMistakeBookReturnPath = (value: string | null): string => {
  const fallback = '/mistake-book';
  if (!value) return fallback;

  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin || parsed.pathname !== fallback) {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return fallback;
  }
};

export const MistakeRedoPage: React.FC = () => {
  const navigate = useNavigate();
  const { attemptId } = useParams<{ attemptId: string }>();
  const [searchParams] = useSearchParams();
  const returnPath = getSafeMistakeBookReturnPath(searchParams.get('return_to'));
  const [review, setReview] = useState<ReviewExerciseResponse | null>(null);
  const [isLoadingReview, setIsLoadingReview] = useState(Boolean(attemptId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRequestError, setLoadRequestError] = useState<AppError | null>(null);
  const [loadErrorKind, setLoadErrorKind] = useState<LoadErrorKind | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [resetKey, setResetKey] = useState(0);
  const handledReviewErrorRef = useRef<string | null>(null);
  const {
    currentQuestion,
    isSubmitting,
    submitPhase,
    submitResult,
    solution,
    isLoadingSolution,
    solutionError,
    error,
    errorType,
    errorSource,
    loadQuestion,
    clearQuestion,
    submitAnswer,
    loadSolution,
  } = useExerciseViewModel({
    dailyAssignmentId: review?.context.dailyAssignmentId,
    reviewTaskId: review?.context.reviewTaskId,
    reviewTaskRevision: review?.context.reviewTaskRevision,
    originalAttemptId: review?.context.originalAttemptId,
  });

  useEffect(() => {
    if (!attemptId) {
      setIsLoadingReview(false);
      setLoadError('缺少错题记录 ID');
      return;
    }

    const controller = new AbortController();
    const loadReview = async () => {
      setIsLoadingReview(true);
      setLoadError(null);
      setLoadRequestError(null);
      setLoadErrorKind(null);
      setReview(null);
      try {
        const nextReview = await fetchReviewExerciseByAttempt(attemptId, controller.signal);
        if (controller.signal.aborted) return;
        const validationError = validateReview(nextReview);
        if (validationError) {
          setLoadError(validationError);
          return;
        }
        setReview(nextReview);
        loadQuestion(toQuestion(nextReview));
        handledReviewErrorRef.current = null;
        setResetKey((current) => current + 1);
      } catch (loadFailure) {
        if (controller.signal.aborted) return;
        const requestError = toAppError(loadFailure, '加载错题失败，请稍后重试');
        if (getResponseErrorCode(loadFailure) === 'REVIEW_NOT_DUE') {
          setLoadErrorKind('not_due');
          setLoadError('复习计划状态已变化，请返回错题本后重新进入');
        } else if (requestError.kind === 'not_found') {
          setLoadErrorKind('error');
          setLoadRequestError({
            ...requestError,
            message: '错题记录不存在、已下架或当前不可重做',
          });
        } else {
          setLoadErrorKind('error');
          setLoadRequestError(requestError);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingReview(false);
        }
      }
    };

    void loadReview();
    return () => controller.abort();
  }, [attemptId, loadQuestion, reloadVersion]);

  useEffect(() => {
    const reviewErrorKey = errorType ? `${errorType}:${error ?? ''}` : null;
    if (reviewErrorKey && handledReviewErrorRef.current === reviewErrorKey) return;

    if (errorType === 'review_task_stale') {
      handledReviewErrorRef.current = reviewErrorKey;
      setIsLoadingReview(true);
      setReview(null);
      clearQuestion();
      setReloadVersion((current) => current + 1);
      return;
    }
    if (errorType === 'review_not_due') {
      handledReviewErrorRef.current = reviewErrorKey;
      setLoadErrorKind('not_due');
      setLoadError(error?.message || '复习计划状态已变化，请返回错题本后重新进入');
      setReview(null);
      clearQuestion();
      return;
    }
    if (errorType === 'mistake_record_archived') {
      handledReviewErrorRef.current = reviewErrorKey;
      setLoadErrorKind('archived');
      setLoadError(error?.message || '这条错题记录已归档，请返回错题本');
      setReview(null);
      clearQuestion();
    }
  }, [clearQuestion, error, errorType]);

  const handlePanelNext = useCallback(() => {
    if (submitResult) {
      navigate(returnPath);
      return;
    }
    clearQuestion();
    setReloadVersion((current) => current + 1);
  }, [clearQuestion, navigate, returnPath, submitResult]);

  const currentMastery = useMemo(() => {
    const masteryUpdate = submitResult?.masteryUpdate;
    if (!masteryUpdate || Object.keys(masteryUpdate).length === 0) {
      return review?.context.masteryBefore ?? 0;
    }

    const exerciseValues = (review?.exercise.knowledgePoints ?? [])
      .map((conceptId) => masteryUpdate[conceptId])
      .filter((value): value is number => Number.isFinite(value));
    const values = exerciseValues.length > 0
      ? exerciseValues
      : Object.values(masteryUpdate).filter((value) => Number.isFinite(value));
    if (values.length === 0) return review?.context.masteryBefore ?? 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }, [review?.context.masteryBefore, review?.exercise.knowledgePoints, submitResult?.masteryUpdate]);
  const masteryPercent = Math.round(Math.min(Math.max(currentMastery, 0), 1) * 100);
  const difficulty = useMemo(
    () => getDifficultyBadge(review?.exercise.difficulty ?? 0),
    [review?.exercise.difficulty]
  );

  if (isLoadingReview) {
    return (
      <MainLayout>
        <div className="flex min-h-[60vh] items-center justify-center gap-3 text-surface-500">
          <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
          <span>正在加载错题...</span>
        </div>
      </MainLayout>
    );
  }

  if (loadError || loadRequestError || !review || !currentQuestion) {
    return (
      <MainLayout>
        <div className="container mx-auto flex min-h-[60vh] max-w-3xl flex-col items-center justify-center px-6 text-center">
          {loadRequestError ? (
            <RequestErrorNotice
              error={loadRequestError}
              onRetry={() => setReloadVersion((current) => current + 1)}
              onRefresh={() => setReloadVersion((current) => current + 1)}
              className="w-full max-w-xl text-left"
            />
          ) : (
            <>
              <AlertCircle className="mb-4 h-12 w-12 text-red-400" />
              <h1 className="text-xl font-semibold text-surface-900 dark:text-surface-100">
                {loadErrorKind === 'not_due'
                  ? '复习计划已更新'
                  : loadErrorKind === 'archived'
                    ? '错题记录已归档'
                    : '无法打开这道错题'}
              </h1>
              <p className="mt-2 text-surface-500 dark:text-surface-400">
                {loadError || '错题内容暂不可用'}
              </p>
            </>
          )}
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {attemptId && !loadRequestError && loadErrorKind !== 'not_due' && loadErrorKind !== 'archived' ? (
              <Button variant="outline" onClick={() => setReloadVersion((current) => current + 1)}>
                <RefreshCw className="mr-2 h-4 w-4" />
                重新加载
              </Button>
            ) : null}
            <Button onClick={() => navigate(returnPath)}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回错题本
            </Button>
          </div>
        </div>
      </MainLayout>
    );
  }

  const previousErrorLabel = getErrorTypeLabel(review.context.previousErrorType);
  const knowledgeLabel = review.exercise.knowledgePointNames
    .map((value) => value.trim())
    .find((value) => value && !uuidPattern.test(value))
    || (review.exercise.knowledgePoints.length === 0
      || review.exercise.knowledgePoints.includes(uncategorizedKnowledgePointId)
      ? '未分类'
      : '知识点名称暂缺');

  return (
    <MainLayout>
      <div className="container mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <Button variant="ghost" className="mb-4" onClick={() => navigate(returnPath)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          返回错题本
        </Button>

        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-surface-900 dark:text-surface-100">错题重做</h1>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant="outline">{knowledgeLabel}</Badge>
              <Badge variant={difficulty.variant}>{difficulty.label}</Badge>
              <Badge variant="secondary">错误 {review.context.errorCount} 次</Badge>
              {review.context.previousErrorType ? (
                <Badge variant="warning">{previousErrorLabel}</Badge>
              ) : null}
            </div>
          </div>
          <div className="w-full rounded-lg border border-surface-200 bg-white p-3 dark:border-surface-700 dark:bg-surface-900 sm:w-48">
            <div className="mb-2 flex items-center justify-between text-xs text-surface-500">
              <span>当前掌握度</span>
              <span>{masteryPercent}%</span>
            </div>
            <Progress
              value={masteryPercent}
              size="sm"
              variant={masteryPercent < 60 ? 'destructive' : masteryPercent < 80 ? 'warning' : 'success'}
            />
          </div>
        </div>

        <Card className="mb-6 border-surface-200 dark:border-surface-700">
          <CardContent className="p-0">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-surface-700 dark:text-surface-300">
                <span className="flex items-center gap-2">
                  <History className="h-4 w-4 text-primary-500" />
                  查看上次错误提示
                </span>
                <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-3 border-t border-surface-200 px-4 py-4 text-sm dark:border-surface-700">
                <div>
                  <p className="mb-1 text-xs font-medium text-surface-500">上次答案</p>
                  <div className="rounded-md bg-surface-50 px-3 py-2 text-surface-800 [overflow-wrap:anywhere] dark:bg-surface-800 dark:text-surface-200">
                    {review.context.previousAnswer || '未记录'}
                  </div>
                </div>
                {review.context.previousExplanation ? (
                  <div>
                    <p className="mb-1 text-xs font-medium text-surface-500">错误诊断</p>
                    <p className="text-surface-700 dark:text-surface-300">{review.context.previousExplanation}</p>
                  </div>
                ) : null}
                {review.context.previousSuggestion ? (
                  <div>
                    <p className="mb-1 text-xs font-medium text-surface-500">改进建议</p>
                    <p className="text-surface-700 dark:text-surface-300">{review.context.previousSuggestion}</p>
                  </div>
                ) : null}
              </div>
            </details>
          </CardContent>
        </Card>

        <ExercisePanel
          currentQuestion={currentQuestion}
          isLoading={false}
          isSubmitting={isSubmitting}
          submitPhase={submitPhase}
          submitResult={submitResult}
          solution={solution}
          isLoadingSolution={isLoadingSolution}
          solutionError={solutionError}
          error={error}
          errorType={errorType}
          errorSource={errorSource}
          onNextQuestion={handlePanelNext}
          submitAnswer={submitAnswer}
          onLoadSolution={loadSolution}
          nextButtonLabel="返回错题本"
          resetKey={resetKey}
        />
      </div>
    </MainLayout>
  );
};

export default MistakeRedoPage;
