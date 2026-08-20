import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Gauge,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  UnlockKeyhole,
  Users,
  X,
} from 'lucide-react';
import { AdminLayout } from '@/modules/admin/components/AdminLayout';
import { aiRiskService } from '@/modules/admin/services/aiRiskService';
import { aiConfigService } from '@/modules/ai-config/services/aiConfigService';
import { AgentTypes } from '@/modules/ai-config/types/aiConfig';
import type {
  AIModelReviewCategory,
  AIModelReviewThresholds,
  AIRiskEvent,
  AIRiskEventListResponse,
  AIRiskEventType,
  AIRiskOverview,
  AIRiskSettings,
  AIStudentItem,
  AIStudentListResponse,
  AIStudentStatusFilter,
  UpdateAIRiskSettingsRequest,
} from '@/modules/admin/types/aiRisk';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Progress } from '@/components/ui/Progress';
import { Select } from '@/components/ui/Select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { isAdminRequestCancelled, toAdminAppError } from '@/modules/admin/utils/errorFeedback';

type ViewTab = 'policy' | 'students' | 'events';
type ModeratorConfigStatus = 'loading' | 'configured' | 'missing' | 'error';

const modelReviewCategoryOrder: AIModelReviewCategory[] = [
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'sexual',
  'sexual/minors',
  'violence',
  'violence/graphic',
];

const defaultModelReviewThresholds: AIModelReviewThresholds = {
  harassment: 0.98,
  'harassment/threatening': 0.9,
  hate: 0.65,
  'hate/threatening': 0.65,
  illicit: 0.95,
  'illicit/violent': 0.95,
  'self-harm': 0.65,
  'self-harm/intent': 0.85,
  'self-harm/instructions': 0.65,
  sexual: 0.65,
  'sexual/minors': 0.65,
  violence: 0.95,
  'violence/graphic': 0.95,
};

const modelReviewCategoryLabels: Record<AIModelReviewCategory, string> = {
  harassment: '骚扰',
  'harassment/threatening': '威胁性骚扰',
  hate: '仇恨',
  'hate/threatening': '威胁性仇恨',
  illicit: '违法活动',
  'illicit/violent': '暴力违法',
  'self-harm': '自残',
  'self-harm/intent': '自残意图',
  'self-harm/instructions': '自残指导',
  sexual: '性内容',
  'sexual/minors': '未成年人性内容',
  violence: '暴力',
  'violence/graphic': '血腥暴力',
};

interface SettingsDraft {
  dailyReplyLimit: number;
  maxConcurrentRequests: number;
  blockedKeywords: string;
  modelReviewEnabled: boolean;
  modelReviewThresholds: AIModelReviewThresholds;
}

const emptySettingsDraft: SettingsDraft = {
  dailyReplyLimit: 50,
  maxConcurrentRequests: 2,
  blockedKeywords: '',
  modelReviewEnabled: false,
  modelReviewThresholds: { ...defaultModelReviewThresholds },
};

const emptyStudentPage: AIStudentListResponse = {
  items: [],
  total: 0,
  page: 1,
  page_size: 20,
  total_pages: 0,
};

const emptyEventPage: AIRiskEventListResponse = {
  items: [],
  total: 0,
  page: 1,
  page_size: 20,
  total_pages: 0,
};

export const AIRiskControlPage: React.FC = () => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<ViewTab>('policy');
  const [overview, setOverview] = useState<AIRiskOverview | null>(null);
  const [settings, setSettings] = useState<AIRiskSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>(emptySettingsDraft);
  const [students, setStudents] = useState<AIStudentListResponse>(emptyStudentPage);
  const [events, setEvents] = useState<AIRiskEventListResponse>(emptyEventPage);
  const [studentPage, setStudentPage] = useState(1);
  const [studentSearch, setStudentSearch] = useState('');
  const [studentStatus, setStudentStatus] = useState<AIStudentStatusFilter>('all');
  const [eventPage, setEventPage] = useState(1);
  const [eventSearch, setEventSearch] = useState('');
  const [eventType, setEventType] = useState<AIRiskEventType | 'all'>('all');
  const [loading, setLoading] = useState({ summary: true, students: true, events: true, save: false });
  const [validationError, setValidationError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<AppError | null>(null);
  const [studentsError, setStudentsError] = useState<AppError | null>(null);
  const [eventsError, setEventsError] = useState<AppError | null>(null);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [moderatorError, setModeratorError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [accessTarget, setAccessTarget] = useState<AIStudentItem | null>(null);
  const [accessReason, setAccessReason] = useState('');
  const [accessLoading, setAccessLoading] = useState(false);
  const [moderatorStatus, setModeratorStatus] = useState<ModeratorConfigStatus>('loading');

  const applySettings = useCallback((value: AIRiskSettings) => {
    setSettings(value);
    setSettingsDraft({
      dailyReplyLimit: value.daily_reply_limit,
      maxConcurrentRequests: value.max_concurrent_requests,
      blockedKeywords: value.blocked_keywords.join('\n'),
      modelReviewEnabled: value.model_review_enabled ?? false,
      modelReviewThresholds: {
        ...defaultModelReviewThresholds,
        ...(value.model_review_thresholds ?? {}),
      },
    });
  }, []);

  const loadModeratorStatus = useCallback(async (signal?: AbortSignal) => {
    setModeratorStatus('loading');
    setModeratorError(null);
    try {
      const response = await aiConfigService.listAgentTypes(signal);
      if (signal?.aborted) return;
      const moderator = response.items.find((item) => item.type === AgentTypes.CONTENT_MODERATOR);
      setModeratorStatus(moderator?.configured ? 'configured' : 'missing');
    } catch (loadError) {
      if (!signal?.aborted && !isAdminRequestCancelled(loadError)) {
        setModeratorStatus('error');
        setModeratorError(toAdminAppError(loadError, '加载内容审核模型状态失败'));
      }
    }
  }, []);

  const loadSummary = useCallback(async (signal?: AbortSignal) => {
    setLoading((current) => ({ ...current, summary: true }));
    setSummaryError(null);
    try {
      const [overviewResponse, settingsResponse] = await Promise.all([
        aiRiskService.getOverview(signal),
        aiRiskService.getSettings(signal),
      ]);
      if (signal?.aborted) return;
      setOverview(overviewResponse);
      applySettings(settingsResponse);
    } catch (loadError) {
      if (signal?.aborted || isAdminRequestCancelled(loadError)) return;
      setSummaryError(toAdminAppError(loadError, '加载风控概览失败'));
    } finally {
      if (!signal?.aborted) setLoading((current) => ({ ...current, summary: false }));
    }
  }, [applySettings]);

  const loadStudents = useCallback(async (signal?: AbortSignal) => {
    setLoading((current) => ({ ...current, students: true }));
    setStudentsError(null);
    try {
      const response = await aiRiskService.listStudents({
        page: studentPage,
        page_size: 20,
        search: studentSearch.trim() || undefined,
        status: studentStatus,
      }, signal);
      if (signal?.aborted) return;
      setStudents(response);
    } catch (loadError) {
      if (signal?.aborted || isAdminRequestCancelled(loadError)) return;
      setStudentsError(toAdminAppError(loadError, '加载学生 AI 状态失败'));
    } finally {
      if (!signal?.aborted) setLoading((current) => ({ ...current, students: false }));
    }
  }, [studentPage, studentSearch, studentStatus]);

  const loadEvents = useCallback(async (signal?: AbortSignal) => {
    setLoading((current) => ({ ...current, events: true }));
    setEventsError(null);
    try {
      const response = await aiRiskService.listEvents({
        page: eventPage,
        page_size: 20,
        search: eventSearch.trim() || undefined,
        event_type: eventType,
      }, signal);
      if (signal?.aborted) return;
      setEvents(response);
    } catch (loadError) {
      if (signal?.aborted || isAdminRequestCancelled(loadError)) return;
      setEventsError(toAdminAppError(loadError, '加载风控事件失败'));
    } finally {
      if (!signal?.aborted) setLoading((current) => ({ ...current, events: false }));
    }
  }, [eventPage, eventSearch, eventType]);

  useEffect(() => {
    const controller = new AbortController();
    void loadSummary(controller.signal);
    return () => controller.abort();
  }, [loadSummary]);

  useEffect(() => {
    const controller = new AbortController();
    void loadModeratorStatus(controller.signal);
    return () => controller.abort();
  }, [loadModeratorStatus]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadStudents(controller.signal), 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadStudents]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadEvents(controller.signal), 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadEvents]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadSummary(), loadStudents(), loadEvents(), loadModeratorStatus()]);
  }, [loadEvents, loadModeratorStatus, loadStudents, loadSummary]);

  const saveSettings = async () => {
    const request: UpdateAIRiskSettingsRequest = {
      daily_reply_limit: settingsDraft.dailyReplyLimit,
      max_concurrent_requests: settingsDraft.maxConcurrentRequests,
      blocked_keywords: settingsDraft.blockedKeywords
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean),
      model_review_enabled: settingsDraft.modelReviewEnabled,
      model_review_thresholds: settingsDraft.modelReviewThresholds,
    };
    if (request.daily_reply_limit < 1 || request.daily_reply_limit > 10_000) {
      setValidationError('每日回复额度必须在 1 到 10000 之间');
      return;
    }
    if (request.max_concurrent_requests < 1 || request.max_concurrent_requests > 20) {
      setValidationError('每生并发上限必须在 1 到 20 之间');
      return;
    }
    if (request.model_review_enabled && moderatorStatus !== 'configured') {
      setValidationError('请先在 AI 模型设置中配置内容审核智能体');
      return;
    }
    if (Object.values(request.model_review_thresholds).some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
      setValidationError('模型审查阈值必须在 0 到 1 之间');
      return;
    }
    setLoading((current) => ({ ...current, save: true }));
    setValidationError(null);
    setActionError(null);
    try {
      const response = await aiRiskService.updateSettings(request);
      applySettings(response);
      setOverview((current) => current ? {
        ...current,
        daily_reply_limit: response.daily_reply_limit,
        max_concurrent_requests: response.max_concurrent_requests,
      } : current);
      setNotice('风控策略已保存');
      await loadStudents();
    } catch (saveError) {
      if (!isAdminRequestCancelled(saveError)) {
        setActionError(toAdminAppError(saveError, '保存风控策略失败'));
      }
    } finally {
      setLoading((current) => ({ ...current, save: false }));
    }
  };

  const submitAccessChange = async () => {
    if (!accessTarget) return;
    const shouldBlock = !accessTarget.ai_blocked;
    const reason = accessReason.trim();
    if (shouldBlock && !reason) {
      setValidationError('请输入封禁原因');
      return;
    }
    setAccessLoading(true);
    setValidationError(null);
    setActionError(null);
    try {
      await aiRiskService.updateStudentAccess(accessTarget.id, { blocked: shouldBlock, reason });
      setNotice(shouldBlock ? '学生 AI 权限已封禁' : '学生 AI 权限已恢复');
      setAccessTarget(null);
      setAccessReason('');
      await Promise.all([loadSummary(), loadStudents(), loadEvents()]);
    } catch (accessError) {
      if (!isAdminRequestCancelled(accessError)) {
        setActionError(toAdminAppError(accessError, '更新学生 AI 权限失败'));
      }
    } finally {
      setAccessLoading(false);
    }
  };

  const metrics = useMemo(() => [
    {
      label: '学生总数',
      value: overview?.total_students ?? 0,
      icon: Users,
      iconClass: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
    },
    {
      label: '今日 AI 回复',
      value: overview?.replies_today ?? 0,
      icon: MessageSquareText,
      iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    },
    {
      label: '额度耗尽',
      value: overview?.quota_exhausted_students ?? 0,
      icon: Gauge,
      iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    },
    {
      label: 'AI 已封禁',
      value: overview?.blocked_students ?? 0,
      icon: Ban,
      iconClass: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    },
    {
      label: '今日风险事件',
      value: overview?.risk_events_today ?? 0,
      icon: AlertTriangle,
      iconClass: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
    },
  ], [overview]);

  return (
    <AdminLayout>
      <div className="space-y-6" data-testid="ai-risk-control-page">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-surface-950 dark:text-surface-50">风控中心</h1>
              <p className="text-sm text-surface-500 dark:text-surface-400">
                {settings ? `额度重置 ${formatDateTime(settings.next_reset_at)}` : '加载策略中'}
              </p>
            </div>
          </div>
          <Button variant="outline" size="icon" onClick={() => void refreshAll()} title="刷新风控数据" aria-label="刷新风控数据">
            <RefreshCw className={`h-4 w-4 ${loading.summary ? 'animate-spin' : ''}`} />
          </Button>
        </header>

        {summaryError ? (
          <RequestErrorNotice
            error={summaryError}
            onRetry={() => void loadSummary()}
            onRefresh={() => void loadSummary()}
          />
        ) : null}

        {moderatorError ? (
          <RequestErrorNotice
            error={moderatorError}
            onRetry={() => void loadModeratorStatus()}
            onRefresh={() => void loadModeratorStatus()}
            onDismiss={() => setModeratorError(null)}
          />
        ) : null}

        {actionError ? (
          <RequestErrorNotice
            error={actionError}
            onRetry={() => accessTarget ? void submitAccessChange() : void saveSettings()}
            onRefresh={() => void refreshAll()}
            onDismiss={() => setActionError(null)}
          />
        ) : null}

        {(validationError || notice) && (
          <div
            role="status"
            className={`flex items-center justify-between rounded-lg border px-4 py-3 text-sm ${
              validationError
                ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200'
                : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
            }`}
          >
            <span>{validationError ?? notice}</span>
            <button
              type="button"
              className="rounded-md p-1 hover:bg-black/5"
              onClick={() => { setValidationError(null); setNotice(null); }}
              aria-label="关闭提示"
              title="关闭提示"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="风控概览">
          {metrics.map((metric) => (
            <Card key={metric.label} className="min-h-28 shadow-none">
              <CardContent className="flex h-full items-center gap-4 p-5">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${metric.iconClass}`}>
                  <metric.icon className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm text-surface-500 dark:text-surface-400">{metric.label}</div>
                  <div className="mt-1 text-2xl font-semibold text-surface-950 dark:text-surface-50">
                    {loading.summary ? '-' : metric.value.toLocaleString('zh-CN')}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>

        <Tabs value={activeTab} defaultValue="policy" onValueChange={(value) => setActiveTab(value as ViewTab)} keepMounted={false}>
          <div className="overflow-x-auto pb-1">
            <TabsList className="min-w-max">
              <TabsTrigger value="policy"><Gauge className="mr-2 h-4 w-4" />统一策略</TabsTrigger>
              <TabsTrigger value="students"><Users className="mr-2 h-4 w-4" />学生控制</TabsTrigger>
              <TabsTrigger value="events"><AlertTriangle className="mr-2 h-4 w-4" />风险事件</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="policy" className="mt-4">
            <PolicyPanel
              draft={settingsDraft}
              loading={loading.save || loading.summary}
              moderatorStatus={moderatorStatus}
              onChange={setSettingsDraft}
              onSave={() => void saveSettings()}
              onConfigureModerator={() => navigate('/admin/ai-models')}
            />
          </TabsContent>

          <TabsContent value="students" className="mt-4">
            {studentsError ? (
              <RequestErrorNotice
                error={studentsError}
                onRetry={() => void loadStudents()}
                onRefresh={() => void loadStudents()}
                className="mb-4"
              />
            ) : null}
            <StudentsPanel
              data={students}
              loading={loading.students}
              dailyLimit={settings?.daily_reply_limit ?? overview?.daily_reply_limit ?? 1}
              search={studentSearch}
              status={studentStatus}
              onSearch={(value) => { setStudentSearch(value); setStudentPage(1); }}
              onStatus={(value) => { setStudentStatus(value); setStudentPage(1); }}
              onPage={setStudentPage}
              onAccess={(student) => { setAccessTarget(student); setAccessReason(''); }}
            />
          </TabsContent>

          <TabsContent value="events" className="mt-4">
            {eventsError ? (
              <RequestErrorNotice
                error={eventsError}
                onRetry={() => void loadEvents()}
                onRefresh={() => void loadEvents()}
                className="mb-4"
              />
            ) : null}
            <EventsPanel
              data={events}
              loading={loading.events}
              search={eventSearch}
              eventType={eventType}
              onSearch={(value) => { setEventSearch(value); setEventPage(1); }}
              onEventType={(value) => { setEventType(value); setEventPage(1); }}
              onPage={setEventPage}
            />
          </TabsContent>
        </Tabs>
      </div>

      <AccessDialog
        student={accessTarget}
        reason={accessReason}
        loading={accessLoading}
        onReason={setAccessReason}
        onClose={() => { setAccessTarget(null); setAccessReason(''); }}
        onConfirm={() => void submitAccessChange()}
      />
    </AdminLayout>
  );
};

function PolicyPanel({
  draft,
  loading,
  moderatorStatus,
  onChange,
  onSave,
  onConfigureModerator,
}: {
  draft: SettingsDraft;
  loading: boolean;
  moderatorStatus: ModeratorConfigStatus;
  onChange: (value: SettingsDraft) => void;
  onSave: () => void;
  onConfigureModerator: () => void;
}) {
  const statusConfig: Record<ModeratorConfigStatus, { label: string; variant: 'secondary' | 'success' | 'warning' | 'destructive' }> = {
    loading: { label: '检查中', variant: 'secondary' },
    configured: { label: '审核模型已配置', variant: 'success' },
    missing: { label: '审核模型未配置', variant: 'warning' },
    error: { label: '配置状态不可用', variant: 'destructive' },
  };
  const currentStatus = statusConfig[moderatorStatus];
  return (
    <section className="rounded-lg border border-surface-200 bg-white p-5 dark:border-surface-700 dark:bg-surface-900">
      <div className="flex flex-col gap-4 border-b border-surface-200 pb-5 dark:border-surface-700 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-surface-950 dark:text-surface-50">统一学生策略</h2>
          <div className="mt-1 flex items-center gap-2 text-sm text-surface-500 dark:text-surface-400">
            <Clock3 className="h-4 w-4" />
            <span>每日 00:00（Asia/Shanghai）重置</span>
          </div>
        </div>
        <Button onClick={onSave} isLoading={loading}>
          <Save className="mr-2 h-4 w-4" />保存策略
        </Button>
      </div>

      <div className="grid gap-5 py-5 md:grid-cols-2">
        <label className="space-y-2" htmlFor="daily-reply-limit">
          <span className="text-sm font-medium text-surface-800 dark:text-surface-200">每生每日 AI 回复额度</span>
          <Input
            id="daily-reply-limit"
            type="number"
            min={1}
            max={10000}
            value={draft.dailyReplyLimit}
            onChange={(event) => onChange({ ...draft, dailyReplyLimit: Number(event.target.value) })}
            disabled={loading}
          />
        </label>
        <label className="space-y-2" htmlFor="max-concurrent-requests">
          <span className="text-sm font-medium text-surface-800 dark:text-surface-200">每生 AI 并发上限</span>
          <Input
            id="max-concurrent-requests"
            type="number"
            min={1}
            max={20}
            value={draft.maxConcurrentRequests}
            onChange={(event) => onChange({ ...draft, maxConcurrentRequests: Number(event.target.value) })}
            disabled={loading}
          />
        </label>
      </div>

      <label className="block space-y-2" htmlFor="blocked-keywords">
        <span className="flex items-center justify-between text-sm font-medium text-surface-800 dark:text-surface-200">
          <span>风险关键词</span>
          <span className="font-normal text-surface-500 dark:text-surface-400">每行一个</span>
        </span>
        <textarea
          id="blocked-keywords"
          value={draft.blockedKeywords}
          onChange={(event) => onChange({ ...draft, blockedKeywords: event.target.value })}
          disabled={loading}
          rows={8}
          className="w-full resize-y rounded-md border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50 dark:border-surface-700 dark:bg-surface-800 dark:text-surface-100"
        />
      </label>

      <div className="mt-6 border-t border-surface-200 pt-5 dark:border-surface-700">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300">
              <BrainCircuit className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-surface-950 dark:text-surface-50">模型内容审查</h3>
                <Badge variant={currentStatus.variant}>{currentStatus.label}</Badge>
                <Badge variant="outline">前置阻断</Badge>
                <Badge variant="outline">失败关闭</Badge>
              </div>
              <div className="mt-1 text-sm text-surface-500 dark:text-surface-400">
                OpenAI-compatible Moderations
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={onConfigureModerator}>
              <Settings2 className="mr-2 h-4 w-4" />配置审核模型
            </Button>
            <button
              type="button"
              role="switch"
              aria-checked={draft.modelReviewEnabled}
              aria-label="启用模型内容审查"
              title={draft.modelReviewEnabled ? '关闭模型内容审查' : '启用模型内容审查'}
              disabled={loading}
              onClick={() => onChange({ ...draft, modelReviewEnabled: !draft.modelReviewEnabled })}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50 ${
                draft.modelReviewEnabled ? 'bg-primary-600' : 'bg-surface-300 dark:bg-surface-600'
              }`}
            >
              <span
                className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                  draft.modelReviewEnabled ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>

        <fieldset className="mt-5" disabled={loading}>
          <legend className="sr-only">模型审查风险分类阈值</legend>
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-surface-800 dark:text-surface-200">风险分类阈值</span>
            <span className="text-xs text-surface-500 dark:text-surface-400">0 - 1</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {modelReviewCategoryOrder.map((category) => (
              <label
                key={category}
                className="grid min-h-20 grid-cols-[minmax(0,1fr)_7rem] items-center gap-3 rounded-md border border-surface-200 px-3 py-2 dark:border-surface-700"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-surface-800 dark:text-surface-200">
                    {modelReviewCategoryLabels[category]}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-surface-400" title={category}>{category}</span>
                </span>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={draft.modelReviewThresholds[category]}
                  aria-label={`${modelReviewCategoryLabels[category]}风险阈值`}
                  onChange={(event) => onChange({
                    ...draft,
                    modelReviewThresholds: {
                      ...draft.modelReviewThresholds,
                      [category]: Number(event.target.value),
                    },
                  })}
                  className="w-28"
                />
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </section>
  );
}

function StudentsPanel({
  data,
  loading,
  dailyLimit,
  search,
  status,
  onSearch,
  onStatus,
  onPage,
  onAccess,
}: {
  data: AIStudentListResponse;
  loading: boolean;
  dailyLimit: number;
  search: string;
  status: AIStudentStatusFilter;
  onSearch: (value: string) => void;
  onStatus: (value: AIStudentStatusFilter) => void;
  onPage: (value: number) => void;
  onAccess: (student: AIStudentItem) => void;
}) {
  return (
    <section className="rounded-lg border border-surface-200 bg-white dark:border-surface-700 dark:bg-surface-900">
      <div className="flex flex-col gap-3 border-b border-surface-200 p-4 dark:border-surface-700 md:flex-row md:items-center md:justify-between">
        <div className="relative w-full md:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400" />
          <Input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="搜索学生、邮箱"
            aria-label="搜索学生"
            className="pl-9"
          />
        </div>
        <Select
          value={status}
          onChange={(value) => onStatus(value as AIStudentStatusFilter)}
          aria-label="筛选学生 AI 状态"
          className="w-full md:w-44"
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'active', label: 'AI 可用' },
            { value: 'blocked', label: 'AI 已封禁' },
            { value: 'quota_exhausted', label: '额度已用完' },
          ]}
        />
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[920px] table-fixed text-left text-sm">
          <thead className="bg-surface-50 text-xs uppercase text-surface-500 dark:bg-surface-800/70 dark:text-surface-400">
            <tr>
              <th className="w-[24%] px-4 py-3 font-medium">学生</th>
              <th className="w-[15%] px-4 py-3 font-medium">AI 权限</th>
              <th className="w-[31%] px-4 py-3 font-medium">今日回复额度</th>
              <th className="w-[20%] px-4 py-3 font-medium">最近 AI 回复</th>
              <th className="w-[10%] px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-200 dark:divide-surface-700">
            {loading ? (
              <TableMessage colSpan={5} text="加载学生状态中..." />
            ) : data.items.length === 0 ? (
              <TableMessage colSpan={5} text="暂无匹配学生" />
            ) : data.items.map((student) => (
              <tr key={student.id} className="hover:bg-surface-50 dark:hover:bg-surface-800/50">
                <td className="px-4 py-4">
                  <div className="font-medium text-surface-950 dark:text-surface-100">{student.display_name || student.username}</div>
                  <div className="mt-0.5 truncate text-xs text-surface-500 dark:text-surface-400">{student.username} · {student.email}</div>
                </td>
                <td className="px-4 py-4">
                  <Badge variant={student.ai_blocked ? 'destructive' : 'success'}>
                    {student.ai_blocked ? '已封禁' : '可用'}
                  </Badge>
                  {student.ai_blocked && student.blocked_reason && (
                    <div className="mt-1 truncate text-xs text-red-600 dark:text-red-300" title={student.blocked_reason}>{student.blocked_reason}</div>
                  )}
                </td>
                <td className="px-4 py-4">
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="font-medium text-surface-700 dark:text-surface-300">{student.replies_used} / {dailyLimit}</span>
                    <span className={student.quota_exhausted ? 'text-red-600 dark:text-red-300' : 'text-surface-500 dark:text-surface-400'}>
                      剩余 {student.replies_remaining}
                    </span>
                  </div>
                  <Progress
                    value={student.replies_used}
                    max={Math.max(dailyLimit, 1)}
                    size="sm"
                    variant={student.quota_exhausted ? 'destructive' : student.replies_used / Math.max(dailyLimit, 1) >= 0.8 ? 'warning' : 'default'}
                  />
                </td>
                <td className="px-4 py-4 text-surface-600 dark:text-surface-300">{formatDateTime(student.last_ai_reply_at)}</td>
                <td className="px-4 py-4 text-right">
                  <Button
                    variant={student.ai_blocked ? 'ghost' : 'destructive'}
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => onAccess(student)}
                    aria-label={`${student.ai_blocked ? '解除' : '封禁'} ${student.username} 的 AI 权限`}
                    title={`${student.ai_blocked ? '解除' : '封禁'} AI 权限`}
                  >
                    {student.ai_blocked ? <UnlockKeyhole className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PaginationFooter page={data.page} totalPages={data.total_pages} total={data.total} onPage={onPage} />
    </section>
  );
}

function EventsPanel({
  data,
  loading,
  search,
  eventType,
  onSearch,
  onEventType,
  onPage,
}: {
  data: AIRiskEventListResponse;
  loading: boolean;
  search: string;
  eventType: AIRiskEventType | 'all';
  onSearch: (value: string) => void;
  onEventType: (value: AIRiskEventType | 'all') => void;
  onPage: (value: number) => void;
}) {
  return (
    <section className="rounded-lg border border-surface-200 bg-white dark:border-surface-700 dark:bg-surface-900">
      <div className="flex flex-col gap-3 border-b border-surface-200 p-4 dark:border-surface-700 md:flex-row md:items-center md:justify-between">
        <div className="relative w-full md:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400" />
          <Input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="搜索学生、规则或内容"
            aria-label="搜索风险事件"
            className="pl-9"
          />
        </div>
        <Select
          value={eventType}
          onChange={(value) => onEventType(value as AIRiskEventType | 'all')}
          aria-label="筛选风险事件类型"
          className="w-full md:w-48"
          options={[
            { value: 'all', label: '全部事件' },
            { value: 'content_blocked', label: '内容拦截' },
            { value: 'model_blocked', label: '模型拦截' },
            { value: 'model_review_error', label: '审查异常' },
            { value: 'admin_blocked', label: '管理员封禁' },
            { value: 'admin_unblocked', label: '管理员解封' },
          ]}
        />
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[1080px] table-fixed text-left text-sm">
          <thead className="bg-surface-50 text-xs uppercase text-surface-500 dark:bg-surface-800/70 dark:text-surface-400">
            <tr>
              <th className="w-[16%] px-4 py-3 font-medium">时间</th>
              <th className="w-[15%] px-4 py-3 font-medium">学生</th>
              <th className="w-[14%] px-4 py-3 font-medium">事件</th>
              <th className="w-[20%] px-4 py-3 font-medium">命中规则</th>
              <th className="w-[35%] px-4 py-3 font-medium">记录</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-200 dark:divide-surface-700">
            {loading ? (
              <TableMessage colSpan={5} text="加载风险事件中..." />
            ) : data.items.length === 0 ? (
              <TableMessage colSpan={5} text="暂无风险事件" />
            ) : data.items.map((event) => (
              <tr key={event.id} className="hover:bg-surface-50 dark:hover:bg-surface-800/50">
                <td className="px-4 py-4 text-surface-600 dark:text-surface-300">{formatDateTime(event.created_at)}</td>
                <td className="px-4 py-4 font-medium text-surface-900 dark:text-surface-100">{event.student_username || '已删除学生'}</td>
                <td className="px-4 py-4"><EventBadge event={event} /></td>
                <td className="px-4 py-4 text-surface-700 dark:text-surface-300">
                  <div>{matchedRuleLabel(event.matched_rule)}</div>
                  {event.risk_score !== null && (
                    <div className="mt-1 text-xs font-medium text-red-600 dark:text-red-300">
                      得分 {(event.risk_score * 100).toFixed(1)}%
                    </div>
                  )}
                </td>
                <td className="px-4 py-4">
                  <div className="line-clamp-2 text-surface-600 dark:text-surface-300" title={event.content_excerpt}>{event.content_excerpt || '-'}</div>
                  <div className="mt-1 truncate text-xs text-surface-400" title={event.review_model || undefined}>
                    {eventMeta(event)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PaginationFooter page={data.page} totalPages={data.total_pages} total={data.total} onPage={onPage} />
    </section>
  );
}

function EventBadge({ event }: { event: AIRiskEvent }) {
  const config: Record<AIRiskEventType, { label: string; variant: 'destructive' | 'warning' | 'success' }> = {
    content_blocked: { label: '内容拦截', variant: 'destructive' },
    model_blocked: { label: '模型拦截', variant: 'destructive' },
    model_review_error: { label: '审查异常', variant: 'warning' },
    admin_blocked: { label: '管理员封禁', variant: 'warning' },
    admin_unblocked: { label: '管理员解封', variant: 'success' },
  };
  const current = config[event.event_type];
  return <Badge variant={current.variant}>{current.label}</Badge>;
}

function PaginationFooter({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (value: number) => void;
}) {
  if (total === 0) return null;
  return (
    <div className="flex flex-col gap-3 border-t border-surface-200 px-4 py-3 text-sm dark:border-surface-700 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-surface-500 dark:text-surface-400">共 {total.toLocaleString('zh-CN')} 条</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</Button>
        <span className="min-w-20 text-center text-surface-600 dark:text-surface-300">{page} / {Math.max(totalPages, 1)}</span>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>下一页</Button>
      </div>
    </div>
  );
}

function TableMessage({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="h-32 px-4 text-center text-surface-500 dark:text-surface-400">{text}</td>
    </tr>
  );
}

function AccessDialog({
  student,
  reason,
  loading,
  onReason,
  onClose,
  onConfirm,
}: {
  student: AIStudentItem | null;
  reason: string;
  loading: boolean;
  onReason: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!student) return null;
  const blocking = !student.ai_blocked;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/60 p-4" role="presentation" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-dialog-title"
        className="w-full max-w-md rounded-lg border border-surface-200 bg-white p-5 shadow-2xl dark:border-surface-700 dark:bg-surface-900"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="access-dialog-title" className="text-lg font-semibold text-surface-950 dark:text-surface-50">
              {blocking ? '封禁学生 AI 权限' : '解除学生 AI 封禁'}
            </h2>
            <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">{student.display_name || student.username} · {student.username}</p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="关闭权限操作" title="关闭">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {blocking ? (
          <label className="mt-5 block space-y-2" htmlFor="access-reason">
            <span className="text-sm font-medium text-surface-800 dark:text-surface-200">封禁原因</span>
            <textarea
              id="access-reason"
              value={reason}
              onChange={(event) => onReason(event.target.value)}
              rows={4}
              maxLength={500}
              autoFocus
              className="w-full resize-none rounded-md border border-surface-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-red-500 dark:border-surface-700 dark:bg-surface-800 dark:text-surface-100"
            />
          </label>
        ) : (
          <div className="mt-5 flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            <CheckCircle2 className="h-5 w-5 shrink-0" />
            <span>恢复该学生的 AI 请求权限。</span>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>取消</Button>
          <Button
            variant={blocking ? 'destructive' : 'primary'}
            onClick={onConfirm}
            isLoading={loading}
            disabled={blocking && !reason.trim()}
          >
            {blocking ? <LockKeyhole className="mr-2 h-4 w-4" /> : <UnlockKeyhole className="mr-2 h-4 w-4" />}
            {blocking ? '确认封禁' : '解除封禁'}
          </Button>
        </div>
      </section>
    </div>
  );
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    session_chat: '学习会话',
    exercise_submit: '答案判定',
    admin_risk_center: '管理员操作',
  };
  return labels[source] ?? source;
}

function matchedRuleLabel(rule: string): string {
  if (!rule) return '-';
  if (rule === 'model_review_unavailable') return '审核服务不可用';
  return modelReviewCategoryLabels[rule as AIModelReviewCategory] ?? rule;
}

function eventMeta(event: AIRiskEvent): string {
  const items = [sourceLabel(event.source)];
  if (event.review_model) items.push(event.review_model);
  if (event.review_latency_ms !== null) items.push(`${event.review_latency_ms} ms`);
  return items.join(' · ');
}

export default AIRiskControlPage;
