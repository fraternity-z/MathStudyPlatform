import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  Archive,
  ArrowRight,
  BarChart3,
  BookOpen,
  CheckCircle,
  Clock3,
  Eye,
  Info,
  ListFilter,
  History,
  Loader2,
  RotateCcw,
  RefreshCw,
} from 'lucide-react';
import { MainLayout } from '../../components/layout/MainLayout';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Modal';
import { Pagination } from '../../components/ui/Pagination';
import { Progress } from '../../components/ui/Progress';
import { Select, type SelectOption } from '../../components/ui/Select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/Tabs';
import { ExerciseMathContent } from '@/modules/exercise/components/ExerciseMathContent';
import { getApiErrorMessage } from '@/libs/http/apiClient';
import { knowledgeService } from '@/modules/knowledge/services/knowledgeService';
import {
  buildMistakeBookRequestKey,
  getDifficultyBadge,
  getErrorTypeLabel,
  useMistakeBook,
} from '@/modules/mistake/hooks/useMistakeBook';
import {
  buildReviewTaskRequestKey,
  useMistakeReviewTasks,
} from '@/modules/mistake/hooks/useMistakeReviewTasks';
import { fetchMistakeDetail } from '@/modules/mistake/services/mistakeService';
import type {
  MistakeDetail,
  MistakeRecord,
  MistakeExercise,
  MistakeQueryParams,
  ReviewTask,
  ReviewTaskView,
} from '@/modules/mistake/services/mistakeService';

type MistakeBookView = ReviewTaskView | 'library';
type BadgeVariant = 'secondary' | 'success' | 'warning';
type DueStatusFilter = 'all' | 'due' | 'scheduled';
type SortBy = NonNullable<MistakeQueryParams['sortBy']> | 'due_at' | 'mastered_at' | 'stage';
type SortOrder = 'asc' | 'desc';
type SortSelection = `${SortBy}:${SortOrder}`;

const mistakeBookViews = new Set<MistakeBookView>(['due', 'library', 'mastered']);
const masteryTarget = 3;
const dueStatuses = new Set<DueStatusFilter>(['all', 'due', 'scheduled']);
const stageValues = new Set(['all', '0', '1', '2', '3']);
const errorCountValues = new Set(['all', '2', '3', '5']);
const uncategorizedKnowledgePointId = '00000000-0000-0000-0000-000000000001';
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const errorTypeOptions: SelectOption[] = [
  { value: '', label: '全部错误类型' },
  { value: 'conceptual', label: getErrorTypeLabel('conceptual') },
  { value: 'procedural', label: getErrorTypeLabel('procedural') },
  { value: 'logical', label: getErrorTypeLabel('logical') },
  { value: 'symbolic', label: getErrorTypeLabel('symbolic') },
  { value: 'calculation', label: getErrorTypeLabel('calculation') },
];
const sortOptionsByView: Record<MistakeBookView, SelectOption[]> = {
  library: [
    { value: 'time:desc', label: '最近出错' },
    { value: 'time:asc', label: '最早出错' },
    { value: 'error_count:desc', label: '错误次数最多' },
    { value: 'error_count:asc', label: '错误次数最少' },
    { value: 'mastery:asc', label: '掌握度最低' },
    { value: 'mastery:desc', label: '掌握度最高' },
  ],
  mastered: [
    { value: 'mastered_at:desc', label: '最近掌握' },
    { value: 'mastered_at:asc', label: '最早掌握' },
    { value: 'error_count:desc', label: '错误次数最多' },
    { value: 'mastery:asc', label: '掌握度最低' },
    { value: 'stage:desc', label: '验证阶段最高' },
  ],
  due: [
    { value: 'due_at:asc', label: '最早到期' },
    { value: 'due_at:desc', label: '最晚到期' },
    { value: 'error_count:desc', label: '错误次数最多' },
    { value: 'mastery:asc', label: '掌握度最低' },
    { value: 'stage:asc', label: '优先未完成验证' },
  ],
};
const defaultSortSelectionByView: Record<MistakeBookView, SortSelection> = {
  library: 'time:desc',
  mastered: 'mastered_at:desc',
  due: 'due_at:asc',
};

function parsePage(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function parseDueStatus(value: string | null): DueStatusFilter {
  return value && dueStatuses.has(value as DueStatusFilter)
    ? value as DueStatusFilter
    : 'all';
}

function parseStage(value: string | null): number | undefined {
  if (!value || !stageValues.has(value) || value === 'all') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= masteryTarget ? parsed : undefined;
}

function parseErrorCountMin(value: string | null): number | undefined {
  if (!value || !errorCountValues.has(value) || value === 'all') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseSortSelection(
  sortByValue: string | null,
  sortOrderValue: string | null,
  view: MistakeBookView,
): { sortBy: SortBy; sortOrder: SortOrder; value: SortSelection } {
  const requested = `${sortByValue ?? ''}:${sortOrderValue ?? ''}`;
  const fallback = defaultSortSelectionByView[view];
  const selected = sortOptionsByView[view].some((option) => option.value === requested)
    ? requested as SortSelection
    : fallback;
  const [sortBy, sortOrder] = selected.split(':') as [SortBy, SortOrder];
  return { sortBy, sortOrder, value: selected };
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

function formatDateTime(value: string | null): string {
  const date = parseApiTimestamp(value);
  if (!date) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '未记录';
  const wholeSeconds = Math.round(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  if (!minutes) return `${remainder} 秒`;
  return `${minutes} 分 ${remainder} 秒`;
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

function getReviewStageLabel(successfulReviewCount: number, status?: ReviewTask['status'] | null): string {
  const completed = Math.min(Math.max(successfulReviewCount, 0), masteryTarget);
  if (status === 'mastered' || completed >= masteryTarget) return '已完成 7 天验证';
  if (completed === 2) return '下一步：7 天验证';
  if (completed === 1) return '下一步：3 天验证';
  return '下一步：1 天验证';
}

function getNextReviewInterval(successfulReviewCount: number): string {
  if (successfulReviewCount >= 2) return '7 天';
  if (successfulReviewCount === 1) return '3 天';
  return '1 天';
}

function VerificationProgress({
  successfulReviewCount,
  status,
}: {
  successfulReviewCount: number;
  status?: ReviewTask['status'] | null;
}) {
  const completed = Math.min(Math.max(successfulReviewCount, 0), masteryTarget);
  const checkpoints = ['1 天', '3 天', '7 天'];
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-surface-500 dark:text-surface-400">
        <span>验证阶段：{completed}/{masteryTarget}</span>
        <span>{getReviewStageLabel(completed, status)}</span>
      </div>
      <div className="flex items-center gap-1" aria-label={`验证进度 ${completed}/${masteryTarget}`}>
        {checkpoints.map((checkpoint, index) => {
          const done = index < completed;
          const current = index === completed && completed < masteryTarget;
          return (
            <React.Fragment key={checkpoint}>
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full border ${
                    done
                      ? 'border-emerald-500 bg-emerald-500'
                      : current
                        ? 'border-primary-500 bg-primary-100 dark:bg-primary-900'
                        : 'border-surface-300 bg-surface-100 dark:border-surface-600 dark:bg-surface-800'
                  }`}
                  title={`${checkpoint}验证${done ? '已完成' : current ? '待完成' : '未开始'}`}
                />
                <span className={done ? 'text-emerald-600 dark:text-emerald-400' : current ? 'text-primary-600 dark:text-primary-400' : ''}>
                  {checkpoint}
                </span>
              </div>
              {index < checkpoints.length - 1 ? (
                <span className={`h-px min-w-2 flex-1 ${index < completed ? 'bg-emerald-400' : 'bg-surface-200 dark:bg-surface-700'}`} />
              ) : null}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function ReviewPlanSummary({
  dueAt,
  successfulReviewCount,
  status,
  isEarlyPractice = false,
  dailyCorrection = false,
  isDue = false,
  planAvailable = true,
}: {
  dueAt: string | null;
  successfulReviewCount: number;
  status?: ReviewTask['status'] | null;
  isEarlyPractice?: boolean;
  dailyCorrection?: boolean;
  isDue?: boolean;
  planAvailable?: boolean;
}) {
  if (!planAvailable) {
    return (
      <div className="flex items-start gap-1.5 rounded-md border border-surface-200 bg-surface-50 px-3 py-2.5 text-xs leading-5 text-surface-500 dark:border-surface-700 dark:bg-surface-800/60 dark:text-surface-400">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-surface-400" />
        <span>这条记录尚未建立验证计划；重做以 0.35 权重更新掌握度，答错会建立 1 天复习计划。</span>
      </div>
    );
  }
  const mastered = status === 'mastered' || successfulReviewCount >= masteryTarget;
  const dueNow = isDue;
  return (
    <div className="space-y-2 rounded-md border border-surface-200 bg-surface-50 px-3 py-2.5 text-xs dark:border-surface-700 dark:bg-surface-800/60">
      <div className="flex items-center gap-1.5 font-medium text-surface-700 dark:text-surface-200">
        <Info className="h-3.5 w-3.5 text-primary-500" />
        <span>
          {mastered
            ? '复习计划已完成；答对不会重新开启验证，答错会重置为 1 天后复习'
            : dueNow
              ? `${dueAt ? `正式复习已于 ${formatDateTime(dueAt)} 到期` : '正式复习已到期'} · 当前阶段：${getReviewStageLabel(successfulReviewCount, status).replace('下一步：', '')}`
              : dueAt
                ? `下一次正式复习：${formatDateTime(dueAt)} · 间隔 ${getNextReviewInterval(successfulReviewCount)}`
                : `下一次正式复习：${getNextReviewInterval(successfulReviewCount)}后`}
        </span>
      </div>
      <VerificationProgress successfulReviewCount={successfulReviewCount} status={status} />
      {dailyCorrection ? (
        <p className="leading-5 text-surface-500 dark:text-surface-400">
          每日一题即时订正以 0.35 权重更新掌握度；答对会计为首次成功验证并进入 3 天阶段，答错会重置为 1 天后正式复习。
        </p>
      ) : isEarlyPractice ? (
        <p className="leading-5 text-surface-500 dark:text-surface-400">
          提前练习无论答对答错都以 0.35 权重更新掌握度；答对不推进验证阶段，答错会重置为 1 天后正式复习。
        </p>
      ) : mastered ? (
        <p className="leading-5 text-surface-500 dark:text-surface-400">
          已掌握题重做以 0.35 权重更新掌握度；答对保持已掌握，答错会重新建立 1 天复习计划。
        </p>
      ) : dueNow ? (
        <p className="leading-5 text-surface-500 dark:text-surface-400">
          正式复习无论答对答错，均以 1.0 权重更新掌握度；答对会推进当前验证阶段，答错会重置为 1 天后复习。
        </p>
      ) : null}
    </div>
  );
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

function DetailValue({ label, value }: { label: string; value: string | null | undefined }) {
  const normalizedValue = value?.trim() ?? '';
  return (
    <div className="min-w-0 rounded-md border border-surface-200 bg-surface-50 p-3 dark:border-surface-700 dark:bg-surface-800/60">
      <h4 className="mb-2 text-xs font-medium text-surface-500 dark:text-surface-400">{label}</h4>
      {normalizedValue ? (
        <ExerciseMathContent
          value={normalizedValue}
          block
          className="text-sm leading-6 text-surface-800 dark:text-surface-200"
        />
      ) : (
        <p className="text-sm text-surface-400 dark:text-surface-500">暂无记录</p>
      )}
    </div>
  );
}

function DetailSteps({ label, steps }: { label: string; steps: string[] }) {
  const visibleSteps = steps.map((step) => step.trim()).filter(Boolean);
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-surface-800 dark:text-surface-200">{label}</h4>
      {visibleSteps.length ? (
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-surface-700 dark:text-surface-300">
          {visibleSteps.map((step, index) => (
            <li key={`${index}-${step.slice(0, 24)}`}>
              <ExerciseMathContent value={step} block />
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-surface-400 dark:text-surface-500">暂无记录</p>
      )}
    </section>
  );
}

function MistakeDetailDialog({
  attemptId,
  isOpen,
  onClose,
  planSummary,
  knowledgeLabels,
}: {
  attemptId: string;
  isOpen: boolean;
  onClose: () => void;
  planSummary?: React.ReactNode;
  knowledgeLabels: ReadonlyMap<string, string>;
}) {
  const [detail, setDetail] = useState<MistakeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [revealedSolutionAttemptId, setRevealedSolutionAttemptId] = useState<string | null>(null);
  const solutionSectionId = React.useId();

  useEffect(() => {
    if (!isOpen) return;

    let active = true;

    const loadDetail = async () => {
      setLoading(true);
      setError(null);
      setDetail(null);
      try {
        const result = await fetchMistakeDetail(attemptId);
        if (active) setDetail(result);
      } catch (requestError: unknown) {
        if (active) {
          setError(getApiErrorMessage(requestError, '读取错题详情失败，请稍后重试'));
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadDetail();

    return () => {
      active = false;
    };
  }, [attemptId, isOpen, retryKey]);

  const exerciseContent = detail?.exercise.content?.trim() ?? '';
  const exerciseKnowledgePoints = detail?.exercise.knowledgePoints ?? [];
  const exerciseHints = detail?.exercise.hints ?? [];
  const studentSteps = detail?.attempt.studentSteps ?? [];
  const relatedConcepts = detail?.diagnosis.relatedConcepts ?? [];
  const solutionAnswer = detail?.solution.answer?.trim() ?? '';
  const referenceAnswer = detail?.attempt.correctAnswer?.trim() || solutionAnswer;
  const solutionSteps = detail?.solution.steps ?? [];
  const history = detail?.history ?? [];
  const solutionVisible = revealedSolutionAttemptId === attemptId;

  const handleClose = () => {
    setRevealedSolutionAttemptId(null);
    onClose();
  };

  const detailHeaderContent = detail ? (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Badge variant="outline" className="max-w-full truncate text-xs">
        {detail.exercise.title || '错题'}
      </Badge>
      <Badge variant={getDifficultyBadge(detail.exercise.difficulty).variant} className="text-xs">
        {getDifficultyBadge(detail.exercise.difficulty).label}
      </Badge>
      {detail.diagnosis.errorType ? (
        <Badge variant="secondary" className="text-xs">
          {getErrorTypeLabel(detail.diagnosis.errorType)}
        </Badge>
      ) : null}
    </div>
  ) : null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="错题详情"
      stickyHeader
      stickyHeaderContent={detailHeaderContent}
      className="max-h-[calc(100vh-2rem)] max-w-3xl rounded-md p-5 sm:p-6"
    >
      {loading ? (
        <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-surface-500 dark:text-surface-400">
          <Loader2 className="h-5 w-5 animate-spin text-primary-500" />
          正在加载错题详情
        </div>
      ) : error ? (
        <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
          <AlertCircle className="h-9 w-9 text-red-500" />
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetryKey((current) => current + 1)}
          >
            重试
          </Button>
        </div>
      ) : detail ? (
        <div className="space-y-5">
          <div className="space-y-3">
            <section className="space-y-2">
              <h4 className="text-sm font-semibold text-surface-800 dark:text-surface-200">题目</h4>
              <div className="rounded-md border border-surface-200 bg-surface-50 p-4 dark:border-surface-700 dark:bg-surface-800/60">
                {exerciseContent ? (
                  <ExerciseMathContent
                    value={detail.exercise.content}
                    block
                    className="text-base leading-7 text-surface-900 dark:text-surface-100"
                  />
                ) : (
                  <p className="text-sm text-surface-400 dark:text-surface-500">题目内容暂缺</p>
                )}
              </div>
            </section>
            {exerciseKnowledgePoints.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-medium text-surface-500 dark:text-surface-400">知识点</span>
                {exerciseKnowledgePoints.map((concept) => (
                  <Badge key={concept} variant="outline" className="text-xs">
                    {knowledgeLabels.get(concept) || concept}
                  </Badge>
                ))}
              </div>
            ) : null}
            {exerciseHints.length ? <DetailSteps label="题目提示" steps={exerciseHints} /> : null}
          </div>

          <section className="space-y-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={solutionVisible}
              aria-controls={solutionSectionId}
              onClick={() => setRevealedSolutionAttemptId((current) => (
                current === attemptId ? null : attemptId
              ))}
            >
              <BookOpen className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {solutionVisible ? '收起参考解析' : '查看参考解析'}
            </Button>
            {solutionVisible ? (
              <div
                id={solutionSectionId}
                className="space-y-3 rounded-md border border-surface-200 bg-surface-50 p-4 dark:border-surface-700 dark:bg-surface-800/60"
              >
                <h4 className="text-sm font-semibold text-surface-800 dark:text-surface-200">参考解析</h4>
                <DetailValue label="参考答案" value={referenceAnswer} />
                {solutionSteps.length ? (
                  <DetailSteps label="解析步骤" steps={solutionSteps} />
                ) : (
                  <p className="text-sm text-surface-400 dark:text-surface-500">
                    {referenceAnswer ? '暂无可用解析步骤' : '暂无可用参考答案或解析'}
                  </p>
                )}
                {detail.solution.source && detail.solution.source !== 'unavailable' ? (
                  <p className="text-xs text-surface-500 dark:text-surface-400">
                    解析来源：{detail.solution.source}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>

          <div className="grid gap-3">
            <DetailValue label="你的作答" value={detail.attempt.studentAnswer} />
          </div>

          {studentSteps.length ? (
            <DetailSteps label="你的解题步骤" steps={studentSteps} />
          ) : null}

          <section className="space-y-3 rounded-md border border-primary-100 bg-primary-50/70 p-4 dark:border-primary-900/60 dark:bg-primary-950/20">
            <h4 className="text-sm font-semibold text-surface-800 dark:text-surface-200">错误诊断</h4>
            <DetailValue label="原因说明" value={detail.diagnosis.explanation} />
            <DetailValue label="改进建议" value={detail.diagnosis.suggestion} />
            {detail.diagnosis.errorStepIndex != null ? (
              <p className="text-xs text-surface-500 dark:text-surface-400">
                重点错误步骤：第 {detail.diagnosis.errorStepIndex + 1} 步
              </p>
            ) : null}
            {relatedConcepts.length ? (
              <div className="flex flex-wrap gap-1.5">
                {relatedConcepts.map((concept) => (
                  <Badge key={concept} variant="outline" className="text-xs">
                    {knowledgeLabels.get(concept) || concept}
                  </Badge>
                ))}
              </div>
            ) : null}
          </section>

          {planSummary ? (
            <section className="space-y-2">
              <h4 className="text-sm font-semibold text-surface-800 dark:text-surface-200">复习计划</h4>
              {planSummary}
            </section>
          ) : null}

          <section className="space-y-3">
            <h4 className="text-sm font-semibold text-surface-800 dark:text-surface-200">作答记录</h4>
            <div className="grid gap-2 text-sm text-surface-600 dark:text-surface-300">
              <p>本次作答：{formatDateTime(detail.attempt.submittedAt)} · 用时 {formatDuration(detail.attempt.timeSpentSeconds)}</p>
              {history.length ? history.map((entry) => (
                <div
                  key={entry.attemptId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-surface-200 px-3 py-2 dark:border-surface-700"
                >
                  <span>{formatDateTime(entry.submittedAt)} · {entry.isCorrect ? '答对' : '答错'}</span>
                  <span className={entry.isCorrect ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                    得分 {entry.score}
                  </span>
                </div>
              )) : (
                <p className="text-surface-400 dark:text-surface-500">暂无其他作答记录</p>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </Modal>
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
  const [detailOpen, setDetailOpen] = useState(false);
  const difficulty = getDifficultyBadge(task.exercise.difficulty);
  const due = getDuePresentation(task);
  const reviewAvailable = task.canReview && Boolean(task.sourceAttemptId.trim());
  const detailAvailable = Boolean(task.sourceAttemptId.trim());
  const actionLabel = view === 'mastered'
    ? '再次练习'
    : '开始复习';

  return (
    <>
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
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  disabled={!detailAvailable}
                  title={detailAvailable ? '查看错题详情' : '详情暂不可用'}
                  aria-label="查看错题详情"
                  onClick={() => setDetailOpen(true)}
                >
                  <Eye className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  disabled={!reviewAvailable}
                  onClick={() => onReview(task.sourceAttemptId)}
                  title={due.title}
                >
                  {reviewAvailable ? actionLabel : '暂不可用'}
                  {reviewAvailable ? <ArrowRight className="ml-1.5 h-4 w-4" /> : <Clock3 className="ml-1.5 h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      <MistakeDetailDialog
        attemptId={task.sourceAttemptId}
        isOpen={detailOpen}
        onClose={() => setDetailOpen(false)}
        knowledgeLabels={knowledgeLabels}
        planSummary={(
          <ReviewPlanSummary
            dueAt={task.dueAt}
            successfulReviewCount={task.successfulReviewCount}
            status={task.status}
            isDue={task.isDue}
            planAvailable
          />
        )}
      />
    </>
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
  const [detailOpen, setDetailOpen] = useState(false);
  const difficulty = getDifficultyBadge(item.exercise.difficulty);

  return (
    <>
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
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  title="查看错题详情"
                  aria-label="查看错题详情"
                  onClick={() => setDetailOpen(true)}
                >
                  <Eye className="h-4 w-4" />
                </Button>
                {item.canArchive ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={archiving}
                    onClick={() => onArchive(item.id)}
                  >
                    {archiving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Archive className="mr-1.5 h-4 w-4" />}
                    归档
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  disabled={!item.canReview}
                  onClick={() => onReview(item.id)}
                >
                  {item.canReview
                    ? item.dailyCorrection
                      ? '即时订正'
                      : item.isEarlyPractice
                        ? '提前练习'
                        : '重做'
                    : '暂不可用'}
                  {item.canReview
                    ? <ArrowRight className="ml-1.5 h-4 w-4" />
                    : <Clock3 className="ml-1.5 h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      <MistakeDetailDialog
        attemptId={item.id}
        isOpen={detailOpen}
        onClose={() => setDetailOpen(false)}
        knowledgeLabels={knowledgeLabels}
        planSummary={(
          <ReviewPlanSummary
            dueAt={item.reviewDueAt ?? null}
            successfulReviewCount={item.successfulReviewCount ?? 0}
            status={item.reviewStatus === 'pending' || item.reviewStatus === 'verification_due' || item.reviewStatus === 'mastered'
              ? item.reviewStatus
              : null}
            isEarlyPractice={item.isEarlyPractice}
            dailyCorrection={item.dailyCorrection}
            isDue={item.reviewIsDue}
            planAvailable={Boolean(item.reviewTaskId)}
          />
        )}
      />
    </>
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeView = parseMistakeBookView(searchParams.get('view'));
  const conceptId = searchParams.get('concept_id')?.trim() || undefined;
  const errorType = searchParams.get('error_type')?.trim() || undefined;
  const dueStatus = parseDueStatus(searchParams.get('due_status'));
  const stage = parseStage(searchParams.get('stage'));
  const errorCountMin = parseErrorCountMin(searchParams.get('error_count_min'));
  const sortSelection = parseSortSelection(
    searchParams.get('sort_by'),
    searchParams.get('sort_order'),
    activeView,
  );
  const { sortBy, sortOrder } = sortSelection;
  const duePage = parsePage(searchParams.get(getPageParam('due')));
  const libraryPage = parsePage(searchParams.get(getPageParam('library')));
  const masteredPage = parsePage(searchParams.get(getPageParam('mastered')));
  const taskView: ReviewTaskView = activeView === 'mastered' ? 'mastered' : 'due';
  const historyFilters = {
    conceptId,
    errorType,
    dueStatus,
    stage,
    errorCountMin,
    sortBy: sortBy === 'time' || sortBy === 'error_count' || sortBy === 'mastery' ? sortBy : 'time',
    sortOrder,
  } as const;
  const reviewSortBy = sortBy === 'time' ? 'due_at' : sortBy;
  const reviewFilters = {
    conceptId,
    errorType,
    dueStatus: activeView === 'mastered' ? 'all' : activeView === 'due' ? 'due' : dueStatus,
    stage,
    errorCountMin,
    sortBy: reviewSortBy === 'due_at' || reviewSortBy === 'mastered_at' || reviewSortBy === 'error_count' || reviewSortBy === 'mastery' || reviewSortBy === 'stage'
      ? reviewSortBy
      : 'due_at',
    sortOrder,
  } as const;
  const history = useMistakeBook(historyFilters, libraryPage);
  const review = useMistakeReviewTasks(taskView, reviewFilters, taskView === 'due' ? duePage : masteredPage);
  const [knowledgeLabels, setKnowledgeLabels] = useState<ReadonlyMap<string, string>>(new Map());
  const isLibrary = activeView === 'library';
  const activeLoading = isLibrary ? history.mistakesLoading : review.tasksLoading;
  const activeError = isLibrary ? history.mistakesError : review.tasksError;
  const activePagination = isLibrary ? history.pagination : review.pagination;
  const activeResolvedRequestKey = isLibrary
    ? history.resolvedRequestKey
    : review.resolvedRequestKey;
  const expectedRequestKey = isLibrary
    ? buildMistakeBookRequestKey(historyFilters, libraryPage)
    : buildReviewTaskRequestKey(taskView, reviewFilters, taskView === 'due' ? duePage : masteredPage);
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

  const knowledgeOptions = useMemo<SelectOption[]>(() => {
    const options = Array.from(knowledgeLabels.entries())
      .filter(([id]) => id !== uncategorizedKnowledgePointId)
      .map(([id, label]) => ({ value: id, label: label || '未命名知识点' }))
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
    options.unshift({ value: uncategorizedKnowledgePointId, label: '未分类' });
    if (conceptId && !options.some((option) => option.value === conceptId)) {
      options.push({ value: conceptId, label: formatKnowledgePointLabel({
        id: '',
        title: '',
        content: '',
        difficulty: 0,
        knowledgePoints: [conceptId],
        knowledgePointNames: [],
      }, knowledgeLabels) });
    }
    return [{ value: '', label: '全部知识点' }, ...options];
  }, [conceptId, knowledgeLabels]);

  const statusOptions: SelectOption[] = activeView === 'library'
    ? [
        { value: 'all', label: '全部计划状态' },
        { value: 'due', label: '已到期' },
        { value: 'scheduled', label: '计划中' },
      ]
    : activeView === 'due'
      ? [{ value: 'due', label: '已到期（当前视图）' }]
      : [{ value: 'all', label: '已掌握（当前视图）' }];

  const stageOptions: SelectOption[] = [
    { value: 'all', label: '全部验证阶段' },
    { value: '0', label: '待完成 1 天验证' },
    { value: '1', label: '待完成 3 天验证' },
    { value: '2', label: '待完成 7 天验证' },
    { value: '3', label: '已完成验证' },
  ];

  const errorCountOptions: SelectOption[] = [
    { value: 'all', label: '全部错误次数' },
    { value: '2', label: '错误至少 2 次' },
    { value: '3', label: '反复出错（≥3 次）' },
    { value: '5', label: '高频错误（≥5 次）' },
  ];

  const sortOptions = sortOptionsByView[activeView];

  const updateFilter = (key: string, value: string) => {
    const nextParams = new URLSearchParams(searchParams);
    if (value && value !== 'all') nextParams.set(key, value);
    else nextParams.delete(key);
    nextParams.delete(getPageParam(activeView));
    setSearchParams(nextParams, { replace: true });
  };

  const handleSortChange = (value: string) => {
    if (!sortOptions.some((option) => option.value === value)) return;
    const [nextSortBy, nextSortOrder] = value.split(':');
    if (!nextSortBy || !nextSortOrder) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('sort_by', nextSortBy);
    nextParams.set('sort_order', nextSortOrder === 'asc' ? 'asc' : 'desc');
    nextParams.delete(getPageParam(activeView));
    setSearchParams(nextParams, { replace: true });
  };

  const clearAllFilters = () => {
    const nextParams = new URLSearchParams(searchParams);
    ['concept_id', 'error_type', 'due_status', 'stage', 'error_count_min', 'sort_by', 'sort_order']
      .forEach((key) => nextParams.delete(key));
    nextParams.delete(getPageParam(activeView));
    setSearchParams(nextParams, { replace: true });
  };

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
    if (nextView !== 'library') nextParams.delete('due_status');
    nextParams.delete('sort_by');
    nextParams.delete('sort_order');
    nextParams.delete(getPageParam(nextView));
    setSearchParams(nextParams, { replace: true });
  };

  const clearConceptFilter = () => {
    updateFilter('concept_id', '');
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
  const selectedDueStatus = activeView === 'due' ? 'due' : activeView === 'mastered' ? 'all' : dueStatus;
  const selectedStage = stage === undefined ? 'all' : String(stage);
  const selectedErrorCount = errorCountMin === undefined ? 'all' : String(errorCountMin);
  const selectedSort = sortSelection.value;
  const hasActiveFilters = Boolean(
    conceptId
    || errorType
    || (activeView === 'library' && dueStatus !== 'all')
    || stage !== undefined
    || errorCountMin !== undefined
  );
  const hasNonDefaultSort = selectedSort !== defaultSortSelectionByView[activeView];
  const activeControlCount = [
    Boolean(conceptId),
    Boolean(errorType),
    activeView === 'library' && dueStatus !== 'all',
    stage !== undefined,
    errorCountMin !== undefined,
    hasNonDefaultSort,
  ].filter(Boolean).length;

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
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <TabsList className="grid h-auto w-full grid-cols-3 sm:inline-grid sm:w-auto">
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
            <Button
              variant="outline"
              className="w-full justify-center sm:w-auto"
              onClick={() => setFiltersOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={filtersOpen}
            >
              <ListFilter className="mr-2 h-4 w-4" />
              筛选
              {activeControlCount > 0 ? (
                <span className="ml-2 min-w-5 rounded-full bg-primary-100 px-1.5 py-0.5 text-xs leading-none text-primary-700 dark:bg-primary-900 dark:text-primary-300">
                  {activeControlCount}
                </span>
              ) : null}
            </Button>
          </div>

          <Modal
            isOpen={filtersOpen}
            onClose={() => setFiltersOpen(false)}
            title="筛选与排序"
            className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto rounded-md p-5 sm:p-6"
          >
            <div className="relative z-10 grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-xs font-medium text-surface-600 dark:text-surface-300">
                <span>知识点</span>
                <Select
                  aria-label="按知识点筛选"
                  options={knowledgeOptions}
                  value={conceptId ?? ''}
                  onChange={(value) => updateFilter('concept_id', value)}
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium text-surface-600 dark:text-surface-300">
                <span>错误类型</span>
                <Select
                  aria-label="按错误类型筛选"
                  options={errorTypeOptions}
                  value={errorType ?? ''}
                  onChange={(value) => updateFilter('error_type', value)}
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium text-surface-600 dark:text-surface-300">
                <span>到期状态</span>
                <Select
                  aria-label="按到期状态筛选"
                  options={statusOptions}
                  value={selectedDueStatus}
                  onChange={(value) => updateFilter('due_status', value)}
                  disabled={activeView !== 'library'}
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium text-surface-600 dark:text-surface-300">
                <span>验证阶段</span>
                <Select
                  aria-label="按掌握阶段筛选"
                  options={stageOptions}
                  value={selectedStage}
                  onChange={(value) => updateFilter('stage', value)}
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium text-surface-600 dark:text-surface-300">
                <span>错误次数</span>
                <Select
                  aria-label="按错误次数筛选"
                  options={errorCountOptions}
                  value={selectedErrorCount}
                  onChange={(value) => updateFilter('error_count_min', value)}
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium text-surface-600 dark:text-surface-300">
                <span>排序</span>
                <Select
                  aria-label="错题排序方式"
                  options={sortOptions}
                  value={selectedSort}
                  onChange={handleSortChange}
                />
              </label>
            </div>
            <div className="relative z-10 mt-6 flex flex-col-reverse gap-2 border-t border-surface-200 pt-4 sm:flex-row sm:items-center sm:justify-between dark:border-surface-700">
              <Button
                variant="ghost"
                onClick={clearAllFilters}
                disabled={!hasActiveFilters && !hasNonDefaultSort}
                title="清除筛选与排序"
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                重置
              </Button>
              <Button onClick={() => setFiltersOpen(false)}>查看结果</Button>
            </div>
          </Modal>

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
