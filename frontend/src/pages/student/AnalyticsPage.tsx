import React, { useEffect, useMemo, useState } from 'react';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { BarChart, PieChart as EchartsPieChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

echarts.use([BarChart, EchartsPieChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);
import { MainLayout } from '../../components/layout/MainLayout';
import { withErrorBoundary } from '../../components/withErrorBoundary';
import { RequestErrorNotice } from '@/components/feedback';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Progress } from '../../components/ui/Progress';
import { Select } from '../../components/ui/Select';
import { apiClient, toAppError, type AppError } from '@/libs/http/apiClient';
import { StudentPortraitInsights } from '@/modules/student/components/StudentPortraitInsights';
import { studentPortraitService } from '@/modules/student/services/studentPortraitService';
import type { PortraitInsights, PortraitRangeType } from '@/modules/student/types/studentPortrait';
import {
  Clock,
  BookOpen,
  Target,
  Flame,
  BarChart3,
  PieChart,
  Activity
} from 'lucide-react';

type OverviewResponse = {
  total_exercises: number;
  correct_count: number;
  correct_rate: number;
  study_time_minutes: number;
  streak_days: number;
  mastered_concepts: number;
};

type DailyStat = {
  date: string;
  exercises: number;
  correct_exercises: number;
  study_minutes: number;
};

type StatisticsResponse = {
  range_days: number;
  interval?: 'day' | 'week';
  start_date: string;
  end_date: string;
  daily: DailyStat[];
  error_type_distribution: Record<string, { count: number; percentage: number }>;
};

type MasteryTopic = { topic: string; mastery: number; exercises: number; confidence: number };

type MasteryResponse = { topics: MasteryTopic[]; model: string };

type ClassRankingResponse = {
  in_class: boolean;
  available: boolean;
  unavailable_reason?: string;
  rank: number | null;
  total: number;
  percentile: number | null;
};

const timeRangeOptions = [
  { value: 'week', label: '当前周' },
  { value: 'month', label: '当前月' },
  { value: 'semester', label: '当前学期' },
  { value: 'all', label: '近一年' },
];

function formatStudyTimeMinutes(minutes: number): string {
  if (minutes <= 0) return '0分钟';
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  if (h === 0) return `${m}分钟`;
  if (m === 0) return `${h}小时`;
  return `${h}小时${m}分钟`;
}

function parseCalendarDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return {
    month,
    day,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

const ERROR_TYPE_LABELS: Record<string, string> = {
  C: '概念错误',
  P: '过程错误',
  L: '逻辑错误',
  S: '符号错误',
  UNKNOWN: '其他',
};

const AnalyticsPageInner: React.FC = () => {
  const [timeRange, setTimeRange] = useState('week');
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [stats, setStats] = useState<StatisticsResponse | null>(null);
  const [masteryTopics, setMasteryTopics] = useState<MasteryTopic[]>([]);
  const [classRanking, setClassRanking] = useState<ClassRankingResponse | null>(null);
  const [portraitInsights, setPortraitInsights] = useState<PortraitInsights | null>(null);
  const [portraitLoading, setPortraitLoading] = useState(true);
  const [portraitError, setPortraitError] = useState<AppError | null>(null);
  const [portraitRequestKey, setPortraitRequestKey] = useState(0);
  const [overviewRequestKey, setOverviewRequestKey] = useState(0);
  const [statisticsRequestKey, setStatisticsRequestKey] = useState(0);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [statisticsLoading, setStatisticsLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<AppError | null>(null);
  const [statisticsError, setStatisticsError] = useState<AppError | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setOverviewLoading(true);
      setOverviewError(null);
      try {
        const signal = controller.signal;
        const [overviewRes, masteryRes, rankingRes] = await Promise.all([
          apiClient.get<OverviewResponse>('/progress/overview', { signal }),
          apiClient.get<MasteryResponse>('/progress/mastery', { signal }),
          apiClient.get<ClassRankingResponse>('/progress/class-ranking', { signal }),
        ]);
        if (controller.signal.aborted) return;
        setOverview(overviewRes.data);
        setMasteryTopics(masteryRes.data?.topics ?? []);
        setClassRanking(rankingRes.data);
      } catch (err) {
        if (controller.signal.aborted) return;
        setOverviewError(toAppError(err, '加载累计学习数据失败'));
      } finally {
        if (!controller.signal.aborted) setOverviewLoading(false);
      }
    };
    void load();
    return () => { controller.abort(); };
  }, [overviewRequestKey]);

  useEffect(() => {
    const controller = new AbortController();
    const loadStatistics = async () => {
      setStatisticsLoading(true);
      setStatisticsError(null);
      setStats(null);
      try {
        const response = await apiClient.get<StatisticsResponse>('/progress/statistics', {
          params: { range: timeRange },
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setStats(response.data);
      } catch (err) {
        if (!controller.signal.aborted) {
          setStatisticsError(toAppError(err, '加载学习趋势失败'));
        }
      } finally {
        if (!controller.signal.aborted) setStatisticsLoading(false);
      }
    };
    void loadStatistics();
    return () => controller.abort();
  }, [statisticsRequestKey, timeRange]);

  useEffect(() => {
    const controller = new AbortController();
    const loadPortraitInsights = async () => {
      setPortraitLoading(true);
      setPortraitError(null);
      try {
        const result = await studentPortraitService.getInsights(
          timeRange as PortraitRangeType,
          controller.signal,
        );
        if (!controller.signal.aborted) setPortraitInsights(result);
      } catch (err) {
        if (!controller.signal.aborted) {
          setPortraitError(toAppError(err, '加载学生画像失败'));
        }
      } finally {
        if (!controller.signal.aborted) setPortraitLoading(false);
      }
    };
    void loadPortraitInsights();
    return () => controller.abort();
  }, [portraitRequestKey, timeRange]);

  useEffect(() => {
    if (!portraitLoading && window.location.hash === '#portrait') {
      document.getElementById('portrait')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [portraitLoading]);

  const totalStudyTimeFormatted = useMemo(
    () => (overview != null ? formatStudyTimeMinutes(overview.study_time_minutes) : '—'),
    [overview]
  );
  const totalExercises = overview?.total_exercises ?? 0;
  const correctRate = overview?.correct_rate ?? 0;
  const streak = overview?.streak_days ?? 0;

  const trendDescription = useMemo(() => {
    const map: Record<string, string> = {
      week: '当前周',
      month: '当前月',
      semester: '当前学期',
      all: '近一年',
    };
    return map[timeRange] ?? '当前周';
  }, [timeRange]);

  const rangeGoal = useMemo(() => {
    if (!stats) return { current: 0, target: 7, label: '当前周目标', unit: '天' as const };
    const activeCount = stats.daily.filter(
      (d) => (d.exercises ?? 0) > 0 || (d.study_minutes ?? 0) > 0
    ).length;
    if (timeRange === 'week') {
      return { current: Math.min(activeCount, 7), target: 7, label: '当前周目标', unit: '天' as const };
    }
    if (timeRange === 'month') {
      const daysInRange = stats.range_days ?? 30;
      return { current: activeCount, target: Math.max(daysInRange, 1), label: '当前月目标', unit: '天' as const };
    }
    if (timeRange === 'semester') {
      const weeksInRange = stats.daily.length;
      return { current: activeCount, target: Math.max(weeksInRange, 1), label: '当前学期目标', unit: '周' as const };
    }
    return { current: activeCount, target: Math.max(stats.daily.length, 1), label: '近一年', unit: '周' as const };
  }, [stats, timeRange]);

  const CIRCLE_CIRCUMFERENCE = 352;
  const rangeGoalProgress = useMemo(
    () =>
      rangeGoal.target > 0
        ? Math.min((rangeGoal.current / rangeGoal.target) * CIRCLE_CIRCUMFERENCE, CIRCLE_CIRCUMFERENCE)
        : 0,
    [rangeGoal]
  );

  const weekDayActive = useMemo(() => {
    if (timeRange !== 'week' || !stats?.daily?.length) {
      return [false, false, false, false, false, false, false] as const;
    }
    const active: boolean[] = [false, false, false, false, false, false, false];
    for (const d of stats.daily) {
      if ((d.exercises ?? 0) <= 0 && (d.study_minutes ?? 0) <= 0) continue;
      const jsDay = parseCalendarDate(d.date).weekday;
      const weekIndex = jsDay === 0 ? 6 : jsDay - 1;
      active[weekIndex] = true;
    }
    return active as [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  }, [timeRange, stats]);

  const errorDistribution = useMemo(() => {
    if (!stats?.error_type_distribution) return [];
    return Object.entries(stats.error_type_distribution).map(([code, value]) => ({
      type: ERROR_TYPE_LABELS[code] ?? '其他',
      count: value.count,
      percentage: value.percentage,
    }));
  }, [stats]);

  const totalErrors = useMemo(
    () => errorDistribution.reduce((sum, e) => sum + e.count, 0),
    [errorDistribution]
  );

  const trendChartOption = useMemo<EChartsOption | null>(() => {
    if (!stats?.daily?.length) return null;
    const isWeek = stats.interval === 'week';
    const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
    const categories = stats.daily.map((d, index) => {
      const date = parseCalendarDate(d.date);
      return isWeek
        ? `第${index + 1}周`
        : stats.daily!.length <= 7
          ? `周${weekdayNames[date.weekday]}`
          : `${date.month}/${date.day}`;
    });
    const values = stats.daily.map((d) => d.study_minutes ?? 0);
    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const p = Array.isArray(params) ? params[0] : null;
          if (!p || !('dataIndex' in p)) return '';
          const i = p.dataIndex as number;
          const mins = values[i];
          const label = mins < 60 ? `${mins}分钟` : `${(mins / 60).toFixed(1)}小时`;
          return `${categories[i]}<br/>学习时长: ${label}`;
        },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: categories.length > 14 ? '22%' : '12%',
        top: '8%',
        containLabel: true,
      },
      dataZoom:
        categories.length > 14
          ? [
              {
                type: 'slider',
                xAxisIndex: 0,
                start: Math.max(0, 100 - (15 / categories.length) * 100),
                end: 100,
                bottom: 4,
                height: 18,
                borderColor: 'transparent',
                fillerColor: 'rgba(59, 130, 246, 0.15)',
                handleStyle: { color: 'rgb(59 130 246)' },
                textStyle: { color: '#6b7280', fontSize: 11 },
                moveHandleSize: 6,
              },
              { type: 'inside', xAxisIndex: 0 },
            ]
          : undefined,
      xAxis: {
        type: 'category',
        data: categories,
        axisLabel: { interval: 0, rotate: categories.length > 14 ? 45 : 0 },
        axisLine: { lineStyle: { color: '#e5e7eb' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        name: '分钟',
        axisLabel: {
          formatter: (v: number) =>
            v < 60 ? `${v}` : `${Number((v / 60).toFixed(1))}h`,
        },
        splitLine: { lineStyle: { type: 'dashed', color: '#f3f4f6' } },
      },
      series: [
        {
          name: '学习时长',
          type: 'bar',
          data: values,
          itemStyle: {
            color: 'rgb(59 130 246)',
            borderRadius: [4, 4, 0, 0],
          },
          barMaxWidth: 40,
        },
      ],
    };
  }, [stats]);

  const errorPieChartOption = useMemo<EChartsOption | null>(() => {
    if (!errorDistribution.length) return null;
    return {
      tooltip: {
        trigger: 'item',
        formatter: '{b}: {c} 次 ({d}%)',
      },
      legend: {
        orient: 'vertical',
        right: 8,
        top: 'middle',
        textStyle: { color: '#6b7280' },
      },
      series: [
        {
          type: 'pie',
          radius: ['42%', '72%'],
          center: ['38%', '50%'],
          data: errorDistribution.map((e) => ({ name: e.type, value: e.count })),
          label: { show: true, formatter: '{b} ({d}%)' },
          labelLine: { length: 8, length2: 6 },
          emphasis: {
            itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0,0,0,0.15)' },
          },
          color: ['#ef4444', '#eab308', '#3b82f6', '#8b5cf6', '#9ca3af'],
        },
      ],
    };
  }, [errorDistribution]);

  return (
    <MainLayout>
      <div className="container mx-auto px-6 py-8 max-w-7xl">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-2">学习统计</h1>
            <p className="text-surface-500 dark:text-surface-400">跟踪你的学习进度，发现薄弱点</p>
          </div>
          <Select options={timeRangeOptions} value={timeRange} onChange={setTimeRange} className="w-32" />
        </div>

        {overviewError ? (
          <RequestErrorNotice
            error={overviewError}
            onRetry={() => setOverviewRequestKey((value) => value + 1)}
            onRefresh={() => setOverviewRequestKey((value) => value + 1)}
            className="mb-4"
          />
        ) : null}
        {statisticsError ? (
          <RequestErrorNotice
            error={statisticsError}
            onRetry={() => setStatisticsRequestKey((value) => value + 1)}
            onRefresh={() => setStatisticsRequestKey((value) => value + 1)}
            className="mb-6"
          />
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 rounded-xl bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                  <Clock className="h-6 w-6 text-primary-600 dark:text-primary-400" />
                </div>
              </div>
              <div className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-1">
                {overviewLoading ? '—' : totalStudyTimeFormatted}
              </div>
              <div className="text-sm text-surface-500 dark:text-surface-400">累计学习时长</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="w-12 h-12 rounded-xl bg-secondary-100 dark:bg-secondary-900/30 flex items-center justify-center mb-4">
                <BookOpen className="h-6 w-6 text-secondary-600 dark:text-secondary-400" />
              </div>
              <div className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-1">
                {overviewLoading ? '—' : totalExercises}
              </div>
              <div className="text-sm text-surface-500 dark:text-surface-400">完成题目数</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="w-12 h-12 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mb-4">
                <Target className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-1">
                {overviewLoading ? '—' : `${correctRate.toFixed(1)}%`}
              </div>
              <div className="text-sm text-surface-500 dark:text-surface-400">正确率</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="w-12 h-12 rounded-xl bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center mb-4">
                <Flame className="h-6 w-6 text-orange-600 dark:text-orange-400" />
              </div>
              <div className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-1">
                {overviewLoading ? '—' : `${streak}天`}
              </div>
              <div className="text-sm text-surface-500 dark:text-surface-400">连续打卡</div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-primary-500" />
                  {stats?.interval === 'week' ? '每周' : '每日'}学习趋势
                </CardTitle>
                <CardDescription>{trendDescription}的学习时长</CardDescription>
              </CardHeader>
              <CardContent>
                {statisticsLoading ? (
                  <div className="flex h-48 items-center justify-center text-sm text-surface-500 dark:text-surface-400">
                    加载中…
                  </div>
                ) : trendChartOption ? (
                  <ReactEChartsCore
                    echarts={echarts}
                    option={trendChartOption}
                    style={{ height: 280, width: '100%' }}
                    notMerge
                    opts={{ renderer: 'canvas' }}
                  />
                ) : (
                  <div className="flex items-center justify-center h-48 text-surface-500 dark:text-surface-400 text-sm">
                    暂无趋势数据
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-primary-500" />
                  知识点掌握度
                </CardTitle>
                <CardDescription>各知识点的学习进度和掌握情况</CardDescription>
              </CardHeader>
              <CardContent>
                {overviewLoading ? (
                  <div className="text-surface-500 dark:text-surface-400 py-4">加载中…</div>
                ) : masteryTopics.length === 0 ? (
                  <p className="text-sm text-surface-500 dark:text-surface-400 py-4">暂无知识点掌握数据，先去做几道题试试吧~</p>
                ) : (
                  <div className="space-y-4">
                    {masteryTopics.map((topic, index) => (
                      <div key={index} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-surface-900 dark:text-surface-100">{topic.topic}</span>
                            {topic.exercises > 0 && (
                              <Badge variant="outline" className="text-xs">{topic.exercises}题</Badge>
                            )}
                            {topic.confidence < 0.3 && (
                              <Badge variant="secondary" className="text-xs">数据不足</Badge>
                            )}
                          </div>
                          <span className="text-sm font-medium text-surface-700 dark:text-surface-300 w-12 text-right">
                            {(topic.mastery * 100).toFixed(0)}%
                          </span>
                        </div>
                        <Progress
                          value={topic.mastery * 100}
                          variant={
                            topic.mastery >= 0.8 ? 'success' : topic.mastery >= 0.6 ? 'default' : topic.mastery >= 0.4 ? 'warning' : 'destructive'
                          }
                          size="sm"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <PieChart className="h-5 w-5 text-primary-500" />
                  错误类型分布
                </CardTitle>
                <CardDescription>帮助你了解主要的错误模式（总错题 {totalErrors}）</CardDescription>
              </CardHeader>
              <CardContent>
                {errorPieChartOption ? (
                  <ReactEChartsCore
                    echarts={echarts}
                    option={errorPieChartOption}
                    style={{ height: 280, width: '100%' }}
                    notMerge
                    opts={{ renderer: 'canvas' }}
                  />
                ) : (
                  <p className="text-sm text-surface-500 dark:text-surface-400 py-4">暂无错误记录</p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{rangeGoal.label}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {statisticsLoading ? (
                  <div className="py-12 text-center text-sm text-surface-500 dark:text-surface-400">加载中…</div>
                ) : <div className="text-center py-4">
                  <div className="relative inline-flex items-center justify-center">
                    <svg className="w-32 h-32 transform -rotate-90">
                      <circle cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="8" fill="none" className="text-surface-200 dark:text-surface-700" />
                      <circle
                        cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="8" fill="none"
                        strokeDasharray={`${rangeGoalProgress} ${CIRCLE_CIRCUMFERENCE}`} strokeLinecap="round" className="text-primary-500"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-3xl font-bold text-surface-900 dark:text-surface-100">{rangeGoal.current}/{rangeGoal.target}</span>
                      <span className="text-sm text-surface-500 dark:text-surface-400">{rangeGoal.unit}</span>
                    </div>
                  </div>
                </div>}
                {!statisticsLoading && timeRange === 'week' && (
                  <div className="flex justify-center gap-1">
                    {(['一', '二', '三', '四', '五', '六', '日'] as const).map((label, i) => (
                      <div
                        key={label}
                        className={`w-8 h-8 rounded-md flex items-center justify-center text-xs font-medium ${
                          weekDayActive[i] ? 'bg-primary-500 text-white' : 'bg-surface-100 dark:bg-surface-800 text-surface-400'
                        }`}
                      >
                        {label}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">累计学习投入排名</CardTitle>
                <CardDescription>按累计学习时长与做题数计算，不随上方时间范围变化</CardDescription>
              </CardHeader>
              <CardContent>
                {overviewLoading ? (
                  <div className="text-center py-4 text-surface-500 dark:text-surface-400">—</div>
                ) : classRanking?.in_class && classRanking.available ? (
                  <>
                    <div className="text-center py-4">
                      <div className="text-5xl font-bold text-primary-600 dark:text-primary-400">#{classRanking.rank ?? '—'}</div>
                      <div className="text-sm text-surface-500 dark:text-surface-400 mt-2">共 {classRanking.total} 名学生</div>
                    </div>
                    {classRanking.total > 0 && classRanking.percentile != null && (
                      <>
                        <Progress value={classRanking.percentile} variant="success" className="mt-4" />
                        <p className="text-xs text-surface-500 dark:text-surface-400 text-center mt-2">
                          超过了 {classRanking.percentile.toFixed(0)}% 的同学
                        </p>
                      </>
                    )}
                  </>
                ) : classRanking?.in_class ? (
                  <div className="text-center py-4">
                    <p className="text-sm text-surface-500 dark:text-surface-400">暂不提供排名</p>
                    <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
                      {classRanking.unavailable_reason ?? '继续完成课程练习后可查看'}
                    </p>
                  </div>
                ) : (
                  <div className="text-center py-4">
                    <p className="text-sm text-surface-500 dark:text-surface-400">未加入班级</p>
                    <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">加入班级后可见排名（按学习时长与做题数）</p>
                  </div>
                )}
              </CardContent>
            </Card>

          </div>
        </div>

        <div className="mt-10">
          <StudentPortraitInsights
            range={timeRange as PortraitRangeType}
            insights={portraitInsights}
            loading={portraitLoading}
            error={portraitError}
            onRetry={() => setPortraitRequestKey((value) => value + 1)}
          />
        </div>
      </div>
    </MainLayout>
  );
};

export const AnalyticsPage = withErrorBoundary(AnalyticsPageInner);
