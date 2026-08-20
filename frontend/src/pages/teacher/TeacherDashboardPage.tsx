import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MainLayout } from '../../components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import {
  Users,
  BarChart3,
  BookOpen,
  Target,
  Download,
  Calendar,
  ChevronDown,
  Loader2,
} from 'lucide-react';
import { cn } from '../../libs/utils/cn';
import { teacherService } from '@/modules/teacher/services/teacherService';
import { DashboardExportModal } from './DashboardExportModal';
import type { DashboardStats, TeacherAnalyticsData } from '@/modules/teacher/types/teacher';
import { toAppError, type AppError } from '@/libs/http/apiClient';

const TIME_RANGE_OPTIONS = [
  { label: '今日', value: 'today' },
  { label: '本周', value: 'week' },
  { label: '本月', value: 'month' },
  { label: '本学期', value: 'semester' },
];

export const TeacherDashboardPage: React.FC = () => {
  const [timeRange, setTimeRange] = useState('week');
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [analyticsData, setAnalyticsData] = useState<TeacherAnalyticsData | null>(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState<AppError | null>(null);
  const [analyticsError, setAnalyticsError] = useState<AppError | null>(null);
  const [dashboardReloadKey, setDashboardReloadKey] = useState(0);
  const [analyticsReloadKey, setAnalyticsReloadKey] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);

  const timeRangeLabel = TIME_RANGE_OPTIONS.find((o) => o.value === timeRange)?.label ?? timeRange;

  // Dashboard stats 只加载一次
  useEffect(() => {
    const controller = new AbortController();
    setDashLoading(true);
    setDashboardError(null);
    teacherService
      .getDashboardStats(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setDashboardStats(data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setDashboardError(toAppError(error, '获取工作台数据失败'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDashLoading(false);
      });
    return () => controller.abort();
  }, [dashboardReloadKey]);

  // Analytics 随 timeRange 变化
  useEffect(() => {
    const controller = new AbortController();

    const fetchAnalytics = async () => {
      setAnalyticsLoading(true);
      setAnalyticsError(null);
      try {
        const data = await teacherService.getAnalytics(timeRange, controller.signal);
        if (!controller.signal.aborted) setAnalyticsData(data);
      } catch (error) {
        if (!controller.signal.aborted) {
          setAnalyticsError(toAppError(error, '获取分析数据失败'));
        }
      } finally {
        if (!controller.signal.aborted) setAnalyticsLoading(false);
      }
    };

    void fetchAnalytics();
    return () => controller.abort();
  }, [analyticsReloadKey, timeRange]);

  return (
    <MainLayout>
      <div className="container mx-auto px-6 py-8 max-w-7xl">
        {/* 页面标题 */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100 mb-1">教学概览</h1>
            <p className="text-surface-500 dark:text-surface-400">查看班级学情，管理教学进度</p>
          </div>
          <div className="flex gap-3 flex-wrap">
            <div className="relative">
              <select
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value)}
                className="appearance-none px-4 py-2 pr-8 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {TIME_RANGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 pointer-events-none" />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExportOpen(true)}
              disabled={dashLoading || analyticsLoading || !dashboardStats || !analyticsData}
            >
              <Download className="w-4 h-4 mr-2" />
              导出报告
            </Button>
          </div>
        </div>

        {dashboardError ? (
          <RequestErrorNotice
            error={dashboardError}
            onRetry={() => setDashboardReloadKey((key) => key + 1)}
            onRefresh={() => setDashboardReloadKey((key) => key + 1)}
            className="mb-4"
          />
        ) : null}
        {analyticsError ? (
          <RequestErrorNotice
            error={analyticsError}
            onRetry={() => setAnalyticsReloadKey((key) => key + 1)}
            onRefresh={() => setAnalyticsReloadKey((key) => key + 1)}
            className="mb-6"
          />
        ) : null}

        {/* 统计卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                学生状态
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-primary-50 dark:bg-primary-900/30 flex items-center justify-center">
                  <Users className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                </div>
                <div>
                  <div className="text-xs text-surface-500 dark:text-surface-400">总学生数</div>
                  <div className="text-lg font-semibold text-surface-900 dark:text-surface-100">
                    {dashLoading ? '...' : String(dashboardStats?.total_students ?? 0)}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-secondary-50 dark:bg-secondary-900/30 flex items-center justify-center">
                  <BarChart3 className="w-4 h-4 text-secondary-600 dark:text-secondary-400" />
                </div>
                <div>
                  <div className="text-xs text-surface-500 dark:text-surface-400">今日活跃</div>
                  <div className="text-lg font-semibold text-surface-900 dark:text-surface-100">
                    {dashLoading ? '...' : `${dashboardStats?.active_today ?? 0}%`}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Target className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                学习表现
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center">
                  <Target className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <div className="text-xs text-surface-500 dark:text-surface-400">平均完成率</div>
                  <div className="text-lg font-semibold text-surface-900 dark:text-surface-100">
                    {analyticsLoading ? '...' : `${analyticsData?.overview.avg_completion_rate ?? 0}%`}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-amber-50 dark:bg-amber-900/30 flex items-center justify-center">
                  <BookOpen className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <div className="text-xs text-surface-500 dark:text-surface-400">平均成绩</div>
                  <div className="text-lg font-semibold text-surface-900 dark:text-surface-100">
                    {analyticsLoading ? '...' : String(analyticsData?.overview.avg_score ?? 0)}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 知识点掌握度 + 成绩排行 */}
        {analyticsLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
            <span className="ml-3 text-surface-500">加载分析数据...</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
              {/* 知识点掌握度 */}
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BookOpen className="w-5 h-5 text-emerald-500" />
                    知识点掌握度分析
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {analyticsData?.knowledge_points.length ? (
                    <div className="space-y-4">
                      {analyticsData.knowledge_points.map((kp, i) => (
                        <div key={i} className="flex items-center gap-4">
                          <div className="w-28 text-sm font-medium text-surface-700 dark:text-surface-300 truncate">{kp.name}</div>
                          <div className="flex-1 h-3 bg-surface-100 dark:bg-surface-800 rounded-full overflow-hidden">
                            <div
                              className={cn(
                                'h-full rounded-full transition-all duration-500',
                                kp.mastery >= 80 ? 'bg-emerald-500' : kp.mastery >= 60 ? 'bg-amber-500' : 'bg-red-500'
                              )}
                              style={{ width: `${kp.mastery}%` }}
                            />
                          </div>
                          <div className="w-12 text-right text-sm font-bold text-surface-900 dark:text-surface-100">{kp.mastery}%</div>
                          <div className="w-16 text-right text-xs text-surface-400">{kp.student_count}人</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-center text-surface-400 py-8">暂无知识点数据</p>
                  )}
                </CardContent>
              </Card>

              {/* 成绩排行 */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Target className="w-5 h-5 text-emerald-500" />
                    成绩排行榜
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {analyticsData?.top_students.length ? (
                    <div className="space-y-3">
                      {analyticsData.top_students.map((student) => (
                        <div
                          key={student.rank}
                          className={cn(
                            'flex items-center gap-3 p-3 rounded-lg',
                            student.rank <= 3 ? 'bg-surface-50 dark:bg-surface-800' : ''
                          )}
                        >
                          <div className={cn(
                            'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold',
                            student.rank === 1 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400' :
                            student.rank === 2 ? 'bg-surface-200 text-surface-600 dark:bg-surface-700 dark:text-surface-300' :
                            student.rank === 3 ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-400' :
                            'bg-surface-100 text-surface-500 dark:bg-surface-800 dark:text-surface-400'
                          )}>
                            {student.rank}
                          </div>
                          <div className="flex-1">
                            <div className="font-medium text-surface-900 dark:text-surface-100 text-sm">{student.name}</div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold text-surface-900 dark:text-surface-100">{student.avg_score}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-center text-surface-400 py-8">暂无排名数据</p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* 周活跃度 + 快捷入口 */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* 周活跃度 */}
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-emerald-500" />
                    本周学习活跃度
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {analyticsData?.weekly_activity.length ? (
                    <div className="flex items-end justify-between gap-2 h-48 px-4">
                      {analyticsData.weekly_activity.map((day, i) => (
                        <div key={i} className="flex-1 flex flex-col items-center gap-2">
                          <div className="w-full flex flex-col items-center justify-end h-36">
                            <div
                              className={cn(
                                'w-full max-w-12 rounded-t-lg transition-all duration-300',
                                day.active_rate >= 80 ? 'bg-emerald-500' : day.active_rate >= 50 ? 'bg-emerald-400' : 'bg-surface-300 dark:bg-surface-600'
                              )}
                              style={{ height: `${Math.max(day.active_rate, 2)}%` }}
                            />
                          </div>
                          <span className="text-xs text-surface-500 dark:text-surface-400">{day.day_label}</span>
                          <span className="text-xs font-medium text-surface-700 dark:text-surface-300">{day.active_rate}%</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-center text-surface-400 py-8">暂无活跃度数据</p>
                  )}
                </CardContent>
              </Card>

              {/* 快捷入口 */}
              <Card>
                <CardHeader>
                  <CardTitle>快捷入口</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Link to="/teacher/classes" className="block">
                    <Button variant="outline" className="w-full justify-start">
                      <Users className="w-4 h-4 mr-2" />
                      班级管理
                    </Button>
                  </Link>
                  <Link to="/teacher/students" className="block">
                    <Button variant="outline" className="w-full justify-start">
                      <BarChart3 className="w-4 h-4 mr-2" />
                      学生管理
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>

      {/* 导出报告模态框 */}
      {dashboardStats && analyticsData && (
        <DashboardExportModal
          isOpen={exportOpen}
          onClose={() => setExportOpen(false)}
          stats={dashboardStats}
          analytics={analyticsData}
          timeRangeLabel={timeRangeLabel}
        />
      )}
    </MainLayout>
  );
};
