import React, { useCallback, useEffect, useState } from 'react';
import { AdminLayout } from '@/modules/admin/components/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { RequestErrorNotice } from '@/components/feedback';
import { StatCard } from '../../components/ui/StatCard';
import {
  Users,
  GraduationCap,
  Activity,
  Shield,
  RefreshCw,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/Tabs';
import { UserGrowthChart } from '../../components/charts';
import { SecurityLogModal } from '@/modules/admin/components/SecurityLogModal';
import { OperationsPanel } from '@/modules/admin/components/OperationsPanel';
import { useSerialPolling } from '@/hooks/useSerialPolling';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  fetchOverviewStats,
  fetchUserGrowth,
  fetchRecentActivities,
  fetchSystemStatus,
  resetTrafficMetrics,
  clearTrafficResetError,
  setUserGrowthPeriod,
} from '@/modules/admin/store/adminStatsSlice';
import {
  selectOverviewData,
  selectUserGrowthData,
  selectActivitiesData,
  selectSystemStatusData,
} from '../../store/selectors/adminStatsSelectors';
import type { UserGrowthPeriod } from '@/modules/admin/types/adminStats';
import { getAdminErrorToast } from '@/modules/admin/utils/errorFeedback';

export const AdminDashboardPage: React.FC = () => {
  const dispatch = useAppDispatch();
  const { toast } = useToast();

  // 安全日志弹窗状态
  const [isSecurityLogModalOpen, setIsSecurityLogModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('operations');
  const [operationsAutoRefresh, setOperationsAutoRefresh] = useState(true);
  const [isResetMetricsDialogOpen, setIsResetMetricsDialogOpen] = useState(false);

  // 使用记忆化 Selectors 减少不必要的重渲染
  const { overview, overviewLoading, overviewError } = useAppSelector(selectOverviewData);
  const { userGrowth, userGrowthLoading, userGrowthError, userGrowthPeriod } = useAppSelector(selectUserGrowthData);
  const { recentActivities, activitiesLoading, activitiesError } = useAppSelector(selectActivitiesData);
  const {
    systemStatus,
    systemStatusLoading,
    systemStatusError,
    trafficResetLoading,
    trafficResetError,
  } = useAppSelector(selectSystemStatusData);

  // 组件挂载时获取一次性数据
  useEffect(() => {
    const overviewRequest = dispatch(fetchOverviewStats());
    const activitiesRequest = dispatch(fetchRecentActivities(10));
    return () => {
      overviewRequest.abort();
      activitiesRequest.abort();
    };
  }, [dispatch]);

  // 仅在 period 变化时获取用户增长数据
  useEffect(() => {
    const request = dispatch(fetchUserGrowth(userGrowthPeriod));
    return () => request.abort();
  }, [dispatch, userGrowthPeriod]);

  const pollSystemStatus = useCallback(async (signal: AbortSignal) => {
    const request = dispatch(fetchSystemStatus());
    const abortRequest = () => request.abort();
    signal.addEventListener('abort', abortRequest, { once: true });
    try {
      await request.unwrap();
    } finally {
      signal.removeEventListener('abort', abortRequest);
    }
  }, [dispatch]);

  useSerialPolling(
    pollSystemStatus,
    activeTab === 'operations' && operationsAutoRefresh && trafficResetLoading !== 'loading' ? 15_000 : 0
  );

  const openResetMetricsDialog = () => {
    dispatch(clearTrafficResetError());
    setIsResetMetricsDialogOpen(true);
  };

  const handleResetTrafficMetrics = async () => {
    try {
      const result = await dispatch(resetTrafficMetrics()).unwrap();
      setIsResetMetricsDialogOpen(false);
      void dispatch(fetchSystemStatus());
      toast({
        type: 'success',
        title: '指标已重置',
        description: result.message,
      });
    } catch (error) {
      const feedback = getAdminErrorToast(error, '重置运维流量指标失败', '重置失败');
      if (feedback) toast(feedback);
    }
  };

  // 刷新业务概览数据
  const handleBusinessRefresh = () => {
    dispatch(fetchOverviewStats());
    dispatch(fetchUserGrowth(userGrowthPeriod));
    dispatch(fetchRecentActivities(10));
  };

  // 切换用户增长周期
  const handlePeriodChange = (period: UserGrowthPeriod) => {
    dispatch(setUserGrowthPeriod(period));
  };

  // 格式化数字显示
  const formatNumber = (num: number | undefined): string => {
    if (num === undefined) return '-';
    return num.toLocaleString();
  };

  // 格式化趋势显示
  const formatTrend = (value: number | undefined): string => {
    if (value === undefined) return '';
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(1)}%`;
  };

  return (
    <AdminLayout>
      <div className="container mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="mb-2 text-3xl font-bold text-surface-900 dark:text-surface-100">运维控制台</h1>
            <p className="text-surface-500 dark:text-surface-400">服务健康、请求流量与核心依赖的实时状态</p>
          </div>
          <div className="flex gap-3 self-start sm:self-auto">
            <Button variant="outline" onClick={() => setIsSecurityLogModalOpen(true)}>
              <Shield className="mr-2 h-4 w-4" />
              安全日志
            </Button>
          </div>
        </div>

        <Tabs
          defaultValue="operations"
          value={activeTab}
          onValueChange={setActiveTab}
          className="space-y-4"
        >
          <TabsList className="grid h-auto w-full grid-cols-2 sm:inline-grid sm:w-auto">
            <TabsTrigger value="operations">运维监控</TabsTrigger>
            <TabsTrigger value="business">业务概览</TabsTrigger>
          </TabsList>

          <TabsContent value="operations" className="space-y-6">
            <OperationsPanel
              data={systemStatus}
              loading={systemStatusLoading}
              error={systemStatusError}
              autoRefresh={operationsAutoRefresh}
              resetting={trafficResetLoading === 'loading'}
              onAutoRefreshChange={setOperationsAutoRefresh}
              onRefresh={() => { void dispatch(fetchSystemStatus()); }}
              onResetRequest={openResetMetricsDialog}
            />
          </TabsContent>

          <TabsContent value="business" className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-xl font-semibold text-surface-950 dark:text-surface-50">业务概览</h2>
                <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">账户规模、近期活动与用户增长趋势</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="self-start sm:self-auto"
                onClick={handleBusinessRefresh}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${overviewLoading === 'loading' ? 'animate-spin' : ''}`} />
                刷新业务数据
              </Button>
            </div>

            {overviewError ? (
              <RequestErrorNotice
                error={overviewError}
                onRetry={() => { void dispatch(fetchOverviewStats()); }}
                onRefresh={() => { void dispatch(fetchOverviewStats()); }}
              />
            ) : null}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                title="总用户数"
                value={overviewLoading === 'loading' ? '...' : formatNumber(overview?.total_users)}
                trend={formatTrend(overview?.trends.users_change)}
                trendUp={(overview?.trends.users_change ?? 0) >= 0}
                icon={<Users className="h-5 w-5 text-primary-600 dark:text-primary-400" />}
              />
              <StatCard
                title="学生账户"
                value={overviewLoading === 'loading' ? '...' : formatNumber(overview?.student_count)}
                trend={formatTrend(overview?.trends.students_change)}
                trendUp={(overview?.trends.students_change ?? 0) >= 0}
                icon={<GraduationCap className="h-5 w-5 text-secondary-600 dark:text-secondary-400" />}
              />
              <StatCard
                title="教师账户"
                value={overviewLoading === 'loading' ? '...' : formatNumber(overview?.teacher_count)}
                trend={formatTrend(overview?.trends.teachers_change)}
                trendUp={(overview?.trends.teachers_change ?? 0) >= 0}
                icon={<Users className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />}
              />
              <StatCard
                title="系统活跃度"
                value={overviewLoading === 'loading' ? '...' : `${overview?.active_rate ?? 0}%`}
                trend={formatTrend(overview?.trends.active_rate_change)}
                trendUp={(overview?.trends.active_rate_change ?? 0) >= 0}
                icon={<Activity className="h-5 w-5 text-orange-600 dark:text-orange-400" />}
              />
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
              {/* 最近活动 */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-xl">最近活动</CardTitle>
                </CardHeader>
                <CardContent>
                  {activitiesError ? (
                    <RequestErrorNotice
                      error={activitiesError}
                      onRetry={() => { void dispatch(fetchRecentActivities(10)); }}
                      onRefresh={() => { void dispatch(fetchRecentActivities(10)); }}
                    />
                  ) : activitiesLoading === 'loading' ? (
                    <div className="space-y-4">
                      {[1, 2, 3, 4].map((i) => (
                        <div key={i} className="flex items-start space-x-3 animate-pulse">
                          <div className="w-2 h-2 rounded-full mt-2 bg-surface-300 dark:bg-surface-600" />
                          <div className="flex-1 space-y-2">
                            <div className="h-4 bg-surface-200 dark:bg-surface-700 rounded w-3/4" />
                            <div className="h-3 bg-surface-200 dark:bg-surface-700 rounded w-1/4" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : recentActivities.length > 0 ? (
                    <div className="space-y-4">
                      {recentActivities.map((activity) => (
                        <ActivityItem
                          key={activity.id}
                          user={activity.user_name}
                          action={activity.action_display}
                          time={formatRelativeTime(activity.timestamp)}
                          type={activity.type}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8 text-surface-500 dark:text-surface-400">
                      暂无活动记录
                    </div>
                  )}
                </CardContent>
              </Card>
              {/* 用户增长图表 */}
              <Card>
                <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
                  <CardTitle className="text-xl">用户增长趋势</CardTitle>
                  <div className="flex gap-2">
                    {(['7d', '30d', '90d'] as UserGrowthPeriod[]).map((period) => (
                      <Button
                        key={period}
                        variant={userGrowthPeriod === period ? 'primary' : 'outline'}
                        size="sm"
                        onClick={() => handlePeriodChange(period)}
                      >
                        {period === '7d' ? '7 天' : period === '30d' ? '30 天' : '90 天'}
                      </Button>
                    ))}
                  </div>
                </CardHeader>
                <CardContent>
                  {userGrowthError ? (
                    <RequestErrorNotice
                      error={userGrowthError}
                      onRetry={() => { void dispatch(fetchUserGrowth(userGrowthPeriod)); }}
                      onRefresh={() => { void dispatch(fetchUserGrowth(userGrowthPeriod)); }}
                    />
                  ) : userGrowth?.data && userGrowth.data.length > 0 ? (
                    <>
                      <UserGrowthChart
                        data={userGrowth.data}
                        height={300}
                        loading={userGrowthLoading === 'loading'}
                      />
                      {userGrowth.summary && (
                        <div className="mt-4 flex flex-col justify-center gap-2 text-sm text-surface-600 dark:text-surface-400 sm:flex-row sm:gap-8">
                          <div>
                            <span className="font-medium">期间新增用户：</span>
                            <span className="ml-1 font-semibold text-primary-600 dark:text-primary-400">
                              {userGrowth.summary.total_new_users.toLocaleString()}
                            </span>
                          </div>
                          <div>
                            <span className="font-medium">日均增长：</span>
                            <span className="ml-1 font-semibold text-emerald-600 dark:text-emerald-400">
                              {userGrowth.summary.avg_daily_growth.toFixed(1)}
                            </span>
                          </div>
                        </div>
                      )}
                    </>
                  ) : userGrowthLoading === 'loading' ? (
                    <div className="flex h-64 items-center justify-center">
                      <div className="text-surface-500 dark:text-surface-400">加载中...</div>
                    </div>
                  ) : (
                    <div className="flex h-64 items-center justify-center rounded-lg border-2 border-dashed border-surface-200 bg-surface-50 dark:border-surface-700 dark:bg-surface-800">
                      <div className="text-center text-surface-500 dark:text-surface-400">暂无数据</div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* 安全日志弹窗 */}
      <SecurityLogModal
        isOpen={isSecurityLogModalOpen}
        onClose={() => setIsSecurityLogModalOpen(false)}
      />

      <ConfirmDialog
        isOpen={isResetMetricsDialogOpen}
        onClose={() => setIsResetMetricsDialogOpen(false)}
        onConfirm={() => { void handleResetTrafficMetrics(); }}
        loading={trafficResetLoading === 'loading'}
        title="重置累计指标？"
        message={
          <div className="space-y-3 text-sm leading-6">
            <p>确认后将立即开启新的运维统计窗口。</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>重置请求量、QPS、4xx/5xx 错误率、平均响应和 P95 响应。</li>
              <li>保留进程运行时间、在线人数、资源用量和依赖连接状态。</li>
              <li>不会删除用户、课程、学习会话、日志或任何数据库数据。</li>
            </ul>
            <p className="font-medium text-red-600 dark:text-red-400">本轮历史累计指标重置后不可恢复。</p>
            {trafficResetError ? <RequestErrorNotice error={trafficResetError} /> : null}
          </div>
        }
        confirmText="确认重置"
        confirmVariant="destructive"
        showIcon={false}
      />
    </AdminLayout>
  );
};

// 格式化相对时间
const formatRelativeTime = (timestamp: string): string => {
  const now = new Date();
  const time = new Date(timestamp);
  const diffMs = now.getTime() - time.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return '刚刚';
  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 7) return `${diffDays} 天前`;
  return time.toLocaleDateString('zh-CN');
};

// 活动项组件
const ActivityItem = ({ user, action, time, type }: {
  user: string;
  action: string;
  time: string;
  type: 'success' | 'info' | 'warning';
}) => {
  const colorMap = {
    success: 'bg-emerald-500',
    info: 'bg-blue-500',
    warning: 'bg-orange-500',
  };

  return (
    <div className="flex items-start space-x-3">
      <div className={`w-2 h-2 rounded-full mt-2 ${colorMap[type]}`} />
      <div className="flex-1">
        <div className="text-sm text-surface-900 dark:text-surface-100">
          <span className="font-medium">{user}</span> {action}
        </div>
        <div className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">{time}</div>
      </div>
    </div>
  );
};
