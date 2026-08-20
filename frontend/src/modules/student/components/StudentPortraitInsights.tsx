import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BookOpenCheck,
  ChevronDown,
  ChevronUp,
  Clock,
  RefreshCw,
  Sparkles,
  Target,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { MarkdownContent } from '@/components/chat/MarkdownContent';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { isRequestCancelled, toAppError } from '@/libs/http/apiClient';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/appError';
import { useAppDispatch, useAppSelector } from '@/store';
import { clearPortrait, fetchPortrait, generatePortrait } from '@/modules/student/store/studentPortraitSlice';
import { studentPortraitService } from '@/modules/student/services/studentPortraitService';
import type {
  PortraitInsightMetric,
  PortraitInsightTopic,
  PortraitInsightAction,
  PortraitInsights,
  PortraitRangeType,
} from '@/modules/student/types/studentPortrait';

type Props = {
  range: PortraitRangeType;
  insights: PortraitInsights | null;
  loading: boolean;
  error: AppError | null;
  onRetry: () => void;
};

const RANGE_LABELS: Record<PortraitInsights['range']['type'], string> = {
  week: '本周',
  month: '本月',
  semester: '本学期',
  all: '近一年',
};

function metricValue(metric: PortraitInsightMetric): string {
  if (metric.key === 'accuracy') return `${metric.personal_value.toFixed(1)}%`;
  return `${Number(metric.personal_value.toFixed(1))}${metric.unit}`;
}

function comparisonText(metric: PortraitInsightMetric): string {
  if (!metric.available || metric.exceeded_percent == null) {
    return metric.unavailable_reason ?? '暂不提供班级比较';
  }
  return metric.comparison_basis === 'eligible_sample'
    ? `超过有效样本中 ${metric.exceeded_percent.toFixed(0)}% 的同学`
    : `超过班级 ${metric.exceeded_percent.toFixed(0)}% 的同学`;
}

function TopicCard({ topic, tone }: { topic: PortraitInsightTopic; tone: 'success' | 'warning' }) {
  const personal = Math.round(topic.mastery * 100);
  const classAverage = topic.class_average == null ? null : Math.round(topic.class_average * 100);
  const barColor = tone === 'success' ? 'bg-emerald-500' : 'bg-amber-500';
  return (
    <div className="rounded-lg border border-surface-200 p-4 dark:border-surface-700">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-surface-900 dark:text-surface-100">{topic.name}</p>
          <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
            {topic.attempt_count} 次练习 · 置信度 {Math.round(topic.confidence * 100)}%
          </p>
        </div>
        <span className="text-lg font-semibold text-surface-900 dark:text-surface-100">{personal}%</span>
      </div>
      <div className="space-y-2 text-xs">
        <div className="grid grid-cols-[3rem_1fr_2.5rem] items-center gap-2">
          <span className="text-surface-500">个人</span>
          <div className="h-2 overflow-hidden rounded-full bg-surface-100 dark:bg-surface-800">
            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${personal}%` }} />
          </div>
          <span className="text-right text-surface-600 dark:text-surface-300">{personal}%</span>
        </div>
        <div className="grid grid-cols-[3rem_1fr_2.5rem] items-center gap-2">
          <span className="text-surface-500">{topic.comparison_basis === 'eligible_sample' ? '样本' : '班级'}</span>
          <div className="h-2 overflow-hidden rounded-full bg-surface-100 dark:bg-surface-800">
            {classAverage != null && (
              <div className="h-full rounded-full bg-surface-400" style={{ width: `${classAverage}%` }} />
            )}
          </div>
          <span className="text-right text-surface-600 dark:text-surface-300">
            {classAverage == null ? '—' : `${classAverage}%`}
          </span>
        </div>
      </div>
      <p className="mt-3 text-xs text-surface-500 dark:text-surface-400">
        {!topic.available || topic.exceeded_percent == null
          ? topic.unavailable_reason ?? '暂不提供班级比较'
          : `超过有效样本中 ${topic.exceeded_percent.toFixed(0)}% 的同学`}
      </p>
    </div>
  );
}

export function StudentPortraitInsights({ range, insights, loading, error, onRetry }: Props) {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [reportExpanded, setReportExpanded] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [startingConceptId, setStartingConceptId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const { portrait, loadingState, generating, clearing, error: aiError } = useAppSelector((state) => state.studentPortrait);

  useEffect(() => {
    if (loadingState === 'idle') void dispatch(fetchPortrait());
  }, [dispatch, loadingState]);

  const summary = useMemo(() => {
    if (!insights) return '';
    const accuracy = insights.metrics.find((metric) => metric.key === 'accuracy');
    const parts: string[] = [];
    if (accuracy?.available && accuracy.exceeded_percent != null) {
      parts.push(`正确率超过有效样本中${accuracy.exceeded_percent.toFixed(0)}%的同学`);
    }
    if (insights.strengths[0]) parts.push(`${insights.strengths[0].name}是当前优势项`);
    if (insights.improvements[0]) parts.push(`下一阶段优先巩固${insights.improvements[0].name}`);
    return parts.length > 0 ? `${parts.join('，')}。` : '继续积累有效练习后，这里会形成更稳定的画像结论。';
  }, [insights]);

  const goToAction = async (action: PortraitInsightAction) => {
    if (action.type === 'practice' && action.concept_id) {
      if (action.status !== 'in_progress') {
        setStartingConceptId(action.concept_id);
        setActionError(null);
        try {
          await studentPortraitService.startAction(action.concept_id);
        } catch (error) {
          if (!isRequestCancelled(error)) {
            setActionError(toAppError(error, action.status === 'completed' ? '重新开始行动失败，请稍后重试' : '开始行动失败，请稍后重试'));
          }
          setStartingConceptId(null);
          return;
        }
        setStartingConceptId(null);
      }
      navigate(`/exercise?mode=ai&concept_id=${encodeURIComponent(action.concept_id)}&autostart=1`);
      return;
    }
    navigate(action.concept_id
      ? `/mistake-book?view=library&concept_id=${encodeURIComponent(action.concept_id)}`
      : '/mistake-book?view=library');
  };

  const updateAIReport = async () => {
    const action = await dispatch(generatePortrait(range));
    if (generatePortrait.fulfilled.match(action)) {
      setReportExpanded(true);
    }
  };

  const confirmClearAIReport = async () => {
    const action = await dispatch(clearPortrait());
    setClearConfirmOpen(false);
    if (clearPortrait.fulfilled.match(action)) {
      setReportExpanded(false);
    }
  };

  const reportRangeMismatch = Boolean(
    portrait?.has_content && portrait.portrait_range !== range
  );

  return (
    <section id="portrait" className="scroll-mt-24 space-y-6 border-t border-surface-200 pt-10 dark:border-surface-700">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary-500" />
            <h2 className="text-2xl font-bold text-surface-900 dark:text-surface-100">我的学习画像</h2>
          </div>
          <p className="text-sm text-surface-500 dark:text-surface-400">
            将学习数据转化为优势、薄弱点和下一步行动
          </p>
        </div>
        {!loading && !error && insights && insights.range.type === range && (
          <p className="flex items-center gap-1 text-xs text-surface-400 dark:text-surface-500">
            <Clock className="h-3.5 w-3.5" />
            {RANGE_LABELS[insights.range.type]}数据 · 更新于 {new Date(insights.data_updated_at).toLocaleString('zh-CN')}
          </p>
        )}
      </div>

      {loading ? (
        <Card><CardContent className="p-10 text-center text-surface-500">正在分析学习画像…</CardContent></Card>
      ) : error ? (
        <Card>
          <CardContent className="p-6">
            <RequestErrorNotice error={error} onRetry={onRetry} onRefresh={onRetry} />
          </CardContent>
        </Card>
      ) : insights ? (
        <>
          <Card className="border-primary-200 bg-primary-50/50 dark:border-primary-800 dark:bg-primary-950/20">
            <CardContent className="p-6">
              <div className="flex items-start gap-4">
                <div className="rounded-xl bg-primary-100 p-3 dark:bg-primary-900/40">
                  <TrendingUp className="h-6 w-6 text-primary-600 dark:text-primary-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-primary-700 dark:text-primary-300">{RANGE_LABELS[insights.range.type]}画像总结</p>
                  <p className="mt-2 text-base leading-7 text-surface-800 dark:text-surface-200">{summary}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {insights.strengths.slice(0, 2).map((topic) => <Badge key={topic.concept_id} variant="success">{topic.name}表现较好</Badge>)}
                    {insights.improvements.slice(0, 2).map((topic) => <Badge key={topic.concept_id} variant="warning">{topic.name}需要巩固</Badge>)}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {insights.metrics.map((metric) => (
              <Card key={metric.key}>
                <CardContent className="p-5">
                  <p className="text-sm text-surface-500 dark:text-surface-400">{metric.label}</p>
                  <p className="mt-2 text-2xl font-bold text-surface-900 dark:text-surface-100">{metricValue(metric)}</p>
                  {metric.comparison_value != null && (
                    <p className="mt-1 text-xs text-surface-400">
                      课程题个人 {Number(metric.comparison_value.toFixed(1))}{metric.unit}
                      {metric.class_average != null && ` · ${metric.comparison_basis === 'eligible_sample' ? '有效样本' : '其他同学'}平均 ${Number(metric.class_average.toFixed(1))}${metric.unit}`}
                    </p>
                  )}
                  <p className={`mt-3 text-xs ${metric.available ? 'text-emerald-600 dark:text-emerald-400' : 'text-surface-400'}`}>
                    {comparisonText(metric)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg"><TrendingUp className="h-5 w-5 text-emerald-500" />优势知识点</CardTitle>
                <CardDescription>当前掌握度较高的知识点</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {insights.strengths.length > 0
                  ? insights.strengths.map((topic) => <TopicCard key={topic.concept_id} topic={topic} tone="success" />)
                  : <p className="py-6 text-center text-sm text-surface-500">继续练习后将识别优势知识点</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg"><Target className="h-5 w-5 text-amber-500" />优先提升</CardTitle>
                <CardDescription>建议下一阶段重点巩固的知识点</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {insights.improvements.length > 0
                  ? insights.improvements.map((topic) => <TopicCard key={topic.concept_id} topic={topic} tone="warning" />)
                  : <p className="py-6 text-center text-sm text-surface-500">当前没有明显薄弱知识点</p>}
              </CardContent>
            </Card>
          </div>

          {insights.observations.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">数据积累中</CardTitle>
                <CardDescription>这些知识点的练习次数或模型置信度尚不足，暂不判定为优势或薄弱项</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {insights.observations.map((topic) => (
                  <Badge key={topic.concept_id} variant="default">
                    {topic.name} · {topic.attempt_count} 次 · 置信度 {Math.round(topic.confidence * 100)}%
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg"><BookOpenCheck className="h-5 w-5 text-primary-500" />下一步行动</CardTitle>
              <CardDescription>从画像直接进入练习和复盘</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              {insights.actions.map((action, index) => (
                <button
                  key={`${action.type}-${action.concept_id ?? index}`}
                  className="group rounded-lg border border-surface-200 p-4 text-left transition-colors hover:border-primary-300 hover:bg-primary-50 dark:border-surface-700 dark:hover:border-primary-700 dark:hover:bg-primary-950/30"
                  disabled={action.concept_id !== null && startingConceptId === action.concept_id}
                  onClick={() => void goToAction(action)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium text-surface-900 dark:text-surface-100">{action.title}</p>
                    <ArrowRight className="h-4 w-4 shrink-0 text-surface-400 group-hover:text-primary-500" />
                  </div>
                  <p className="mt-2 text-sm leading-6 text-surface-500 dark:text-surface-400">{action.description}</p>
                  {action.target_count > 0 && (
                    <>
                      <div className="mt-3 flex items-center justify-between text-xs text-surface-400">
                        <span>{action.completed_count}/{action.target_count} 题</span>
                        <span className={action.status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : ''}>
                          {startingConceptId === action.concept_id
                            ? '正在开始'
                            : action.status === 'completed'
                              ? '已完成，可再练'
                              : action.status === 'not_started'
                                ? '尚未开始'
                                : '进行中'}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-100 dark:bg-surface-800">
                        <div
                          className="h-full rounded-full bg-primary-500"
                          style={{ width: `${Math.min(100, action.completed_count / action.target_count * 100)}%` }}
                        />
                      </div>
                    </>
                  )}
                </button>
              ))}
            </CardContent>
            {actionError ? (
              <CardContent className="pt-0">
                <RequestErrorNotice
                  error={actionError}
                  onRetry={() => void onRetry()}
                  onRefresh={() => void onRetry()}
                />
              </CardContent>
            ) : null}
          </Card>

          <p className="text-center text-xs text-surface-400 dark:text-surface-500">
            练习量、时长和活跃天数对比全班其他同学；正确率只比较至少完成10道课程题的有效样本，知识点比较使用至少5次练习且置信度达到30%的当前掌握状态。
            {insights.class_context.in_class && ` 当前班级 ${insights.class_context.class_size} 人，本范围活跃 ${insights.class_context.active_students} 人。`}
          </p>
        </>
      ) : null}

      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-lg">AI详细解读</CardTitle>
            <CardDescription className="mt-1">AI只解释已有数据，图表和比较不依赖AI生成</CardDescription>
            {portrait?.has_content && portrait.portrait_generated_at && (
              <p className="mt-2 text-xs text-surface-400">
                {portrait.portrait_range ? RANGE_LABELS[portrait.portrait_range] : '历史'}报告
                {portrait.portrait_snapshot_at && ` · 行为数据截至 ${new Date(portrait.portrait_snapshot_at).toLocaleString('zh-CN')}`}
                {' · '}生成于 {new Date(portrait.portrait_generated_at).toLocaleString('zh-CN')}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              isLoading={generating}
              disabled={loadingState !== 'success' || clearing}
              onClick={() => void updateAIReport()}
            >
              <RefreshCw className="mr-1 h-4 w-4" />
              {portrait?.has_content ? '更新解读' : '生成解读'}
            </Button>
            {portrait?.has_content && (
              <Button size="sm" variant="ghost" disabled={clearing || generating} onClick={() => setClearConfirmOpen(true)}>
                <Trash2 className="mr-1 h-4 w-4" />删除
              </Button>
            )}
            {portrait?.has_content && (
              <Button size="sm" variant="ghost" onClick={() => setReportExpanded((value) => !value)}>
                {reportExpanded ? <ChevronUp className="mr-1 h-4 w-4" /> : <ChevronDown className="mr-1 h-4 w-4" />}
                {reportExpanded ? '收起' : '查看'}
              </Button>
            )}
          </div>
        </CardHeader>
        {reportRangeMismatch && (
          <CardContent className="pb-0">
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
              当前解读不是{RANGE_LABELS[range]}数据，请更新后再作为本范围结论参考。
            </p>
          </CardContent>
        )}
        {reportExpanded && portrait?.portrait_content && (
          <CardContent>
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <MarkdownContent content={portrait.portrait_content} unwrapOuterFence />
            </div>
          </CardContent>
        )}
        {aiError && (
          <CardContent>
            <RequestErrorNotice
              error={aiError}
              onRetry={() => void dispatch(fetchPortrait())}
              onRefresh={() => void dispatch(fetchPortrait())}
            />
          </CardContent>
        )}
      </Card>

      <ConfirmDialog
        isOpen={clearConfirmOpen}
        onClose={() => setClearConfirmOpen(false)}
        onConfirm={() => void confirmClearAIReport()}
        loading={clearing}
        title="删除 AI 详细解读"
        message="仅删除已生成的 AI 文本，不会删除学习记录、统计图表或结构化画像。"
        confirmText="删除解读"
      />
    </section>
  );
}
