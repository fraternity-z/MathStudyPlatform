import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { MainLayout } from '../../components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/Tabs';
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Lightbulb,
  BookOpen,
  ArrowLeft,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { fetchMistakeDetail } from '@/modules/mistake/services/mistakeService';
import type { MistakeDetail } from '@/modules/mistake/services/mistakeService';
import type { BadgeProps } from '../../components/ui/Badge';
import { toAppError, type AppError } from '@/libs/http/appError';

type BadgeVariant = NonNullable<BadgeProps['variant']>;

const errorTypes: Record<string, { label: string; color: BadgeVariant; description: string }> = {
  conceptual: { label: '概念错误', color: 'destructive', description: '对基本概念理解有误' },
  procedural: { label: '过程错误', color: 'warning', description: '计算步骤或方法使用错误' },
  logical: { label: '逻辑错误', color: 'secondary', description: '推理过程存在逻辑问题' },
  symbolic: { label: '符号错误', color: 'outline', description: '数学符号书写或使用不规范' },
  calculation: { label: '计算错误', color: 'outline', description: '数值计算出错' },
};

/** 将 0-1 难度值转为显示标签 */
function getDifficultyInfo(d: number): { label: string; variant: BadgeVariant } {
  if (d >= 0.67) return { label: '困难', variant: 'destructive' };
  if (d >= 0.33) return { label: '中等', variant: 'warning' };
  return { label: '简单', variant: 'success' };
}

export const DiagnosisReportPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<MistakeDetail | null>(null);
  const [loading, setLoading] = useState(() => Boolean(id));
  const [error, setError] = useState<AppError | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    if (!id) return;

    let active = true;
    const controller = new AbortController();

    const loadDiagnosisReport = async () => {
      setLoading(true);
      setError(null);

      try {
        const detail = await fetchMistakeDetail(id, controller.signal);
        if (active) {
          setData(detail);
        }
      } catch (loadError) {
        if (controller.signal.aborted) return;
        if (active) {
          setData(null);
          setError(toAppError(loadError, '加载诊断报告失败，请稍后重试'));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void loadDiagnosisReport();

    return () => {
      active = false;
      controller.abort();
    };
  }, [id, reloadVersion]);

  const routeError = id ? null : '缺少诊断报告 ID';

  if (loading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
        </div>
      </MainLayout>
    );
  }

  if (routeError || error || !data) {
    return (
      <MainLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] text-surface-500">
          {error ? (
            <RequestErrorNotice
              error={error}
              onRetry={() => setReloadVersion((value) => value + 1)}
              onRefresh={() => setReloadVersion((value) => value + 1)}
              className="mb-4 w-full max-w-xl"
            />
          ) : (
            <>
              <XCircle className="h-12 w-12 mb-4 text-red-400" />
              <p className="text-lg mb-4">{routeError || '未找到诊断报告'}</p>
            </>
          )}
          <Button variant="outline" onClick={() => window.history.back()}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            返回
          </Button>
        </div>
      </MainLayout>
    );
  }

  const errorInfo = data.diagnosis.errorType
    ? errorTypes[data.diagnosis.errorType] || { label: data.diagnosis.errorType, color: 'outline' as BadgeVariant, description: '未知错误类型' }
    : null;
  const diffInfo = getDifficultyInfo(data.exercise.difficulty);
  const hasError = data.diagnosis.errorStepIndex !== null && data.diagnosis.errorStepIndex !== undefined;

  return (
    <MainLayout>
      <div className="container mx-auto px-6 py-8 max-w-6xl">
        {/* 页面标题和导航 */}
        <div className="mb-8">
          <Button variant="ghost" className="mb-4" onClick={() => window.history.back()}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            返回错题本
          </Button>
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-2">
                诊断报告
              </h1>
              <p className="text-surface-500 dark:text-surface-400">
                {data.exercise.title}
                {data.attempt.submittedAt && ` · 提交于 ${new Date(data.attempt.submittedAt).toLocaleString('zh-CN')}`}
              </p>
            </div>
          </div>
        </div>

        {/* 得分概览 */}
        {hasError && errorInfo && (
          <Card className="mb-6">
            <CardContent className="p-6">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                    <XCircle className="h-8 w-8 text-red-600 dark:text-red-400" />
                  </div>
                  <div>
                    <div className="text-sm text-surface-500 dark:text-surface-400">错误类型</div>
                    <Badge variant={errorInfo.color}>
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      {errorInfo.label}
                    </Badge>
                  </div>
                </div>
                <div className="h-12 w-px bg-surface-200 dark:bg-surface-700" />
                <div>
                  <div className="text-sm text-surface-500 dark:text-surface-400 mb-1">难度</div>
                  <Badge variant={diffInfo.variant}>{diffInfo.label}</Badge>
                </div>
                {data.attempt.timeSpentSeconds > 0 && (
                  <>
                    <div className="h-12 w-px bg-surface-200 dark:bg-surface-700" />
                    <div>
                      <div className="text-sm text-surface-500 dark:text-surface-400 mb-1">用时</div>
                      <span className="font-medium text-surface-900 dark:text-surface-100">
                        {Math.floor(data.attempt.timeSpentSeconds / 60)} 分钟
                      </span>
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {!hasError && (
          <Card className="mb-6">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                  <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-emerald-600">解答正确</div>
                  <div className="text-sm text-surface-500">继续保持！</div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 主内容区 */}
          <div className="lg:col-span-2 space-y-6">
            {/* 题目 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BookOpen className="h-5 w-5 text-primary-500" />
                  题目
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="p-4 bg-surface-50 dark:bg-surface-800 rounded-lg text-surface-900 dark:text-surface-100">
                  {data.exercise.content}
                </div>
                <div className="flex items-center gap-4 mt-4 text-sm">
                  <Badge variant="outline">{data.exercise.title}</Badge>
                  <Badge variant={diffInfo.variant}>{diffInfo.label}</Badge>
                </div>
              </CardContent>
            </Card>

            {/* 解答对比 */}
            <Card>
              <Tabs defaultValue="comparison">
              <CardHeader>
                  <TabsList>
                    <TabsTrigger value="comparison">解答对比</TabsTrigger>
                    <TabsTrigger value="student">我的解答</TabsTrigger>
                    <TabsTrigger value="standard">标准解答</TabsTrigger>
                  </TabsList>
              </CardHeader>
              <CardContent>
                <TabsContent value="comparison" className="mt-0">
                  <div className="grid grid-cols-2 gap-6">
                    <div>
                      <h4 className="font-medium text-surface-700 dark:text-surface-300 mb-3">我的解答</h4>
                      <div className="space-y-3">
                        {data.attempt.studentSteps.map((stepContent, idx) => {
                          const isErrorStep = data.diagnosis.errorStepIndex !== null && idx === data.diagnosis.errorStepIndex;
                          return (
                            <div key={idx} className={`p-3 rounded-lg border ${isErrorStep ? 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20' : 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800'}`}>
                              <div className="flex items-start gap-2">
                                <span className="shrink-0 w-6 h-6 rounded-full bg-surface-100 dark:bg-surface-700 flex items-center justify-center text-xs font-medium">{idx + 1}</span>
                                <div className="flex-1 min-w-0 text-sm text-surface-700 dark:text-surface-300">{stepContent}</div>
                                {isErrorStep ? <XCircle className="h-5 w-5 text-red-500 shrink-0" /> : <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="mt-4 p-3 rounded-lg bg-surface-100 dark:bg-surface-800">
                        <div className="text-sm text-surface-500 dark:text-surface-400 mb-1">最终答案</div>
                        <div className="font-medium text-surface-900 dark:text-surface-100">{data.attempt.studentAnswer}</div>
                      </div>
                    </div>
                    <div>
                      <h4 className="font-medium text-surface-700 dark:text-surface-300 mb-3">标准解答</h4>
                      <div className="space-y-3">
                        {data.solution.steps.map((stepContent, idx) => (
                          <div key={idx} className="p-3 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20">
                            <div className="flex items-start gap-2">
                              <span className="shrink-0 w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900 flex items-center justify-center text-xs font-medium text-emerald-700 dark:text-emerald-300">{idx + 1}</span>
                              <div className="text-sm text-surface-700 dark:text-surface-300">{stepContent}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 p-3 rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                        <div className="text-sm text-emerald-600 dark:text-emerald-400 mb-1">正确答案</div>
                        <div className="font-medium text-emerald-700 dark:text-emerald-300">{data.solution.answer}</div>
                      </div>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="student" className="mt-0">
                  <div className="space-y-3">
                    {data.attempt.studentSteps.map((stepContent, idx) => {
                      const isErrorStep = data.diagnosis.errorStepIndex !== null && idx === data.diagnosis.errorStepIndex;
                      return (
                        <div key={idx} className={`p-4 rounded-lg border ${isErrorStep ? 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20' : 'border-surface-200 dark:border-surface-700'}`}>
                          <div className="flex items-start gap-3">
                            <span className="w-8 h-8 rounded-full bg-surface-100 dark:bg-surface-700 flex items-center justify-center font-medium">{idx + 1}</span>
                            <div className="flex-1">
                              <div className="text-surface-900 dark:text-surface-100">{stepContent}</div>
                              {isErrorStep && <div className="mt-2 text-sm text-red-600 dark:text-red-400">此步骤存在错误</div>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </TabsContent>

                <TabsContent value="standard" className="mt-0">
                  <div className="space-y-3">
                    {data.solution.steps.map((stepContent, idx) => (
                      <div key={idx} className="p-4 rounded-lg border border-surface-200 dark:border-surface-700">
                        <div className="flex items-start gap-3">
                          <span className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900 flex items-center justify-center font-medium text-primary-700 dark:text-primary-300">{idx + 1}</span>
                          <div className="text-surface-900 dark:text-surface-100">{stepContent}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </TabsContent>
              </CardContent>
              </Tabs>
            </Card>
          </div>

          {/* 右侧边栏 */}
          <div className="space-y-6">
            {/* 错误分析 */}
            {hasError && errorInfo && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-yellow-500" />
                    错误分析
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant={errorInfo.color}>{errorInfo.label}</Badge>
                      {data.diagnosis.errorStepIndex !== null && (
                        <span className="text-sm text-surface-500 dark:text-surface-400">
                          第 {data.diagnosis.errorStepIndex + 1} 步
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-surface-600 dark:text-surface-400">{errorInfo.description}</p>
                  </div>
                  {data.diagnosis.explanation && (
                    <div className="p-4 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
                      <p className="text-sm text-yellow-800 dark:text-yellow-200">{data.diagnosis.explanation}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* 相关知识点 */}
            {data.diagnosis.relatedConcepts.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">相关知识点</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {data.diagnosis.relatedConcepts.map((concept, index) => (
                      <Badge key={index} variant="outline" className="cursor-pointer hover:bg-primary-50 dark:hover:bg-primary-900/20">
                        {concept}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* 改进建议 */}
            {data.diagnosis.suggestion && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Lightbulb className="h-5 w-5 text-primary-500" />
                    改进建议
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="p-4 rounded-lg bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-800">
                    <pre className="text-sm text-primary-800 dark:text-primary-200 whitespace-pre-wrap font-sans">
                      {data.diagnosis.suggestion}
                    </pre>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* 历史记录 */}
            {data.history.length > 1 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <RefreshCw className="h-5 w-5 text-surface-500" />
                    作答历史
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {data.history.map((h, idx) => (
                    <div key={idx} className="flex items-center justify-between p-2 rounded-lg bg-surface-50 dark:bg-surface-800 text-sm">
                      <span className="text-surface-600 dark:text-surface-400">
                        {h.submittedAt ? new Date(h.submittedAt).toLocaleString('zh-CN') : '未知时间'}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{h.score}分</span>
                        {h.isCorrect
                          ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                          : <XCircle className="h-4 w-4 text-red-500" />}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </MainLayout>
  );
};
