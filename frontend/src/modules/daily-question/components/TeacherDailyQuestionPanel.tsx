import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  CalendarDays,
  Loader2,
  RefreshCw,
  Target,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { RequestErrorNotice } from '@/components/feedback';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { Progress } from '@/components/ui/Progress';
import { useToast } from '@/components/ui/Toast';
import { toAppError, type AppError } from '@/libs/http/apiClient';
import { PersonalizedQuestionPool } from './PersonalizedQuestionPool';
import { UniformQuestionSchedule } from './UniformQuestionSchedule';
import { dailyQuestionService } from '../services/dailyQuestionService';
import { useShanghaiDate } from '../hooks/useShanghaiDate';
import type {
  DailyQuestionClassSettings,
  DailyQuestionClassStatistics,
  DailyQuestionClassStrategy,
} from '../types/dailyQuestion';

interface TeacherDailyQuestionPanelProps {
  classId: string;
}

function formatRate(value: number): string {
  return `${Math.max(0, Math.min(100, value)).toFixed(1)}%`;
}

function strategyLabel(strategy: DailyQuestionClassStrategy): string {
  return strategy === 'uniform' ? '班级统一题' : '学生个性化题';
}

export function TeacherDailyQuestionPanel({ classId }: TeacherDailyQuestionPanelProps) {
  const { toast } = useToast();
  const today = useShanghaiDate();
  const [selectedDate, setSelectedDate] = useState(today);
  const [settings, setSettings] = useState<DailyQuestionClassSettings | null>(null);
  const [statistics, setStatistics] = useState<DailyQuestionClassStatistics | null>(null);
  const [todayUniformAssigned, setTodayUniformAssigned] = useState(false);
  const [isLoadingSettings, setIsLoadingSettings] = useState(true);
  const [isLoadingStatistics, setIsLoadingStatistics] = useState(true);
  const [isSavingStrategy, setIsSavingStrategy] = useState(false);
  const [isSendingReminder, setIsSendingReminder] = useState(false);
  const [isSavingAutoReminder, setIsSavingAutoReminder] = useState(false);
  const [isAutoReminderConfirmOpen, setIsAutoReminderConfirmOpen] = useState(false);
  const [settingsError, setSettingsError] = useState<AppError | null>(null);
  const [statisticsError, setStatisticsError] = useState<AppError | null>(null);
  const settingsRequestRef = useRef(0);
  const statisticsRequestRef = useRef(0);
  const settingsMutationRef = useRef(false);

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    const requestID = settingsRequestRef.current + 1;
    settingsRequestRef.current = requestID;
    setIsLoadingSettings(true);
    setSettingsError(null);
    try {
      const nextSettings = await dailyQuestionService.getClassSettings(classId, signal);
      if (signal?.aborted || settingsRequestRef.current !== requestID) return;
      setSettings(nextSettings);
    } catch (loadError) {
      if (signal?.aborted || settingsRequestRef.current !== requestID) return;
      setSettingsError(toAppError(loadError, '每日一题设置加载失败'));
    } finally {
      if (!signal?.aborted && settingsRequestRef.current === requestID) {
        setIsLoadingSettings(false);
      }
    }
  }, [classId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadSettings(controller.signal);
    return () => controller.abort();
  }, [loadSettings, today]);

  const loadStatistics = useCallback(async (signal?: AbortSignal) => {
    const requestID = statisticsRequestRef.current + 1;
    statisticsRequestRef.current = requestID;
    setIsLoadingStatistics(true);
    setStatisticsError(null);
    setStatistics(null);
    try {
      const nextStatistics = await dailyQuestionService.getClassStatistics(
        classId,
        selectedDate,
        signal,
      );
      if (signal?.aborted || statisticsRequestRef.current !== requestID) return;
      setStatistics(nextStatistics);
    } catch (loadError) {
      if (signal?.aborted || statisticsRequestRef.current !== requestID) return;
      setStatisticsError(toAppError(loadError, '每日一题统计加载失败'));
    } finally {
      if (!signal?.aborted && statisticsRequestRef.current === requestID) {
        setIsLoadingStatistics(false);
      }
    }
  }, [classId, selectedDate]);

  useEffect(() => {
    const controller = new AbortController();
    void loadStatistics(controller.signal);
    return () => controller.abort();
  }, [loadStatistics]);

  useEffect(() => {
    setSelectedDate(today);
    setTodayUniformAssigned(false);
  }, [today]);

  const reloadData = useCallback(async () => {
    await Promise.all([loadSettings(), loadStatistics()]);
  }, [loadSettings, loadStatistics]);

  const notifyRequestError = useCallback((error: unknown, fallback: string) => {
    const appError = toAppError(error, fallback);
    if (appError.kind === 'cancelled' || appError.kind === 'rate_limited') return;
    const details = [
      appError.retryAfter !== undefined && appError.retryAfter > 0
        ? `可在 ${appError.retryAfter} 秒后重试`
        : '',
      appError.requestId ? `请求编号：${appError.requestId}` : '',
    ].filter(Boolean);
    toast({
      type: 'error',
      title: appError.message,
      description: details.length > 0 ? details.join('；') : undefined,
    });
  }, [toast]);

  const updateStrategy = async (strategy: DailyQuestionClassStrategy) => {
    if (settingsMutationRef.current || !settings) return;
    if (settings.strategy === strategy) return;
    settingsMutationRef.current = true;
    const requestID = settingsRequestRef.current + 1;
    settingsRequestRef.current = requestID;
    setIsSavingStrategy(true);
    try {
      const nextSettings = await dailyQuestionService.setClassSettings(classId, strategy);
      if (settingsRequestRef.current === requestID) {
        setSettings(nextSettings);
      }
      toast({
        type: 'success',
        title: nextSettings.strategy === nextSettings.effectiveStrategy
          ? `已切换为${strategyLabel(nextSettings.strategy)}`
          : `${nextSettings.effectiveDate} 起切换为${strategyLabel(nextSettings.strategy)}`,
      });
    } catch (saveError) {
      notifyRequestError(saveError, '分配策略保存失败');
    } finally {
      settingsMutationRef.current = false;
      setIsSavingStrategy(false);
      if (settingsRequestRef.current === requestID) {
        setIsLoadingSettings(false);
      }
    }
  };

  const displayedStrategy = settings?.strategy;
  const showUniformSchedule = settings
    ? settings.strategy === 'uniform'
      || settings.effectiveStrategy === 'uniform'
    : false;
  const todayUniformReady = todayUniformAssigned || Boolean(settings?.uniformReady);

  const sendReminder = async () => {
    if (isSendingReminder || settingsMutationRef.current) return;
    settingsMutationRef.current = true;
    const requestID = settingsRequestRef.current + 1;
    settingsRequestRef.current = requestID;
    setIsSendingReminder(true);
    try {
      const result = await dailyQuestionService.sendClassReminder(classId, selectedDate);
      const currentReminderTotal = settings?.todayReminderRecipientCount ?? 0;
      const nextReminderTotal = currentReminderTotal + result.recipientCount;
      if (selectedDate === today && result.recipientCount > 0) {
        setSettings((current) => current
          ? {
              ...current,
              todayReminderSent: true,
              todayReminderRecipientCount: current.todayReminderRecipientCount + result.recipientCount,
            }
          : current);
      }
      toast({
        type: 'success',
        title: result.recipientCount > 0
          ? `本次已创建 ${result.recipientCount} 条公众号提醒`
          : '本次没有新增公众号提醒',
        description: `今日累计提醒 ${nextReminderTotal} 人次。`,
      });
    } catch (reminderError) {
      notifyRequestError(reminderError, '提醒发送失败');
    } finally {
      settingsMutationRef.current = false;
      setIsSendingReminder(false);
      if (settingsRequestRef.current === requestID) {
        setIsLoadingSettings(false);
      }
    }
  };

  const updateAutoReminder = async (enabled: boolean) => {
    if (!settings || settingsMutationRef.current) return;
    settingsMutationRef.current = true;
    const requestID = settingsRequestRef.current + 1;
    settingsRequestRef.current = requestID;
    setIsSavingAutoReminder(true);
    try {
      const nextSettings = await dailyQuestionService.setClassAutoReminder(classId, enabled);
      if (settingsRequestRef.current === requestID) {
        setSettings(nextSettings);
        setIsAutoReminderConfirmOpen(false);
      }
      toast({
        type: 'success',
        title: enabled ? '已开启每日自动提醒' : '已关闭每日自动提醒',
        description: enabled
          ? nextSettings.todayReminderSent
            ? `今天已创建公众号提醒，累计 ${nextSettings.todayReminderRecipientCount} 人次。`
            : '每天 08:00（北京时间）仅通过微信公众号提醒未完成学生；今天暂无可发送的提醒。'
          : '关闭后不再发送每日一题自动提醒。',
      });
    } catch (saveError) {
      notifyRequestError(saveError, '自动提醒设置保存失败');
    } finally {
      settingsMutationRef.current = false;
      setIsSavingAutoReminder(false);
      if (settingsRequestRef.current === requestID) {
        setIsLoadingSettings(false);
      }
    }
  };

  if (isLoadingSettings && !settings) {
    return (
      <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-surface-500 dark:text-surface-400">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        正在加载每日一题数据
      </div>
    );
  }

  if (settingsError && !settings) {
    return (
      <div className="min-h-56 py-6">
        <RequestErrorNotice
          error={settingsError}
          onRetry={() => void loadSettings()}
          onRefresh={() => void loadSettings()}
        />
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-3 border-b border-surface-200 pb-5 dark:border-surface-700 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 font-semibold text-surface-900 dark:text-surface-100">
            <CalendarDays className="h-5 w-5 text-primary-500" aria-hidden="true" />
            每日题统计
          </h3>
          <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">
            {isLoadingStatistics
              ? '正在加载统计'
              : statistics
                ? `${statistics.completedCount}/${statistics.studentCount} 人已完成`
                : '统计暂不可用'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="daily-question-statistics-date" className="sr-only">统计日期</label>
          <Input
            id="daily-question-statistics-date"
            type="date"
            value={selectedDate}
            max={today}
            onChange={(event) => setSelectedDate(event.target.value || today)}
            className="w-40"
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="刷新每日题统计"
            title="刷新"
            disabled={isLoadingStatistics}
            onClick={() => void loadStatistics()}
          >
            <RefreshCw className={`h-4 w-4 ${isLoadingStatistics ? 'animate-spin' : ''}`} aria-hidden="true" />
          </Button>
        </div>
      </div>

      {settingsError ? (
        <RequestErrorNotice
          error={settingsError}
          onRetry={() => void loadSettings()}
          onRefresh={() => void loadSettings()}
        />
      ) : null}

      <div>
        <h3 className="mb-3 text-sm font-medium text-surface-700 dark:text-surface-300">题目分配</h3>
        <div className="inline-flex rounded-md" role="group" aria-label="每日题分配策略">
          <Button
            variant={displayedStrategy === 'personalized' ? 'primary' : 'outline'}
            className="rounded-r-none"
            aria-pressed={displayedStrategy === 'personalized'}
            disabled={isSavingStrategy || isSavingAutoReminder}
            onClick={() => void updateStrategy('personalized')}
          >
            学生个性化题
          </Button>
          <Button
            variant={displayedStrategy === 'uniform' ? 'primary' : 'outline'}
            className="-ml-px rounded-l-none"
            aria-pressed={displayedStrategy === 'uniform'}
            disabled={isSavingStrategy || isSavingAutoReminder}
            onClick={() => void updateStrategy('uniform')}
          >
            班级统一题
          </Button>
        </div>
        {settings && settings.strategy !== settings.effectiveStrategy ? (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            今日已有 {settings.todayAssignmentCount} 人获得题目，今天继续使用
            {strategyLabel(settings.effectiveStrategy)}；{settings.effectiveDate} 起切换为
            {strategyLabel(settings.strategy)}。
          </p>
        ) : null}
      </div>

      {showUniformSchedule ? (
        <UniformQuestionSchedule
          classId={classId}
          onSaved={() => void reloadData()}
          onTodayAssignedChange={setTodayUniformAssigned}
        />
      ) : null}

      {settings?.strategy === 'personalized'
        && settings.effectiveStrategy === 'personalized' ? (
        <PersonalizedQuestionPool classId={classId} />
      ) : null}

      {settings ? (
        <div className="border-y border-surface-200 py-4 dark:border-surface-700">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-surface-700 dark:text-surface-300">自动提醒</h3>
              <p id="daily-question-auto-reminder-description" className="mt-1 text-sm text-surface-500 dark:text-surface-400">
                每天 08:00（北京时间）仅通过微信公众号提醒当天未完成的学生，不会发送站内通知。当天没有可作答题目时不发送；今天开启且尚未发送时会立即尝试发送。
              </p>
              {settings.effectiveStrategy === 'uniform' ? (
                <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">
                  班级统一题可用题目仅剩 1 道时，系统也只会通过微信公众号提醒您补充题目。
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-sm text-surface-500 dark:text-surface-400">
                {settings.autoReminderEnabled
                  ? settings.todayReminderSent
                    ? `今日累计 ${settings.todayReminderRecipientCount} 人次`
                    : '今日尚未发送'
                  : '已关闭'}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={settings.autoReminderEnabled}
                aria-describedby="daily-question-auto-reminder-description"
                aria-label="切换每日一题自动提醒"
                disabled={isSavingAutoReminder || isSavingStrategy}
                onClick={() => {
                  if (settings.autoReminderEnabled) {
                    void updateAutoReminder(false);
                    return;
                  }
                  setIsAutoReminderConfirmOpen(true);
                }}
                className={`relative h-6 w-11 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:ring-offset-surface-900 ${
                  settings.autoReminderEnabled ? 'bg-primary-600' : 'bg-surface-300 dark:bg-surface-700'
                }`}
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                    settings.autoReminderEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {statisticsError ? (
        <RequestErrorNotice
          error={statisticsError}
          onRetry={() => void loadStatistics()}
          onRefresh={() => void loadStatistics()}
        />
      ) : null}

      {isLoadingStatistics && !statistics ? (
        <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-surface-500 dark:text-surface-400">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          正在加载每日题统计
        </div>
      ) : null}

      {statistics ? (
        <>
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-surface-200 bg-surface-200 dark:border-surface-700 dark:bg-surface-700 sm:grid-cols-3">
            {[
              { label: '完成率', value: statistics.completionRate, variant: 'default' as const },
              { label: '首次正确率', value: statistics.firstCorrectRate, variant: 'success' as const },
              { label: '订正率', value: statistics.correctionRate, variant: 'warning' as const },
            ].map((metric) => (
              <div key={metric.label} className="bg-white p-4 dark:bg-surface-900">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-surface-500 dark:text-surface-400">{metric.label}</span>
                  <strong className="text-xl text-surface-900 dark:text-surface-100">{formatRate(metric.value)}</strong>
                </div>
                <Progress value={metric.value} variant={metric.variant} size="sm" className="mt-3" />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="border-r border-surface-200 px-2 dark:border-surface-700">
              <div className="text-xl font-semibold text-surface-900 dark:text-surface-100">{statistics.assignedCount}</div>
              <div className="text-xs text-surface-500 dark:text-surface-400">已分配</div>
            </div>
            <div className="border-r border-surface-200 px-2 dark:border-surface-700">
              <div className="text-xl font-semibold text-surface-900 dark:text-surface-100">{statistics.firstCorrectCount}</div>
              <div className="text-xs text-surface-500 dark:text-surface-400">首次答对</div>
            </div>
            <div className="px-2">
              <div className="text-xl font-semibold text-surface-900 dark:text-surface-100">{statistics.correctedCount}</div>
              <div className="text-xs text-surface-500 dark:text-surface-400">已订正</div>
            </div>
          </div>

          <div>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-surface-700 dark:text-surface-300">
              <Target className="h-4 w-4 text-amber-500" aria-hidden="true" />
              薄弱知识点
            </h3>
            {statistics.weakConcepts.length > 0 ? (
              <div className="divide-y divide-surface-200 border-y border-surface-200 dark:divide-surface-700 dark:border-surface-700">
                {statistics.weakConcepts.map((concept) => (
                  <div key={concept.conceptId} className="flex items-center justify-between gap-3 py-3">
                    <span className="min-w-0 truncate text-sm text-surface-700 dark:text-surface-300">{concept.conceptName}</span>
                    <span className="shrink-0 text-sm font-medium text-red-600 dark:text-red-400">{concept.wrongCount} 次答错</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-3 text-sm text-surface-500 dark:text-surface-400">暂无薄弱知识点数据</p>
            )}
          </div>

        </>
      ) : null}

      {settings ? (
        <div className="space-y-2 border-t border-surface-200 pt-5 dark:border-surface-700">
          <div className="flex justify-end">
            <Button
              variant="outline"
              isLoading={isSendingReminder}
              disabled={
                selectedDate !== today
                || isSavingStrategy
                || isSavingAutoReminder
                || (settings.effectiveStrategy === 'uniform' && !todayUniformReady)
              }
              title={
                selectedDate !== today
                  ? '仅支持提醒今日未完成学生'
                  : settings.effectiveStrategy === 'uniform' && !todayUniformReady
                    ? '请先布置今日统一题'
                    : '可重复创建微信公众号提醒'
              }
              onClick={() => void sendReminder()}
            >
              {!isSendingReminder ? <Bell className="mr-2 h-4 w-4" aria-hidden="true" /> : null}
              通过公众号提醒未完成学生
            </Button>
          </div>
          <p className="text-right text-xs text-surface-500 dark:text-surface-400">
            可重复提醒；今日累计 {settings.todayReminderRecipientCount} 人次。仅发送微信公众号提醒，不会创建站内通知。
          </p>
        </div>
      ) : null}

      <ConfirmDialog
        isOpen={isAutoReminderConfirmOpen}
        onClose={() => setIsAutoReminderConfirmOpen(false)}
        onConfirm={() => void updateAutoReminder(true)}
        loading={isSavingAutoReminder}
        title="开启每日自动提醒"
        message="开启后，系统会在每天 08:00（北京时间）仅通过微信公众号提醒当天未完成每日一题的学生，不会发送站内通知。若今天有可作答题目且尚未发送提醒，将立即尝试发送。"
        confirmText="开启提醒"
        confirmVariant="primary"
        showIcon={false}
      />
    </section>
  );
}
