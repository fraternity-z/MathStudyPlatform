import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { MainLayout } from '../../components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Progress } from '../../components/ui/Progress';
import {
  ArrowLeft,
  User,
  Calendar,
  Clock,
  Target,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
} from 'lucide-react';
import { teacherService } from '@/modules/teacher/services/teacherService';
import type { StudentDetailData } from '@/modules/teacher/types/teacher';
import { toAppError, type AppError } from '@/libs/http/apiClient';

const getActivityIcon = (_type: string, status: string) => {
  if (status === 'success') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === 'warning') return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
  return <Clock className="h-4 w-4 text-primary-500" />;
};

const formatRelativeTime = (isoTime: string | null): string => {
  if (!isoTime) return '未知';
  const diff = Date.now() - new Date(isoTime).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
};

export const StudentDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<StudentDetailData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const fetchData = async () => {
      if (!id) return;
      try {
        setIsLoading(true);
        setError(null);
        const result = await teacherService.getStudentDetail(id, controller.signal);
        if (controller.signal.aborted) return;
        setData(result);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(toAppError(loadError, '获取学生详情失败，请稍后重试'));
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    };
    void fetchData();
    return () => controller.abort();
  }, [id, reloadKey]);

  const student = data?.student;

  // 基于掌握度生成简单学习建议
  const generateSuggestions = () => {
    if (!data?.topic_mastery.length) return [];
    const sorted = [...data.topic_mastery].sort((a, b) => a.mastery - b.mastery);
    const suggestions: { text: string; variant: 'warning' | 'success' | 'info' }[] = [];
    if (sorted[0] && sorted[0].mastery < 0.6) {
      suggestions.push({
        text: `建议加强"${sorted[0].topic}"相关练习，当前掌握度较低。`,
        variant: 'warning',
      });
    }
    const best = sorted[sorted.length - 1];
    if (best && best.mastery >= 0.8) {
      suggestions.push({
        text: `"${best.topic}"部分表现优秀，可以尝试更高难度的题目。`,
        variant: 'success',
      });
    }
    if (student && student.streak_days < 3) {
      suggestions.push({
        text: '近期学习频率有所下降，建议保持每日学习习惯。',
        variant: 'info',
      });
    }
    return suggestions;
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
          <span className="ml-3 text-surface-500">加载中...</span>
        </div>
      </MainLayout>
    );
  }

  if (error || !data || !student) {
    const displayError: AppError = error ?? {
      kind: 'not_found',
      message: '学生不存在',
      retryable: false,
      source: 'ui',
    };
    return (
      <MainLayout>
        <div className="container mx-auto px-6 py-8 max-w-7xl">
          <div className="mx-auto max-w-2xl py-20">
            <RequestErrorNotice
              error={displayError}
              onRetry={() => setReloadKey((key) => key + 1)}
              onRefresh={() => setReloadKey((key) => key + 1)}
            />
            <Button variant="outline" className="mt-4" onClick={() => window.history.back()}>
              返回
            </Button>
          </div>
        </div>
      </MainLayout>
    );
  }

  const suggestions = generateSuggestions();

  return (
    <MainLayout>
      <div className="container mx-auto px-6 py-8 max-w-7xl">
        {/* 页面标题 */}
        <div className="mb-8">
          <Button variant="ghost" className="mb-4" onClick={() => window.history.back()}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            返回班级
          </Button>
        </div>

        {/* 学生信息卡片 */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-6">
                <div className="w-20 h-20 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                  <User className="h-10 w-10 text-primary-600 dark:text-primary-400" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100 mb-1">
                    {student.name}
                  </h1>
                  <p className="text-surface-500 dark:text-surface-400 mb-2">
                    {student.username} · {student.class_name}
                  </p>
                  <div className="flex items-center gap-4 text-sm text-surface-500 dark:text-surface-400">
                    {student.joined_at && (
                      <div className="flex items-center gap-1">
                        <Calendar className="h-4 w-4" />
                        <span>加入于 {student.joined_at.split('T')[0]}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1">
                      <Clock className="h-4 w-4" />
                      <span>最近活跃: {formatRelativeTime(student.last_active)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 统计卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-8">
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                {student.total_study_hours}h
              </div>
              <div className="text-xs text-surface-500 dark:text-surface-400">学习时长</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                {student.total_exercises}
              </div>
              <div className="text-xs text-surface-500 dark:text-surface-400">完成题目</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                {student.correct_rate}%
              </div>
              <div className="text-xs text-surface-500 dark:text-surface-400">正确率</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-primary-600 dark:text-primary-400">
                #{student.rank || '—'}
              </div>
              <div className="text-xs text-surface-500 dark:text-surface-400">
                班级排名 / {student.total_class_students}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">
                {student.streak_days}天
              </div>
              <div className="text-xs text-surface-500 dark:text-surface-400">连续打卡</div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 主内容区 */}
          <div className="lg:col-span-2 space-y-6">
            {/* 知识点掌握度 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Target className="h-5 w-5 text-primary-500" />
                  知识点掌握度
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.topic_mastery.length > 0 ? (
                  <div className="space-y-4">
                    {data.topic_mastery.map((topic, index) => (
                      <div key={index} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-surface-900 dark:text-surface-100">
                              {topic.topic}
                            </span>
                            <Badge variant="outline" className="text-xs">
                              {topic.exercise_count}题
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            {topic.mastery >= 0.8 ? (
                              <TrendingUp className="h-4 w-4 text-emerald-500" />
                            ) : topic.mastery < 0.5 ? (
                              <TrendingDown className="h-4 w-4 text-red-500" />
                            ) : null}
                            <span className="text-sm font-medium text-surface-700 dark:text-surface-300 w-12 text-right">
                              {(topic.mastery * 100).toFixed(0)}%
                            </span>
                          </div>
                        </div>
                        <Progress
                          value={topic.mastery * 100}
                          variant={
                            topic.mastery >= 0.8
                              ? 'success'
                              : topic.mastery >= 0.6
                              ? 'default'
                              : topic.mastery >= 0.4
                              ? 'warning'
                              : 'destructive'
                          }
                          size="sm"
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-surface-400 py-8">暂无知识点数据</p>
                )}
              </CardContent>
            </Card>

            {/* 学习时间线 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-5 w-5 text-primary-500" />
                  学习动态
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.recent_activity.length > 0 ? (
                  <div className="relative">
                    <div className="absolute left-[7px] top-0 bottom-0 w-0.5 bg-surface-200 dark:bg-surface-700" />
                    <div className="space-y-4">
                      {data.recent_activity.map((activity) => (
                        <div key={activity.id} className="relative flex gap-4 pl-6">
                          <div className="absolute left-0 w-4 h-4 rounded-full bg-white dark:bg-surface-900 border-2 border-surface-200 dark:border-surface-700 flex items-center justify-center">
                            {getActivityIcon(activity.type, activity.status)}
                          </div>
                          <div className="flex-1 pb-4">
                            <p className="text-surface-900 dark:text-surface-100">{activity.content}</p>
                            <p className="text-sm text-surface-500 dark:text-surface-400">
                              {formatRelativeTime(activity.time)}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-center text-surface-400 py-8">暂无学习动态</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* 右侧边栏 */}
          <div className="space-y-6">
            {/* 学习建议 */}
            {suggestions.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">学习建议</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {suggestions.map((s, i) => {
                    const variantStyles = {
                      warning: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200',
                      success: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200',
                      info: 'bg-primary-50 dark:bg-primary-900/20 border-primary-200 dark:border-primary-800 text-primary-800 dark:text-primary-200',
                    };
                    return (
                      <div key={i} className={`p-3 rounded-lg border ${variantStyles[s.variant]}`}>
                        <p className="text-sm">{s.text}</p>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            )}

            {/* 最近错题 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-red-500" />
                  最近错题
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.recent_mistakes.length > 0 ? (
                  data.recent_mistakes.map((mistake) => (
                    <div
                      key={mistake.id}
                      className="p-3 rounded-lg border border-surface-200 dark:border-surface-700"
                    >
                      <p className="text-sm text-surface-900 dark:text-surface-100 mb-2">
                        {mistake.content}
                      </p>
                      <div className="flex items-center justify-between">
                        <Badge
                          variant={
                            mistake.error_type === 'conceptual'
                              ? 'destructive'
                              : mistake.error_type === 'procedural'
                              ? 'warning'
                              : 'secondary'
                          }
                        >
                          {mistake.error_type === 'conceptual'
                            ? '概念错误'
                            : mistake.error_type === 'procedural'
                            ? '过程错误'
                            : mistake.error_type === 'logical'
                            ? '逻辑错误'
                            : mistake.error_type === 'symbolic'
                            ? '符号错误'
                            : mistake.error_type === 'calculation'
                            ? '计算错误'
                            : mistake.error_type || '未分类'}
                        </Badge>
                        <span className="text-xs text-surface-500">
                          {formatRelativeTime(mistake.date)}
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-center text-surface-400 py-4">暂无错题</p>
                )}
              </CardContent>
            </Card>

          </div>
        </div>
      </div>
    </MainLayout>
  );
};
