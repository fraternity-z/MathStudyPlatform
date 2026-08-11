import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  Archive,
  ArrowRight,
  BarChart3,
  CheckCircle,
  Clock3,
  History,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { MainLayout } from '../../components/layout/MainLayout';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { Pagination } from '../../components/ui/Pagination';
import { Progress } from '../../components/ui/Progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/Tabs';
import { ExerciseMathContent } from '@/modules/exercise/components/ExerciseMathContent';
import { knowledgeService } from '@/modules/knowledge/services/knowledgeService';
import {
  getDifficultyBadge,
  getErrorTypeLabel,
  useMistakeBook,
} from '@/modules/mistake/hooks/useMistakeBook';
import { useMistakeReviewTasks } from '@/modules/mistake/hooks/useMistakeReviewTasks';
import type {
  MistakeRecord,
  MistakeExercise,
  ReviewTask,
  ReviewTaskView,
} from '@/modules/mistake/services/mistakeService';

type MistakeBookView = ReviewTaskView | 'library';
type BadgeVariant = 'secondary' | 'success' | 'warning';

const mistakeBookViews = new Set<MistakeBookView>(['due', 'library', 'mastered']);
const masteryTarget = 3;
const uncategorizedKnowledgePointId = '00000000-0000-0000-0000-000000000001';
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function parsePage(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function getPageParam(view: MistakeBookView): string {
  return `${view}_page`;
}

function formatKnowledgePointLabel(
  exercise: MistakeExercise,
  labelsById: ReadonlyMap<string, string>,
): string {
  const name = exercise.knowledgePointNames
    .map((value) => value.trim())
    .find((value) => value && !uuidPattern.test(value));
  if (name) return name;

  const conceptId = exercise.knowledgePoints.find((value) => value.trim())?.trim();
  if (!conceptId || conceptId === uncategorizedKnowledgePointId) return '未分类';
  return labelsById.get(conceptId) || '知识点名称暂缺';
}

function parseMistakeBookView(value: string | null): MistakeBookView {
  return value && mistakeBookViews.has(value as MistakeBookView)
    ? value as MistakeBookView
    : 'due';
}

function parseApiTimestamp(value: string | null): Date | null {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value: string | null): string {
  const date = parseApiTimestamp(value);
  if (!date) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getDuePresentation(task: ReviewTask): {
  label: string;
  title: string;
  variant: BadgeVariant;
} {
  if (task.status === 'mastered') {
    return {
      label: '已验证掌握',
      title: task.masteredAt ? `验证时间：${formatDate(task.masteredAt)}` : '已完成掌握验证',
      variant: 'success',
    };
  }

  const dueAt = parseApiTimestamp(task.dueAt);
  return {
    label: task.status === 'verification_due' ? '待巩固验证' : '现在可复习',
    title: dueAt ? `计划时间：${dueAt.toLocaleString('zh-CN')}` : '已到复习时间',
    variant: 'warning',
  };
}

function MasteryProgress({ mastery }: { mastery: number }) {
  const masteryPercent = Math.round(Math.min(Math.max(mastery, 0), 1) * 100);
  return (
    <div className="w-24 shrink-0">
      <div className="mb-1 flex items-center justify-between text-xs text-surface-500 dark:text-surface-400">
        <span>掌握度</span>
        <span>{masteryPercent}%</span>
      </div>
      <Progress
        value={masteryPercent}
        variant={masteryPercent < 60 ? 'destructive' : masteryPercent < 80 ? 'warning' : 'success'}
        size="sm"
      />
    </div>
  );
}

function QuestionPreview({ exercise }: { exercise: MistakeExercise }) {
  const normalizedContent = exercise.content.trim();
  if (!normalizedContent) {
    return (
      <p className="text-sm font-medium text-surface-500 dark:text-surface-400">
        题目内容暂缺
      </p>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-2 text-left [&_.katex-display]:text-left [&_.katex-display_.katex]:text-left">
      <ExerciseMathContent
        value={normalizedContent}
        block
        className="w-fit line-clamp-3 text-base font-semibold leading-7 text-surface-900 dark:text-surface-100"
      />
    </div>
  );
}

function ReviewTaskCard({
  task,
  view,
  knowledgeLabels,
  onReview,
}: {
  task: ReviewTask;
  view: ReviewTaskView;
  knowledgeLabels: ReadonlyMap<string, string>;
  onReview: (attemptId: string) => void;
}) {
  const difficulty = getDifficultyBadge(task.exercise.difficulty);
  const due = getDuePresentation(task);
  const reviewAvailable = task.canReview && Boolean(task.sourceAttemptId.trim());
  const actionLabel = view === 'mastered'
    ? '再次练习'
    : '开始复习';

  return (
    <Card className="border-surface-200 transition-shadow hover:shadow-md dark:border-surface-700">
      <CardContent className="p-5">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="max-w-full truncate text-xs">
                {formatKnowledgePointLabel(task.exercise, knowledgeLabels)}
              </Badge>
              <Badge variant={difficulty.variant} className="text-xs">{difficulty.label}</Badge>
              {task.diagnosis.errorType ? (
                <Badge variant="secondary" className="text-xs">
                  {getErrorTypeLabel(task.diagnosis.errorType)}
                </Badge>
              ) : null}
              <Badge variant={due.variant} className="text-xs" title={due.title}>{due.label}</Badge>
            </div>

            <QuestionPreview exercise={task.exercise} />
            <p className="line-clamp-2 text-sm leading-6 text-surface-600 dark:text-surface-300">
              {task.diagnosis.explanation || '暂无错因诊断'}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-surface-500 dark:text-surface-400">
              <span className="flex items-center gap-1.5">
                <RefreshCw className="h-3.5 w-3.5 text-primary-500" />
                错误 {task.errorCount} 次
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                验证进度 {Math.min(task.successfulReviewCount, masteryTarget)}/{masteryTarget}
              </span>
              {task.lastReviewedAt ? (
                <span className="flex items-center gap-1.5">
                  <History className="h-3.5 w-3.5 text-surface-400" />
                  上次复习 {formatDate(task.lastReviewedAt)}
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 sm:flex-col sm:items-end">
            <MasteryProgress mastery={task.mastery.current} />
            <Button
              size="sm"
              disabled={!reviewAvailable}
              onClick={() => onReview(task.sourceAttemptId)}
              title={due.title}
            >
              {reviewAvailable ? actionLabel : '暂不可用'}
              {reviewAvailable ? <ArrowRight className="ml-1.5 h-3.5 w-3.5" /> : <Clock3 className="ml-1.5 h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MistakeHistoryCard({
  item,
  archiving,
  knowledgeLabels,
  onArchive,
  onReview,
}: {
  item: MistakeRecord;
  archiving: boolean;
  knowledgeLabels: ReadonlyMap<string, string>;
  onArchive: (attemptId: string) => void;
  onReview: (attemptId: string) => void;
}) {
  const difficulty = getDifficultyBadge(item.exercise.difficulty);

  return (
    <Card className="border-surface-200 transition-shadow hover:shadow-md dark:border-surface-700">
      <CardContent className="p-5">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="max-w-full truncate text-xs">
                {formatKnowledgePointLabel(item.exercise, knowledgeLabels)}
              </Badge>
              <Badge variant={difficulty.variant} className="text-xs">{difficulty.label}</Badge>
              {item.diagnosis.errorType ? (
                <Badge variant="secondary" className="text-xs">
                  {getErrorTypeLabel(item.diagnosis.errorType)}
                </Badge>
              ) : null}
            </div>
            <QuestionPreview exercise={item.exercise} />
            <p className="line-clamp-2 text-sm leading-6 text-surface-600 dark:text-surface-300">
              {item.diagnosis.explanation || '暂无错因诊断'}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-surface-500 dark:text-surface-400">
              <span className="flex items-center gap-1.5">
                <Clock3 className="h-3.5 w-3.5 text-primary-500" />
                {formatDate(item.attempt.submittedAt)}
              </span>
              <span className="flex items-center gap-1.5">
                <RefreshCw className="h-3.5 w-3.5 text-primary-500" />
                错误 {item.errorCount} 次
              </span>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 sm:flex-col sm:items-end">
            <MasteryProgress mastery={item.mastery.current} />
            <div className="flex flex-wrap justify-end gap-2">
              {item.canArchive ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={archiving}
                  onClick={() => onArchive(item.id)}
                >
                  {archiving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Archive className="mr-1.5 h-3.5 w-3.5" />}
                  归档
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={!item.canReview}
                onClick={() => onReview(item.id)}
              >
                {item.canReview ? (item.isEarlyPractice ? '提前练习' : '重做') : '暂不可用'}
                {item.canReview
                  ? <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  : <Clock3 className="ml-1.5 h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TabCount({ count }: { count: number }) {
  return (
    <span className="ml-1.5 min-w-5 rounded-full bg-surface-200 px-1.5 py-0.5 text-xs leading-none text-surface-700 group-data-[state=active]:bg-primary-100 group-data-[state=active]:text-primary-700 dark:bg-surface-700 dark:text-surface-300 dark:group-data-[state=active]:bg-primary-900 dark:group-data-[state=active]:text-primary-300">
      {count > 999 ? '999+' : count}
    </span>
  );
}

export const MistakeBookPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeView = parseMistakeBookView(searchParams.get('view'));
  const conceptId = searchParams.get('concept_id')?.trim() || undefined;
  const duePage = parsePage(searchParams.get(getPageParam('due')));
  const libraryPage = parsePage(searchParams.get(getPageParam('library')));
  const masteredPage = parsePage(searchParams.get(getPageParam('mastered')));
  const taskView: ReviewTaskView = activeView === 'mastered' ? 'mastered' : 'due';
  const history = useMistakeBook(conceptId, libraryPage);
  const review = useMistakeReviewTasks(taskView, taskView === 'due' ? duePage : masteredPage);
  const [knowledgeLabels, setKnowledgeLabels] = useState<ReadonlyMap<string, string>>(new Map());
  const isLibrary = activeView === 'library';
  const activeLoading = isLibrary ? history.mistakesLoading : review.tasksLoading;
  const activeError = isLibrary ? history.mistakesError : review.tasksError;
  const activePagination = isLibrary ? history.pagination : review.pagination;
  const activeResolvedRequestKey = isLibrary
    ? history.resolvedRequestKey
    : review.resolvedRequestKey;
  const expectedRequestKey = isLibrary
    ? `${conceptId ?? ''}\u0000${libraryPage}`
    : `${taskView}\u0000${taskView === 'due' ? duePage : masteredPage}`;
  const activeRequestResolved = activeResolvedRequestKey === expectedRequestKey;
  const activeRequestReady = activeLoading === 'success' && activeRequestResolved;

  useEffect(() => {
    const controller = new AbortController();
    void knowledgeService.getKnowledgeGraph()
      .then((graph) => {
        if (controller.signal.aborted) return;
        setKnowledgeLabels(new Map(graph.nodes.map((node) => [node.id, node.label])));
      })
      .catch(() => {
        if (!controller.signal.aborted) setKnowledgeLabels(new Map());
      });
    return () => controller.abort();
  }, []);

  const pageByView = useMemo<Record<MistakeBookView, number>>(() => ({
    due: duePage,
    library: libraryPage,
    mastered: masteredPage,
  }), [duePage, libraryPage, masteredPage]);

  useEffect(() => {
    if (
      activeLoading !== 'success'
      || activeResolvedRequestKey !== expectedRequestKey
      || activePagination.page === pageByView[activeView]
    ) return;
    const nextParams = new URLSearchParams(searchParams);
    const pageParam = getPageParam(activeView);
    if (activePagination.page <= 1) nextParams.delete(pageParam);
    else nextParams.set(pageParam, String(activePagination.page));
    setSearchParams(nextParams, { replace: true });
  }, [
    activeLoading,
    activePagination.page,
    activeResolvedRequestKey,
    activeView,
    expectedRequestKey,
    pageByView,
    searchParams,
    setSearchParams,
  ]);

  const handleViewChange = (value: string) => {
    const nextView = parseMistakeBookView(value);
    const nextParams = new URLSearchParams(searchParams);
    if (nextView === 'due') {
      nextParams.delete('view');
    } else {
      nextParams.set('view', nextView);
    }
    setSearchParams(nextParams, { replace: true });
  };

  const clearConceptFilter = () => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('concept_id');
    nextParams.delete(getPageParam('library'));
    setSearchParams(nextParams, { replace: true });
  };

  const handlePageChange = (nextPage: number) => {
    const normalizedPage = Math.max(1, nextPage);
    const nextParams = new URLSearchParams(searchParams);
    const pageParam = getPageParam(activeView);
    if (normalizedPage === 1) nextParams.delete(pageParam);
    else nextParams.set(pageParam, String(normalizedPage));
    setSearchParams(nextParams, { replace: true });
  };

  const openReview = (attemptId: string) => {
    const currentQuery = searchParams.toString();
    const returnTo = `/mistake-book${currentQuery ? `?${currentQuery}` : ''}`;
    navigate(
      `/mistake-book/${encodeURIComponent(attemptId)}/redo?return_to=${encodeURIComponent(returnTo)}`
    );
  };

  const retryActiveView = () => {
    if (isLibrary) {
      history.reloadMistakes();
    } else {
      review.reloadTasks();
    }
  };

  const archiveHistoryItem = async (attemptId: string) => {
    const archived = await history.handleArchiveMistake(attemptId);
    if (archived) {
      review.reloadTasks();
    }
  };

  const emptyCopy = activeView === 'due'
    ? {
        title: '当前没有已到期任务',
        description: '复习任务到期后会自动显示在这里。',
      }
    : activeView === 'mastered'
      ? {
          title: '还没有验证掌握的错题',
          description: '按计划完成三次正确验证后，错题会进入这里。',
        }
      : {
          title: conceptId ? '该知识点暂无错题记录' : '错题库暂无记录',
          description: '原始作答和错因诊断会完整保留在这里。',
        };

  return (
    <MainLayout>
      <div className="container mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-surface-900 dark:text-surface-100">错题本</h1>
            <p className="mt-2 text-sm text-surface-500 dark:text-surface-400">
              {activeView === 'due'
                ? `当前有 ${review.counts.dueNow} 项已到期复习任务`
                : activeView === 'mastered'
                  ? `已通过真实作答验证 ${review.counts.mastered} 项`
                  : `共 ${history.pagination.total} 条${conceptId ? '当前知识点的' : ''}错题记录`}
            </p>
          </div>
          <Button variant="outline" onClick={() => navigate('/analytics#portrait')}>
            <BarChart3 className="mr-2 h-4 w-4" />
            学习画像
          </Button>
        </div>

        <Tabs
          defaultValue="due"
          value={activeView}
          keepMounted={false}
          onValueChange={handleViewChange}
        >
          <TabsList className="mb-6 grid h-auto w-full grid-cols-3 sm:inline-grid sm:w-auto">
            <TabsTrigger value="due" className="group">
              待复习 <TabCount count={review.counts.dueNow} />
            </TabsTrigger>
            <TabsTrigger value="library" className="group">
              错题库 <TabCount count={history.pagination.total} />
            </TabsTrigger>
            <TabsTrigger value="mastered" className="group">
              已掌握 <TabCount count={review.counts.mastered} />
            </TabsTrigger>
          </TabsList>

          {Array.from(mistakeBookViews).map((view) => (
            <TabsContent key={view} value={view} forceMount className="mt-0 space-y-4">
              {activeView === view ? <>
                {isLibrary && conceptId ? (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-800 dark:border-primary-800 dark:bg-primary-950/30 dark:text-primary-200">
                    <span>当前仅显示从知识图谱选中的知识点</span>
                    <Button variant="ghost" size="sm" onClick={clearConceptFilter}>查看全部</Button>
                  </div>
                ) : null}

                {(activeLoading === 'idle'
                  || activeLoading === 'loading'
                  || (activeLoading === 'success' && !activeRequestResolved)) ? (
                  <div className="flex min-h-48 items-center justify-center gap-3 text-surface-500 dark:text-surface-400">
                    <Loader2 className="h-7 w-7 animate-spin text-primary-500" />
                    <span>{isLibrary ? '正在读取错题记录' : '正在读取复习计划'}</span>
                  </div>
                ) : null}

          {activeLoading === 'error' && activeError ? (
            <Card className="border-red-200 dark:border-red-800">
              <CardContent className="p-8 text-center">
                <AlertCircle className="mx-auto mb-3 h-11 w-11 text-red-500" />
                <p className="text-red-600 dark:text-red-400">{activeError}</p>
                <Button onClick={retryActiveView} variant="outline" className="mt-4">重试</Button>
              </CardContent>
            </Card>
          ) : null}

          {activeRequestReady && activePagination.total === 0 ? (
            <Card>
              <CardContent className="p-10 text-center sm:p-12">
                <CheckCircle className="mx-auto mb-4 h-14 w-14 text-emerald-500" />
                <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-100">
                  {emptyCopy.title}
                </h2>
                <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-surface-500 dark:text-surface-400">
                  {emptyCopy.description}
                </p>
              </CardContent>
            </Card>
          ) : null}

          {activeRequestReady && isLibrary
            ? history.mistakes.map((item) => (
                <MistakeHistoryCard
                  key={item.id}
                  item={item}
                  archiving={history.archivingIds.includes(item.id)}
                  knowledgeLabels={knowledgeLabels}
                  onArchive={(attemptId) => void archiveHistoryItem(attemptId)}
                  onReview={openReview}
                />
              ))
            : null}

          {activeRequestReady && !isLibrary
            ? review.tasks.map((task) => (
                <ReviewTaskCard
                  key={task.id}
                  task={task}
                  view={taskView}
                  knowledgeLabels={knowledgeLabels}
                  onReview={openReview}
                />
              ))
            : null}

          {activeRequestReady && activePagination.totalPages > 1 ? (
            <div className="pt-2">
              <Pagination
                currentPage={activePagination.page}
                totalPages={activePagination.totalPages}
                onPageChange={handlePageChange}
              />
            </div>
          ) : null}
              </> : null}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </MainLayout>
  );
};
