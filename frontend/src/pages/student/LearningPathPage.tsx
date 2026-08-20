import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MainLayout } from '../../components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Progress } from '../../components/ui/Progress';
import { toAppError, type AppError } from '@/libs/http/apiClient';
import { knowledgeService } from '@/modules/knowledge/services/knowledgeService';
import type {
  LearningPathItem,
  LearningPathResponse,
} from '@/modules/knowledge/types/knowledge';
import {
  Target,
  CheckCircle2,
  Lock,
  Play,
  BookOpen,
  ArrowRight,
  Loader2,
  Circle,
} from 'lucide-react';

const EMPTY_PATH_ITEMS: ReadonlyArray<LearningPathItem> = [];
const EMPTY_PATH_STATISTICS = { total: 0, completed: 0, progress: 0 };

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-6 w-6 text-emerald-500" />;
    case 'current':
      return <Play className="h-6 w-6 text-primary-500" />;
    case 'available':
      return <Circle className="h-6 w-6 text-blue-400" />;
    case 'locked':
      return <Lock className="h-6 w-6 text-surface-400" />;
    default:
      return <Circle className="h-6 w-6 text-surface-400" />;
  }
};

const getStatusBadge = (status: string) => {
  switch (status) {
    case 'completed':
      return <Badge variant="success">已掌握</Badge>;
    case 'current':
      return <Badge variant="default">学习中</Badge>;
    case 'available':
      return <Badge variant="outline">可学习</Badge>;
    case 'locked':
      return <Badge variant="secondary">未解锁</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
};

export const LearningPathPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedTargetId = searchParams.get('target')?.trim() || null;
  const [pathData, setPathData] = useState<LearningPathResponse | null>(null);
  const [targetId, setTargetId] = useState<string | null>(requestedTargetId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [goalWarning, setGoalWarning] = useState<AppError | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setError(null);
      setGoalWarning(null);
      try {
        let resolvedTargetId = requestedTargetId;
        if (!resolvedTargetId) {
          try {
            const goal = await knowledgeService.getLearningGoal(controller.signal);
            resolvedTargetId = goal.target_id;
          } catch (goalError) {
            if (controller.signal.aborted) return;
            setGoalWarning(toAppError(goalError, '学习目标读取失败，已显示完整学习路径'));
          }
        }

        const response = await knowledgeService.getLearningPath(
          resolvedTargetId ?? undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setTargetId(resolvedTargetId);
          setPathData(response);
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(toAppError(err, '加载学习路径失败'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => { controller.abort(); };
  }, [reloadVersion, requestedTargetId]);

  const pathItems = pathData?.path ?? EMPTY_PATH_ITEMS;
  const stats = pathData?.statistics ?? EMPTY_PATH_STATISTICS;
  const pathNodesById = useMemo(
    () => new Map(pathItems.map((item) => [item.id, item])),
    [pathItems],
  );
  const targetNode = targetId ? pathNodesById.get(targetId) ?? null : null;
  const overallProgress = Math.round(stats.progress * 100);
  const currentCount = useMemo(() => pathItems.filter((p) => p.status === 'current').length, [pathItems]);
  const lockedCount = useMemo(() => pathItems.filter((p) => p.status === 'locked' || p.status === 'available').length, [pathItems]);

  return (
    <MainLayout>
      <div className="container mx-auto px-6 py-8 max-w-7xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-2">学习路径</h1>
          <p className="text-surface-500 dark:text-surface-400">
            {targetNode ? `当前目标：${targetNode.title}` : '基于知识图谱和掌握度为你规划的个性化学习路径'}
          </p>
        </div>

        {goalWarning ? (
          <RequestErrorNotice
            error={goalWarning}
            onRetry={() => setReloadVersion((value) => value + 1)}
            onRefresh={() => setReloadVersion((value) => value + 1)}
            className="mb-4"
          />
        ) : null}

        {error ? (
          <RequestErrorNotice
            error={error}
            onRetry={() => setReloadVersion((value) => value + 1)}
            onRefresh={() => setReloadVersion((value) => value + 1)}
            className="mb-6"
          />
        ) : null}

        {loading ? (
          <div className="flex justify-center p-10"><Loader2 className="h-8 w-8 animate-spin text-primary-500" /></div>
        ) : pathItems.length === 0 ? (
          <Card><CardContent className="p-8 text-center text-surface-500 dark:text-surface-400">暂无学习路径数据，请先完成一些练习题</CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Target className="h-5 w-5 text-primary-500" />
                        {targetNode ? `通往 ${targetNode.title}` : '个性化学习路径'}
                      </CardTitle>
                      <CardDescription className="mt-1">共 {stats.total} 个知识点，已掌握 {stats.completed} 个</CardDescription>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold text-primary-600 dark:text-primary-400">{overallProgress}%</div>
                      <div className="text-xs text-surface-500 dark:text-surface-400">总进度</div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="relative">
                    <div className="absolute left-[23px] top-0 bottom-0 w-0.5 bg-surface-200 dark:bg-surface-700" />
                    <div className="space-y-4">
                      {pathItems.map((item) => (
                        <div
                          key={item.id}
                          className={`relative flex gap-4 p-4 rounded-lg transition-all ${
                            item.status === 'current'
                              ? 'bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-800'
                              : item.status === 'locked'
                              ? 'opacity-60'
                              : 'hover:bg-surface-50 dark:hover:bg-surface-800/50'
                          }`}
                        >
                          <div className="relative z-10 shrink-0 w-12 h-12 rounded-full bg-white dark:bg-surface-900 border-2 border-surface-200 dark:border-surface-700 flex items-center justify-center">
                            {getStatusIcon(item.status)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between mb-1">
                              <div>
                                <h4 className="font-medium text-surface-900 dark:text-surface-100">{item.title}</h4>
                                <p className="text-sm text-surface-500 dark:text-surface-400 mt-0.5">{item.description}</p>
                              </div>
                              {getStatusBadge(item.status)}
                            </div>
                            <div className="flex items-center gap-4 mt-3 text-sm text-surface-500 dark:text-surface-400">
                              {item.chapter && (
                                <span className="text-xs px-2 py-0.5 rounded bg-surface-100 dark:bg-surface-800">{item.chapter}</span>
                              )}
                              <div className="flex items-center gap-1">
                                <BookOpen className="h-4 w-4" />
                                <span>{item.exercises} 次练习</span>
                              </div>
                            </div>
                            {item.status !== 'locked' && (
                              <div className="mt-3">
                                <div className="flex items-center justify-between text-sm mb-1">
                                  <span className="text-surface-500 dark:text-surface-400">掌握度</span>
                                  <span className="font-medium text-surface-700 dark:text-surface-300">{(item.mastery * 100).toFixed(0)}%</span>
                                </div>
                                <Progress
                                  value={item.mastery * 100}
                                  variant={item.mastery >= 0.8 ? 'success' : item.mastery >= 0.5 ? 'default' : 'warning'}
                                  size="sm"
                                />
                              </div>
                            )}
                            {item.recommendation ? (
                              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-5 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                                {item.recommendation}
                              </p>
                            ) : null}
                            {item.locked_by?.length ? (
                              <div className="mt-3">
                                <p className="mb-2 text-xs font-medium text-surface-500 dark:text-surface-400">需要先掌握</p>
                                <div className="flex flex-wrap gap-2">
                                  {item.locked_by.map((blockerId) => {
                                    const blocker = pathNodesById.get(blockerId);
                                    return (
                                      <button
                                        key={blockerId}
                                        type="button"
                                        onClick={() => navigate(`/knowledge-graph?focus=${encodeURIComponent(blockerId)}`)}
                                        className="inline-flex min-h-8 items-center gap-1 rounded-md border border-[#f97360]/40 bg-[#f97360]/10 px-2.5 py-1 text-xs font-medium text-[#c24132] hover:bg-[#f97360]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-[#ff9b8d]"
                                      >
                                        <Lock className="h-3.5 w-3.5" />
                                        {blocker?.title || blockerId}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ) : null}
                            {(item.status === 'current' || item.status === 'available') && (
                              <Button
                                className="mt-4"
                                size="sm"
                                onClick={() => navigate(`/exercise?mode=ai&concept_id=${encodeURIComponent(item.id)}&autostart=1`)}
                              >
                                {item.status === 'current' ? '继续学习' : '开始学习'}
                                <ArrowRight className="h-4 w-4 ml-1" />
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
            <div className="space-y-6">
              <Card>
                <CardHeader><CardTitle className="text-lg">学习进度</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="text-center py-4">
                    <div className="relative inline-flex items-center justify-center">
                      <svg className="w-32 h-32 transform -rotate-90">
                        <circle cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="8" fill="none" className="text-surface-200 dark:text-surface-700" />
                        <circle cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="8" fill="none" strokeDasharray={`${overallProgress * 3.52} 352`} strokeLinecap="round" className="text-primary-500" />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-3xl font-bold text-surface-900 dark:text-surface-100">{overallProgress}%</span>
                        <span className="text-sm text-surface-500 dark:text-surface-400">完成进度</span>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/20">
                      <div className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-500" /><span className="text-sm text-surface-700 dark:text-surface-300">已掌握</span></div>
                      <span className="font-bold text-emerald-600 dark:text-emerald-400">{stats.completed}</span>
                    </div>
                    <div className="flex justify-between items-center p-3 rounded-lg bg-primary-50 dark:bg-primary-900/20">
                      <div className="flex items-center gap-2"><Play className="h-5 w-5 text-primary-500" /><span className="text-sm text-surface-700 dark:text-surface-300">进行中</span></div>
                      <span className="font-bold text-primary-600 dark:text-primary-400">{currentCount}</span>
                    </div>
                    <div className="flex justify-between items-center p-3 rounded-lg bg-surface-100 dark:bg-surface-800">
                      <div className="flex items-center gap-2"><Lock className="h-5 w-5 text-surface-400" /><span className="text-sm text-surface-700 dark:text-surface-300">待学习</span></div>
                      <span className="font-bold text-surface-600 dark:text-surface-400">{lockedCount}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-lg">预计练习</CardTitle></CardHeader>
                <CardContent>
                  <div className="text-center py-4">
                    <div className="text-4xl font-bold text-primary-600 dark:text-primary-400">{pathData?.estimated_exercises ?? 0}</div>
                    <div className="text-sm text-surface-500 dark:text-surface-400 mt-1">剩余推荐练习题数</div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </div>
    </MainLayout>
  );
};
