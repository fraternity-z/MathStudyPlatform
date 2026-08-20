import type { ComponentType } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  RefreshCw,
  RotateCcw,
  Server,
  Wifi,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';
import { cn } from '@/libs/utils/cn';
import type { LoadingState } from '@/types/common';
import type {
  ServiceStatus,
  SystemAlert,
  SystemStatusResponse,
} from '@/modules/admin/types/adminStats';

interface OperationsPanelProps {
  data: SystemStatusResponse | null;
  loading: LoadingState;
  error: AppError | null;
  autoRefresh: boolean;
  resetting: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  onRefresh: () => void;
  onResetRequest: () => void;
}

type Tone = 'healthy' | 'warning' | 'danger' | 'neutral';

const statusPresentation = {
  healthy: {
    label: '运行健康',
    description: '核心服务与数据依赖均可用',
    tone: 'healthy' as Tone,
    icon: CheckCircle2,
  },
  degraded: {
    label: '部分降级',
    description: '部分能力异常，核心服务仍在运行',
    tone: 'warning' as Tone,
    icon: AlertTriangle,
  },
  unhealthy: {
    label: '服务异常',
    description: '核心依赖不可用，需要尽快处理',
    tone: 'danger' as Tone,
    icon: XCircle,
  },
};

const toneClasses: Record<Tone, { text: string; soft: string; dot: string }> = {
  healthy: {
    text: 'text-emerald-600 dark:text-emerald-400',
    soft: 'bg-emerald-50 dark:bg-emerald-950/30',
    dot: 'bg-emerald-500',
  },
  warning: {
    text: 'text-amber-600 dark:text-amber-400',
    soft: 'bg-amber-50 dark:bg-amber-950/30',
    dot: 'bg-amber-500',
  },
  danger: {
    text: 'text-red-600 dark:text-red-400',
    soft: 'bg-red-50 dark:bg-red-950/30',
    dot: 'bg-red-500',
  },
  neutral: {
    text: 'text-surface-700 dark:text-surface-300',
    soft: 'bg-surface-100 dark:bg-surface-800',
    dot: 'bg-surface-400',
  },
};

export function OperationsPanel({
  data,
  loading,
  error,
  autoRefresh,
  resetting,
  onAutoRefreshChange,
  onRefresh,
  onResetRequest,
}: OperationsPanelProps) {
  if (!data && loading === 'loading') {
    return <OperationsPanelSkeleton />;
  }

  if (!data) {
    return <OperationsUnavailable error={error} onRefresh={onRefresh} />;
  }

  const presentation = statusPresentation[data.status];
  const StatusIcon = presentation.icon;
  const actionableAlerts = data.alerts.filter((alert) => alert.severity !== 'info');
  const postgresService = findService(data.services, 'postgresql');
  const redisService = findService(data.services, 'redis');
  const heapSummary = `${formatBytes(data.runtime.heap_used_bytes)} / ${formatBytes(data.runtime.heap_reserved_bytes)}`;

  return (
    <section className="space-y-5" aria-labelledby="operations-heading">
      <header className="flex flex-col gap-4 border-b border-surface-200 pb-5 dark:border-surface-800 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-950/40 dark:text-primary-400">
            <Activity className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 id="operations-heading" className="text-xl font-semibold text-surface-950 dark:text-surface-50">
                运维监控
              </h2>
              <span className="inline-flex items-center gap-1.5 text-sm text-surface-500 dark:text-surface-400">
                <span className={cn('h-2 w-2 rounded-full', toneClasses[presentation.tone].dot)} />
                {presentation.label}
              </span>
            </div>
            <p className="mt-1 flex flex-wrap gap-x-2 text-sm text-surface-500 dark:text-surface-400">
              <span>最近采样 {formatTimestamp(data.checked_at)}</span>
              <span aria-hidden="true">·</span>
              <span>本轮统计自 {formatTimestamp(data.traffic.window_started_at)}</span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex min-h-10 items-center gap-2 text-sm text-surface-600 dark:text-surface-300">
            <button
              type="button"
              role="switch"
              aria-checked={autoRefresh}
              aria-label="切换运维数据自动刷新"
              onClick={() => onAutoRefreshChange(!autoRefresh)}
              disabled={resetting}
              className={cn(
                'relative h-6 w-11 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:ring-offset-surface-900',
                autoRefresh ? 'bg-primary-600' : 'bg-surface-300 dark:bg-surface-700'
              )}
            >
              <span
                className={cn(
                  'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
                  autoRefresh ? 'translate-x-5' : 'translate-x-0'
                )}
              />
            </button>
            自动刷新
            <span className="text-xs text-surface-400">15 秒</span>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onResetRequest}
            disabled={resetting || loading === 'loading'}
          >
            <RotateCcw className={cn('mr-2 h-4 w-4', resetting && 'animate-spin')} />
            重置指标
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onRefresh}
            disabled={resetting || loading === 'loading'}
            aria-label="刷新运维数据"
            title="刷新运维数据"
          >
            <RefreshCw className={cn('h-4 w-4', loading === 'loading' && 'animate-spin')} />
          </Button>
        </div>
      </header>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300" role="status">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          最近一次刷新失败，当前显示上次成功采样的数据。
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(280px,0.9fr)_minmax(0,2.1fr)]">
        <article className="flex min-h-64 flex-col justify-between rounded-lg border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-surface-900">
          <div>
            <div className={cn('flex h-12 w-12 items-center justify-center rounded-lg', toneClasses[presentation.tone].soft, toneClasses[presentation.tone].text)}>
              <StatusIcon className="h-6 w-6" aria-hidden="true" />
            </div>
            <h3 className={cn('mt-4 text-2xl font-semibold', toneClasses[presentation.tone].text)}>
              {presentation.label}
            </h3>
            <p className="mt-1 text-sm leading-6 text-surface-500 dark:text-surface-400">
              {presentation.description}
            </p>
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-x-5 gap-y-4 border-t border-surface-100 pt-5 dark:border-surface-800">
            <SummaryDatum label="在线学习" value={formatNullableNumber(data.learning.online_users)} />
            <SummaryDatum label="活跃会话" value={formatNullableNumber(data.learning.active_sessions)} />
            <SummaryDatum label="已运行" value={formatDuration(data.runtime.uptime_seconds)} />
            <SummaryDatum label="环境" value={data.runtime.environment || '-'} />
          </dl>
        </article>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <MetricTile icon={Gauge} label="平均 QPS" value={data.traffic.average_qps.toFixed(2)} hint="本轮统计" tone="healthy" />
          <MetricTile icon={Activity} label="请求总量" value={formatNumber(data.traffic.requests_total)} hint="本轮累计" />
          <MetricTile
            icon={XCircle}
            label="服务错误率"
            value={`${data.traffic.server_error_rate_percent.toFixed(2)}%`}
            hint={`${formatNumber(data.traffic.server_errors_total)} 次 5xx`}
            tone={data.traffic.server_error_rate_percent > 1 ? 'danger' : 'healthy'}
          />
          <MetricTile icon={Clock3} label="平均响应" value={`${formatNumber(data.traffic.average_latency_ms)} ms`} hint="本轮请求" />
          <MetricTile
            icon={Clock3}
            label="P95 响应"
            value={`${data.traffic.p95_clamped ? '≥ ' : ''}${formatNumber(data.traffic.p95_latency_ms)} ms`}
            hint="本轮直方图"
            tone={data.traffic.p95_latency_ms >= 1000 ? 'warning' : 'neutral'}
          />
          <MetricTile
            icon={AlertTriangle}
            label="客户端错误"
            value={`${data.traffic.client_error_rate_percent.toFixed(2)}%`}
            hint={`${formatNumber(data.traffic.client_errors_total)} 次 4xx`}
            tone={data.traffic.client_error_rate_percent > 10 ? 'warning' : 'neutral'}
          />
        </div>
      </div>

      <div className="grid overflow-hidden rounded-lg border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900 sm:grid-cols-2 xl:grid-cols-6">
        <ResourceCell icon={Cpu} label="进程 CPU" value={`${data.runtime.cpu_usage_percent.toFixed(1)}%`} detail={`${data.runtime.logical_cpus} 逻辑核`} tone={usageTone(data.runtime.cpu_usage_percent)} />
        <ResourceCell icon={HardDrive} label="Go 堆内存" value={`${data.runtime.heap_usage_percent.toFixed(1)}%`} detail={heapSummary} tone={usageTone(data.runtime.heap_usage_percent)} />
        <ResourceCell
          icon={Database}
          label="PostgreSQL"
          value={serviceLabel(postgresService)}
          detail={`${data.postgresql.acquired_connections} 使用 / ${data.postgresql.max_connections} 上限`}
          tone={serviceTone(postgresService)}
        />
        <ResourceCell
          icon={Wifi}
          label="Redis"
          value={serviceLabel(redisService)}
          detail={`${data.redis.total_connections} 连接 · ${data.redis.reuse_percent.toFixed(0)}% 复用`}
          tone={serviceTone(redisService)}
        />
        <ResourceCell icon={Activity} label="Goroutines" value={formatNumber(data.runtime.goroutines)} detail={`GOMAXPROCS ${data.runtime.gomaxprocs}`} tone={data.runtime.goroutines >= 8000 ? 'warning' : 'healthy'} />
        <ResourceCell icon={Server} label="API 运行时" value={data.runtime.version || '-'} detail={`${data.runtime.os}/${data.runtime.arch}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <section className="rounded-lg border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-surface-900" aria-labelledby="service-probes-heading">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 id="service-probes-heading" className="font-semibold text-surface-950 dark:text-surface-50">服务探测</h3>
              <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">应用与核心依赖连通性</p>
            </div>
            <Server className="h-5 w-5 text-surface-400" aria-hidden="true" />
          </div>
          <div className="mt-4 divide-y divide-surface-100 dark:divide-surface-800">
            {data.services.map((service) => (
              <ServiceRow key={service.name} service={service} />
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-surface-900" aria-labelledby="runtime-summary-heading">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 id="runtime-summary-heading" className="font-semibold text-surface-950 dark:text-surface-50">运行摘要</h3>
              <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">
                {actionableAlerts.length > 0 ? `${actionableAlerts.length} 项需要关注` : '当前无待处理告警'}
              </p>
            </div>
            {actionableAlerts.length > 0 ? (
              <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" />
            )}
          </div>

          {actionableAlerts.length > 0 ? (
            <div className="mt-4 space-y-2">
              {actionableAlerts.map((alert) => <AlertRow key={alert.id} alert={alert} />)}
            </div>
          ) : null}

          <dl className={cn('grid grid-cols-2 gap-x-5 gap-y-3 text-sm', actionableAlerts.length > 0 ? 'mt-5 border-t border-surface-100 pt-4 dark:border-surface-800' : 'mt-4')}>
            <RuntimeDatum label="Go" value={data.runtime.go_version || '-'} />
            <RuntimeDatum label="启动时间" value={formatTimestamp(data.runtime.started_at)} />
            <RuntimeDatum label="数据库等待" value={formatNumber(data.postgresql.empty_acquire_count)} />
            <RuntimeDatum label="Redis 超时" value={formatNumber(data.redis.timeouts)} />
          </dl>
        </section>
      </div>
    </section>
  );
}

function OperationsPanelSkeleton() {
  return (
    <div className="space-y-5 animate-pulse" aria-label="正在加载运维数据">
      <div className="flex items-center justify-between border-b border-surface-200 pb-5 dark:border-surface-800">
        <div className="h-10 w-48 rounded bg-surface-200 dark:bg-surface-800" />
        <div className="h-10 w-28 rounded bg-surface-200 dark:bg-surface-800" />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(280px,0.9fr)_minmax(0,2.1fr)]">
        <div className="min-h-64 rounded-lg bg-surface-100 dark:bg-surface-900" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => <div key={index} className="min-h-32 rounded-lg bg-surface-100 dark:bg-surface-900" />)}
        </div>
      </div>
      <div className="h-32 rounded-lg bg-surface-100 dark:bg-surface-900" />
    </div>
  );
}

function OperationsUnavailable({ error, onRefresh }: { error: AppError | null; onRefresh: () => void }) {
  if (error) {
    return <RequestErrorNotice error={error} onRetry={onRefresh} onRefresh={onRefresh} />;
  }
  return (
    <div className="flex min-h-80 flex-col items-center justify-center rounded-lg border border-dashed border-surface-300 bg-white px-6 text-center dark:border-surface-700 dark:bg-surface-900">
      <AlertTriangle className="h-8 w-8 text-amber-500" aria-hidden="true" />
      <h2 className="mt-4 text-lg font-semibold text-surface-950 dark:text-surface-50">运维数据暂不可用</h2>
      <p className="mt-2 max-w-md text-sm text-surface-500 dark:text-surface-400">
        当前无法获取服务状态，请稍后重试。
      </p>
      <Button type="button" variant="outline" className="mt-5" onClick={onRefresh}>
        <RefreshCw className="mr-2 h-4 w-4" />
        重新加载
      </Button>
    </div>
  );
}

function SummaryDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-surface-500 dark:text-surface-400">{label}</dt>
      <dd className="mt-1 truncate text-base font-semibold text-surface-950 dark:text-surface-50" title={value}>{value}</dd>
    </div>
  );
}

function MetricTile({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  label: string;
  value: string;
  hint: string;
  tone?: Tone;
}) {
  return (
    <article className="flex min-h-32 flex-col justify-between rounded-lg border border-surface-200 bg-white p-4 dark:border-surface-800 dark:bg-surface-900">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-surface-500 dark:text-surface-400">{label}</span>
        <Icon className="h-4 w-4 text-surface-400" aria-hidden="true" />
      </div>
      <div className="mt-3">
        <div className={cn('text-2xl font-semibold tabular-nums', toneClasses[tone].text)}>{value}</div>
        <p className="mt-1 text-xs text-surface-400">{hint}</p>
      </div>
    </article>
  );
}

function ResourceCell({
  icon: Icon,
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  label: string;
  value: string;
  detail: string;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0 border-b border-surface-200 p-4 last:border-b-0 dark:border-surface-800 sm:[&:nth-last-child(-n+2)]:border-b-0 xl:border-b-0 xl:border-r xl:last:border-r-0">
      <div className="flex items-center gap-2 text-xs font-medium text-surface-500 dark:text-surface-400">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      <div className={cn('mt-2 truncate text-lg font-semibold tabular-nums', toneClasses[tone].text)} title={value}>{value}</div>
      <div className="mt-1 truncate text-xs text-surface-400" title={detail}>{detail}</div>
    </div>
  );
}

function ServiceRow({ service }: { service: ServiceStatus }) {
  const tone = serviceTone(service);
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', toneClasses[tone].dot)} />
        <span className="truncate text-sm font-medium text-surface-800 dark:text-surface-200">{service.name}</span>
      </div>
      <div className="flex shrink-0 items-center gap-4 text-xs">
        <span className="tabular-nums text-surface-400">{service.latency_ms == null ? '-' : `${service.latency_ms.toFixed(0)} ms`}</span>
        <span className={toneClasses[tone].text}>{serviceLabel(service)}</span>
      </div>
    </div>
  );
}

function AlertRow({ alert }: { alert: SystemAlert }) {
  const tone = alert.severity === 'error' ? 'danger' : 'warning';
  return (
    <div className={cn('rounded-lg px-3 py-2.5', toneClasses[tone].soft)}>
      <div className={cn('text-sm font-medium', toneClasses[tone].text)}>{alert.title}</div>
      <div className="mt-1 text-xs leading-5 text-surface-600 dark:text-surface-300">{alert.description}</div>
    </div>
  );
}

function RuntimeDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-surface-500 dark:text-surface-400">{label}</dt>
      <dd className="mt-1 truncate font-medium text-surface-800 dark:text-surface-200" title={value}>{value}</dd>
    </div>
  );
}

function findService(services: ServiceStatus[], name: string): ServiceStatus | undefined {
  return services.find((service) => service.name.toLowerCase() === name);
}

function serviceTone(service: ServiceStatus | undefined): Tone {
  if (!service) return 'neutral';
  if (service.status === 'running') return 'healthy';
  if (service.status === 'warning') return 'warning';
  return 'danger';
}

function serviceLabel(service: ServiceStatus | undefined): string {
  if (!service) return '未知';
  if (service.status === 'running') return '正常';
  if (service.status === 'warning') return '异常';
  return '已停止';
}

function usageTone(percent: number): Tone {
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warning';
  return 'healthy';
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
}

function formatNullableNumber(value: number | null): string {
  return value == null ? '-' : formatNumber(value);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return `${Math.round(bytes / 1024 / 1024).toLocaleString('zh-CN')} MB`;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${seconds} 秒`;
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}
