import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Flame,
  Loader2,
  MessageCircle,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ExercisePanel, useExerciseViewModel } from '@/modules/exercise';
import type { SubmitResult } from '@/modules/exercise/services/exerciseService';
import { dailyQuestionService } from '@/modules/daily-question/services/dailyQuestionService';
import {
  getDailyQuestionPresentation,
  type DailyQuestionAssignment,
  type DailyQuestionHistory,
  type DailyQuestionHistoryItem,
} from '@/modules/daily-question/types/dailyQuestion';
import { toAppError, type AppError } from '@/libs/http/apiClient';
import { useSerialPolling } from '@/hooks/useSerialPolling';
import { useShanghaiDate } from '@/modules/daily-question/hooks/useShanghaiDate';
import { buildExerciseTutorLaunch } from './exerciseTutorLaunch';

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const weekdayFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'UTC',
  weekday: 'short',
});

const monthDayFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'UTC',
  month: 'numeric',
  day: 'numeric',
});

function shiftISODate(date: string, offsetDays: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + offsetDays);
  return parsed.toISOString().slice(0, 10);
}

function getRecentDates(today: string): string[] {
  return Array.from({ length: 7 }, (_, index) => shiftISODate(today, index - 6));
}

function formatDateLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : monthDayFormatter.format(parsed);
}

function formatWeekday(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? '' : weekdayFormatter.format(parsed).replace('周', '');
}

function sourceLabel(source: string | null): string {
  switch (source) {
    case 'teacher_candidate':
    case 'daily_candidate':
      return '教师每日候选';
    case 'teacher_published':
    case 'teacher_bank':
    case 'published':
      return '教师已发布题库';
    case 'ai_generated':
    case 'ai_fallback':
      return 'AI 验证题';
    default:
      return source ? '每日题' : '今日任务';
  }
}

function selectionReasonLabel(reason: string | null): string | null {
  switch (reason) {
    case 'review_due_mistake':
    case 'mistake_review':
      return '优先复习待订正知识点';
    case 'current_learning_goal':
    case 'learning_goal':
      return '匹配当前学习目标';
    case 'weakest_concept':
      return '针对薄弱知识点';
    case 'no_class_ai_fallback':
      return '未加入班级，使用 AI 兜底';
    case 'default_concept':
      return '按当前可用知识点安排';
    case 'teacher_concept_fallback':
      return '优先使用教师题库中的可用知识点';
    default:
      return null;
  }
}

function toHistoryMap(items: DailyQuestionHistoryItem[]): Map<string, DailyQuestionHistoryItem> {
  return new Map(items.map((item) => [item.assignmentDate, item]));
}

function isRecordedDecision(result: SubmitResult | null): boolean {
  return Boolean(
    result && result.recorded !== false && result.gradingStatus !== 'indeterminate',
  );
}

export function DailyQuestionPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedDate = searchParams.get('date')?.trim() ?? '';
  const selectedDate = isoDatePattern.test(requestedDate) ? requestedDate : null;
  const todayDate = useShanghaiDate();
  const activeDate = selectedDate ?? todayDate;
  const isHistorical = activeDate !== todayDate;
  const recentDates = useMemo(() => getRecentDates(todayDate), [todayDate]);

  const [assignment, setAssignment] = useState<DailyQuestionAssignment | null>(null);
  const [history, setHistory] = useState<DailyQuestionHistory>({ items: [], streakDays: 0 });
  const [isLoadingAssignment, setIsLoadingAssignment] = useState(true);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isPreparing, setIsPreparing] = useState(false);
  const [assignmentError, setAssignmentError] = useState<AppError | null>(null);
  const [historyError, setHistoryError] = useState<AppError | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [panelDismissed, setPanelDismissed] = useState(false);
  const loadedAssignmentKeyRef = useRef<string | null>(null);
  const handledResultRef = useRef<SubmitResult | null>(null);
  const autoPrepareKeyRef = useRef<string | null>(null);
  const activeDateRef = useRef(activeDate);
  const assignmentRequestRef = useRef(0);
  const historyRequestRef = useRef(0);
  const prepareRequestRef = useRef(0);
  activeDateRef.current = activeDate;

  const {
    currentQuestion,
    isSubmitting,
    submitPhase,
    submitResult,
    solution,
    isLoadingSolution,
    solutionError,
    error: exerciseError,
    errorType,
    errorSource,
    loadQuestion,
    clearQuestion,
    submitAnswer,
    loadSolution,
  } = useExerciseViewModel({
    dailyAssignmentId: assignment?.assignmentDate === activeDate
      ? assignment.assignmentId ?? undefined
      : undefined,
  });

  const loadAssignment = useCallback(async (signal?: AbortSignal, silent = false) => {
    const requestDate = activeDate;
    const requestID = assignmentRequestRef.current + 1;
    assignmentRequestRef.current = requestID;
    if (!silent) {
      setIsLoadingAssignment(true);
    }
    setAssignmentError(null);
    try {
      const nextAssignment = selectedDate
        ? await dailyQuestionService.getByDate(selectedDate, signal)
        : await dailyQuestionService.getToday(signal);
      if (
        signal?.aborted
        || assignmentRequestRef.current !== requestID
        || activeDateRef.current !== requestDate
      ) return;
      setAssignment(nextAssignment);
    } catch (loadError) {
      if (
        signal?.aborted
        || assignmentRequestRef.current !== requestID
        || activeDateRef.current !== requestDate
      ) return;
      setAssignment(null);
      setAssignmentError(toAppError(loadError, '读取每日一题失败，请稍后重试'));
    } finally {
      if (
        !signal?.aborted
        && assignmentRequestRef.current === requestID
        && activeDateRef.current === requestDate
      ) {
        setIsLoadingAssignment(false);
      }
    }
  }, [activeDate, selectedDate]);

  const loadHistory = useCallback(async (signal?: AbortSignal, silent = false) => {
    const requestID = historyRequestRef.current + 1;
    historyRequestRef.current = requestID;
    if (!silent) {
      setIsLoadingHistory(true);
    }
    setHistoryError(null);
    try {
      const nextHistory = await dailyQuestionService.getHistory(7, signal);
      if (signal?.aborted || historyRequestRef.current !== requestID) return;
      setHistory(nextHistory);
    } catch (loadError) {
      if (signal?.aborted || historyRequestRef.current !== requestID) return;
      setHistoryError(toAppError(loadError, '读取近期完成记录失败，请稍后重试'));
    } finally {
      if (!signal?.aborted && historyRequestRef.current === requestID) {
        setIsLoadingHistory(false);
      }
    }
  }, []);

  const refreshDailyData = useCallback(async () => {
    await Promise.all([loadAssignment(undefined, true), loadHistory(undefined, true)]);
  }, [loadAssignment, loadHistory]);

  useEffect(() => {
    const controller = new AbortController();
    assignmentRequestRef.current += 1;
    prepareRequestRef.current += 1;
    setAssignment(null);
    setIsPreparing(false);
    setAssignmentError(null);
    setPanelDismissed(false);
    loadedAssignmentKeyRef.current = null;
    handledResultRef.current = null;
    autoPrepareKeyRef.current = null;
    clearQuestion();
    void loadAssignment(controller.signal);
    void loadHistory(controller.signal);
    return () => controller.abort();
  }, [activeDate, clearQuestion, loadAssignment, loadHistory, todayDate]);

  const pollPreparingAssignment = useCallback(async (signal: AbortSignal) => {
    if (assignment?.status !== 'preparing' || assignment.assignmentDate !== activeDate) return;
    const requestDate = activeDate;
    const requestID = assignmentRequestRef.current + 1;
    assignmentRequestRef.current = requestID;
    const nextAssignment = isHistorical
      ? await dailyQuestionService.getByDate(activeDate, signal)
      : await dailyQuestionService.prepareToday(signal);
    if (
      !signal.aborted
      && assignmentRequestRef.current === requestID
      && activeDateRef.current === requestDate
    ) {
      setAssignment(nextAssignment);
    }
  }, [activeDate, assignment?.assignmentDate, assignment?.status, isHistorical]);

  useSerialPolling(
    pollPreparingAssignment,
    assignment?.status === 'preparing' ? 2_000 : 0,
  );

  useEffect(() => {
    const question = assignment?.question;
    const assignmentKey = assignment?.assignmentId ?? assignment?.assignmentDate ?? null;
    const mayAnswer = assignment?.status === 'ready'
      || (
        assignment?.status === 'completed'
        && assignment.firstResult === 'incorrect'
        && !assignment.correctedAttemptId
      );
    if (!question || !assignmentKey || !mayAnswer) {
      if (loadedAssignmentKeyRef.current !== null || currentQuestion) {
        loadedAssignmentKeyRef.current = null;
        clearQuestion();
      }
      return;
    }
    if (loadedAssignmentKeyRef.current === assignmentKey) return;

    loadedAssignmentKeyRef.current = assignmentKey;
    loadQuestion(question);
    setResetKey((value) => value + 1);
  }, [assignment, clearQuestion, currentQuestion, loadQuestion]);

  useEffect(() => {
    if (!isRecordedDecision(submitResult) || handledResultRef.current === submitResult) return;
    handledResultRef.current = submitResult;
    void refreshDailyData();
  }, [refreshDailyData, submitResult]);

  useEffect(() => {
    if (errorType !== 'daily_assignment_stale') return;
    loadedAssignmentKeyRef.current = null;
    setAssignment(null);
    setIsLoadingAssignment(true);
    clearQuestion();
    void refreshDailyData();
  }, [clearQuestion, errorType, refreshDailyData]);

  const prepareAssignment = useCallback(async () => {
    if (isPreparing) return;
    const requestDate = activeDate;
    const requestID = assignmentRequestRef.current + 1;
    const prepareID = prepareRequestRef.current + 1;
    assignmentRequestRef.current = requestID;
    prepareRequestRef.current = prepareID;
    setIsPreparing(true);
    setAssignmentError(null);
    try {
      const nextAssignment = isHistorical
        ? await dailyQuestionService.getByDate(activeDate)
        : await dailyQuestionService.prepareToday();
      if (
        assignmentRequestRef.current !== requestID
        || prepareRequestRef.current !== prepareID
        || activeDateRef.current !== requestDate
      ) return;
      setAssignment(nextAssignment);
      void loadHistory(undefined, true);
    } catch (prepareError) {
      if (
        assignmentRequestRef.current !== requestID
        || prepareRequestRef.current !== prepareID
        || activeDateRef.current !== requestDate
      ) return;
      setAssignmentError(toAppError(
        prepareError,
        isHistorical ? '恢复历史题目失败，请稍后重试' : '准备今日题目失败，请稍后重试',
      ));
    } finally {
      if (prepareRequestRef.current === prepareID && activeDateRef.current === requestDate) {
        setIsPreparing(false);
      }
    }
  }, [activeDate, isHistorical, isPreparing, loadHistory]);

  useEffect(() => {
    if (isHistorical || isPreparing || !assignment) return;
    if (assignment.assignmentDate !== activeDate) return;
    if (assignment.failureCode === 'teacher_not_assigned') return;
    const shouldPrepare = assignment.status === 'not_started'
      || (assignment.status === 'ready' && !assignment.openedAt);
    if (!shouldPrepare) return;
    const key = `${assignment.status}:${assignment.assignmentId ?? assignment.assignmentDate}`;
    if (autoPrepareKeyRef.current === key) return;
    autoPrepareKeyRef.current = key;
    void prepareAssignment();
  }, [activeDate, assignment, isHistorical, isPreparing, prepareAssignment]);

  const retryLoad = () => {
    void refreshDailyData();
  };

  const openHistoryDate = (date: string) => {
    navigate(date === todayDate ? '/daily-question' : `/daily-question?date=${encodeURIComponent(date)}`);
  };

  const restartSameQuestion = useCallback(() => {
    if (!assignment?.question) return;
    loadedAssignmentKeyRef.current = assignment.assignmentId ?? assignment.assignmentDate;
    loadQuestion(assignment.question);
    setResetKey((value) => value + 1);
    setPanelDismissed(false);
  }, [assignment, loadQuestion]);

  const handlePanelNext = () => {
    if (!submitResult) {
      restartSameQuestion();
      return;
    }

    if (submitResult.isCorrect) {
      setPanelDismissed(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    restartSameQuestion();
  };

  const openTutor = () => {
    const question = assignment?.assignmentDate === activeDate
      && assignment.status === 'completed'
      && assignment.firstResult === 'incorrect'
      ? assignment.question
      : null;
    if (!question) return;
    navigate('/session/new', { state: buildExerciseTutorLaunch(question) });
  };

  const presentation = getDailyQuestionPresentation(assignment);
  const assignmentMatchesActiveDate = assignment?.assignmentDate === activeDate;
  const isTeacherNotAssigned = assignment?.failureCode === 'teacher_not_assigned';
  const historyByDate = toHistoryMap(history.items);
  const selectedHistoryItem = historyByDate.get(activeDate);
  const currentAssignmentKey = assignment?.assignmentId ?? assignment?.assignmentDate ?? null;
  const canRenderPanel = Boolean(
    assignmentMatchesActiveDate
      && assignment?.question
      && currentQuestion?.id === assignment.question.id
      && loadedAssignmentKeyRef.current === currentAssignmentKey
      && !panelDismissed
      && (
        assignment.status === 'ready'
        || (
          assignment.status === 'completed'
          && assignment.firstResult === 'incorrect'
          && (!assignment.correctedAttemptId || Boolean(submitResult))
        )
      ),
  );
  const panelNextLabel = submitResult?.isCorrect
    ? '查看完成记录'
    : assignment?.status === 'completed'
      ? '订正这道题'
      : '下一步';
  const selectionReason = selectionReasonLabel(assignment?.selectionReason ?? null);

  return (
    <MainLayout>
      <div className="container mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Button variant="ghost" className="mb-3" onClick={() => navigate('/home')}>
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
              返回首页
            </Button>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-bold text-surface-900 dark:text-surface-100">每日一题</h1>
              {isHistorical ? <Badge variant="outline">补做 {formatDateLabel(activeDate)}</Badge> : null}
            </div>
            <p className="mt-2 text-sm text-surface-500 dark:text-surface-400">
              {isHistorical ? '补做记录不会恢复连续完成天数。' : '今天只有这一题，刷新或重新进入都不会更换。'}
            </p>
          </div>
          {assignment?.targetConceptName ? (
            <Badge variant="secondary" className="shrink-0 self-start">
              {assignment.targetConceptName}
            </Badge>
          ) : null}
        </div>

        {isLoadingAssignment || (assignment !== null && !assignmentMatchesActiveDate) ? (
          <div className="flex min-h-56 items-center justify-center gap-3 text-surface-500 dark:text-surface-400">
            <Loader2 className="h-7 w-7 animate-spin text-primary-500" aria-hidden="true" />
            正在读取每日任务
          </div>
        ) : assignmentError ? (
          <Card className="border-red-200 dark:border-red-900">
            <CardContent className="flex flex-col items-center gap-4 p-8">
              <RequestErrorNotice
                error={assignmentError}
                onRetry={retryLoad}
                onRefresh={retryLoad}
                className="w-full max-w-xl"
              />
              <div className="flex flex-wrap justify-center gap-3">
                <Button onClick={() => navigate('/exercise')}>
                  进入智能刷题
                  <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : assignment ? (
          <>
            <Card className="mb-6 border-surface-200 dark:border-surface-700">
              <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${
                    presentation.tone === 'success'
                      ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300'
                      : presentation.tone === 'warning' || presentation.tone === 'danger'
                        ? 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300'
                        : 'bg-primary-50 text-primary-600 dark:bg-primary-950/50 dark:text-primary-300'
                  }`}>
                    {assignment.status === 'preparing' || isPreparing ? (
                      <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                    ) : presentation.tone === 'success' ? (
                      <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                    ) : presentation.tone === 'warning' || presentation.tone === 'danger' ? (
                      <CircleAlert className="h-5 w-5" aria-hidden="true" />
                    ) : (
                      <BookOpen className="h-5 w-5" aria-hidden="true" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-100">{presentation.label}</h2>
                      {assignment.source ? <Badge variant="outline">{sourceLabel(assignment.source)}</Badge> : null}
                      {isHistorical && !assignment.countsTowardStreak ? <Badge variant="secondary">不计入连续天数</Badge> : null}
                    </div>
                    <p className="mt-1 text-sm leading-5 text-surface-500 dark:text-surface-400">
                      {presentation.description}
                    </p>
                    {selectionReason ? <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">{selectionReason}</p> : null}
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                  {assignment.status === 'not_started' && !isHistorical && !isTeacherNotAssigned ? (
                    <Button onClick={() => void prepareAssignment()} isLoading={isPreparing}>
                      开始今日一题
                      {!isPreparing ? <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /> : null}
                    </Button>
                  ) : null}
                  {assignment.status === 'unavailable' && !isTeacherNotAssigned ? (
                    <Button variant="outline" onClick={() => void prepareAssignment()} isLoading={isPreparing}>
                      <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                      {isHistorical ? '恢复补做' : '重试'}
                    </Button>
                  ) : null}
                  {assignment.status === 'preparing' ? (
                    <Button variant="outline" onClick={() => void prepareAssignment()} isLoading={isPreparing}>
                      {!isPreparing ? <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" /> : null}
                      检查并恢复
                    </Button>
                  ) : null}
                  {assignment.status === 'completed' && assignment.firstResult === 'incorrect' && assignment.firstAttemptId ? (
                    <Button variant="outline" onClick={() => navigate(`/diagnosis/${encodeURIComponent(assignment.firstAttemptId!)}`)}>
                      查看诊断
                    </Button>
                  ) : null}
                  {assignment.question
                    && assignment.status === 'completed'
                    && assignment.firstResult === 'incorrect' ? (
                    <Button variant="outline" onClick={openTutor}>
                      <MessageCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                      询问 AI 导师
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            {assignment.status === 'preparing' && isHistorical ? (
              <Card className="border-surface-200 dark:border-surface-700">
                <CardContent className="flex min-h-56 flex-col items-center justify-center gap-3 p-8 text-center">
                  <Loader2 className="h-10 w-10 animate-spin text-primary-500" aria-hidden="true" />
                  <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-100">正在恢复这一天的题目</h2>
                  <p className="max-w-md text-sm leading-6 text-surface-500 dark:text-surface-400">
                    恢复完成后可以继续补做，补做不会恢复连续完成天数。
                  </p>
                  <Button variant="outline" onClick={() => void prepareAssignment()} isLoading={isPreparing}>
                    {!isPreparing ? <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" /> : null}
                    检查恢复状态
                  </Button>
                </CardContent>
              </Card>
            ) : assignment.status === 'preparing' ? (
              <Card className="border-surface-200 dark:border-surface-700">
                <CardContent className="flex min-h-56 flex-col items-center justify-center gap-3 p-8 text-center">
                  <Loader2 className="h-10 w-10 animate-spin text-primary-500" aria-hidden="true" />
                  <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-100">正在准备今天的题目</h2>
                  <p className="max-w-md text-sm leading-6 text-surface-500 dark:text-surface-400">
                    题目会在通过验证后固定分配给你，请保持此页面打开或稍后回来继续。
                  </p>
                </CardContent>
              </Card>
            ) : null}

            {assignment.status === 'not_started' && isHistorical ? (
              <Card className="border-surface-200 dark:border-surface-700">
                <CardContent className="p-8 text-center text-sm text-surface-500 dark:text-surface-400">
                  这一天没有可补做的每日题记录。
                </CardContent>
              </Card>
            ) : null}

            {isTeacherNotAssigned ? (
              <Card className="border-amber-200 dark:border-amber-900">
                <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
                  <CalendarDays className="h-10 w-10 text-amber-500" aria-hidden="true" />
                  <div>
                    <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-100">
                      老师今天还没有布置统一题
                    </h2>
                    <p className="mt-2 max-w-md text-sm leading-6 text-surface-500 dark:text-surface-400">
                      布置完成后，这里会显示今天固定的班级题目。
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => navigate('/exercise?mode=ai')}>
                    进入 AI 自主练习
                  </Button>
                </CardContent>
              </Card>
            ) : assignment.status === 'unavailable' ? (
              <Card className="border-surface-200 dark:border-surface-700">
                <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
                  <XCircle className="h-10 w-10 text-surface-400" aria-hidden="true" />
                  <p className="max-w-md text-sm leading-6 text-surface-500 dark:text-surface-400">
                    {isHistorical
                      ? '这一天的题目暂时不可用。你可以恢复后补做，但不会恢复连续完成天数。'
                      : '今天的题目暂时不可用。你可以重试，或先进入智能刷题继续学习。'}
                  </p>
                  <div className="flex flex-wrap justify-center gap-3">
                    <Button variant="outline" onClick={() => void prepareAssignment()} isLoading={isPreparing}>
                      {!isPreparing ? <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" /> : null}
                      {isHistorical ? '恢复补做' : '重试'}
                    </Button>
                    <Button variant="outline" onClick={() => navigate('/exercise')}>
                      进入智能刷题
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {assignment.status === 'ready' && !assignment.question ? (
              <Card className="border-amber-200 dark:border-amber-900">
                <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
                  <AlertCircle className="h-10 w-10 text-amber-500" aria-hidden="true" />
                  <p className="text-sm text-surface-600 dark:text-surface-300">题目内容暂未返回，请重新加载。</p>
                  <Button variant="outline" onClick={retryLoad}>
                    <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                    重新加载
                  </Button>
                </CardContent>
              </Card>
            ) : null}

            {canRenderPanel ? (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                <div className={`min-w-0 ${assignment.firstResult === 'incorrect' ? 'lg:col-span-8' : 'lg:col-span-12'}`}>
                  <ExercisePanel
                    currentQuestion={currentQuestion}
                    isLoading={false}
                    isSubmitting={isSubmitting}
                    submitPhase={submitPhase}
                    submitResult={submitResult}
                    solution={solution}
                    isLoadingSolution={isLoadingSolution}
                    solutionError={solutionError}
                    error={exerciseError}
                    errorType={errorType}
                    errorSource={errorSource}
                    onNextQuestion={handlePanelNext}
                    submitAnswer={submitAnswer}
                    onLoadSolution={loadSolution}
                    nextButtonLabel={panelNextLabel}
                    resetKey={resetKey}
                  />
                </div>
                {assignment.firstResult === 'incorrect' ? (
                  <aside className="space-y-4 lg:col-span-4">
                    <Card className="border-surface-200 dark:border-surface-700">
                      <CardHeader className="border-b border-surface-100 dark:border-surface-800">
                        <CardTitle className="flex items-center gap-2 text-lg">
                          <Sparkles className="h-5 w-5 text-primary-500" aria-hidden="true" />
                          今日辅导
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4 p-5">
                        <p className="text-sm leading-6 text-surface-500 dark:text-surface-400">
                          围绕这道固定题梳理思路，再完成自己的作答。
                        </p>
                        <Button className="w-full" onClick={openTutor}>
                          <MessageCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                          询问 AI 导师
                        </Button>
                        {assignment.firstAttemptId ? (
                          <Button
                            className="w-full"
                            variant="outline"
                            onClick={() => navigate(`/diagnosis/${encodeURIComponent(assignment.firstAttemptId!)}`)}
                          >
                            查看错误诊断
                          </Button>
                        ) : null}
                      </CardContent>
                    </Card>
                  </aside>
                ) : null}
              </div>
            ) : null}

            {assignment.status === 'completed' && !canRenderPanel ? (
              <Card className="border-surface-200 dark:border-surface-700">
                <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
                  {assignment.firstResult === 'correct' || assignment.correctedAttemptId ? (
                    <CheckCircle2 className="h-11 w-11 text-emerald-500" aria-hidden="true" />
                  ) : (
                    <Flame className="h-11 w-11 text-amber-500" aria-hidden="true" />
                  )}
                  <h2 className="text-xl font-semibold text-surface-900 dark:text-surface-100">{presentation.label}</h2>
                  <p className="max-w-md text-sm leading-6 text-surface-500 dark:text-surface-400">
                    {assignment.firstResult === 'correct'
                      ? `连续完成 ${Math.max(0, assignment.streakDays)} 天，明天再来继续保持。`
                      : assignment.correctedAttemptId
                        ? '首次作答结果已计入今日统计，订正记录已保存。'
                        : '首次作答结果已记录，答错也会保持连续完成。'}
                  </p>
                </CardContent>
              </Card>
            ) : null}
          </>
        ) : null}

        <section className="mt-8 border-t border-surface-200 pt-6 dark:border-surface-800">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-100">最近 7 天</h2>
              <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">连续完成 {Math.max(history.streakDays, assignment?.streakDays ?? 0)} 天</p>
            </div>
          </div>
          {isLoadingHistory ? (
            <div className="flex min-h-24 items-center justify-center text-sm text-surface-500 dark:text-surface-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              正在加载完成记录
            </div>
          ) : historyError ? (
            <RequestErrorNotice
              error={historyError}
              onRetry={() => void loadHistory()}
              onRefresh={() => void loadHistory()}
            />
          ) : (
            <div className="grid grid-cols-7 gap-1.5 sm:gap-3">
              {recentDates.map((date) => {
                const item = date === assignment?.assignmentDate
                  ? (() => {
                      const { question, ...historyItem } = assignment;
                      void question;
                      return historyItem;
                    })()
                  : historyByDate.get(date);
                const itemPresentation = item
                  ? getDailyQuestionPresentation(item)
                  : null;
                const isSelected = date === activeDate;
                const isOpenable = Boolean(item?.assignmentId && item.status !== 'not_started');
                const cellClass = itemPresentation?.tone === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200'
                  : itemPresentation?.tone === 'warning'
                    ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
                    : itemPresentation?.tone === 'danger'
                      ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200'
                      : itemPresentation?.tone === 'info'
                        ? 'border-primary-200 bg-primary-50 text-primary-800 dark:border-primary-900 dark:bg-primary-950/30 dark:text-primary-200'
                        : 'border-surface-200 bg-white text-surface-600 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-300';

                return (
                  <button
                    key={date}
                    type="button"
                    disabled={!isOpenable && date !== todayDate}
                    onClick={() => openHistoryDate(date)}
                    className={`min-h-24 rounded-md border px-1 py-2 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-default disabled:opacity-70 sm:px-2 ${cellClass} ${
                      isSelected ? 'ring-2 ring-primary-500 ring-offset-2 dark:ring-offset-surface-950' : ''
                    }`}
                  >
                    <span className="block text-xs opacity-75">{formatWeekday(date)}</span>
                    <span className="mt-1 block text-sm font-semibold">{formatDateLabel(date)}</span>
                    <span className="mt-2 block text-[11px] leading-4 sm:text-xs">
                      {itemPresentation?.label || '未记录'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {selectedHistoryItem?.countsTowardStreak === false && selectedHistoryItem.status === 'completed' ? (
            <p className="mt-3 text-xs text-surface-500 dark:text-surface-400">这是一条补做记录，不影响连续完成天数。</p>
          ) : null}
        </section>
      </div>
    </MainLayout>
  );
}
