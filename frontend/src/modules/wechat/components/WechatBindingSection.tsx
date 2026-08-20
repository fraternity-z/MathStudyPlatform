import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Loader2,
  MessageCircle,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RequestErrorNotice } from '@/components/feedback';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  isRequestCancelled,
  toAppError,
  toAppErrorFeedback,
  type AppError,
} from '@/libs/http/apiClient';
import { formatDateOrFallback } from '@/libs/utils/dateFormat';
import {
  wechatService,
  type WechatBindingStatus,
  type WechatBindingTicket,
} from '@/modules/wechat/services/wechatService';

interface WechatBindingSectionProps {
  userId: string;
}

function ticketHasExpired(ticket: WechatBindingTicket): boolean {
  const expiresAt = Date.parse(ticket.expires_at);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

export function WechatBindingSection({ userId }: WechatBindingSectionProps) {
  const { toast } = useToast();
  const [status, setStatus] = useState<WechatBindingStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<AppError | null>(null);
  const [bindingOpen, setBindingOpen] = useState(false);
  const [ticket, setTicket] = useState<WechatBindingTicket | null>(null);
  const [ticketLoading, setTicketLoading] = useState(false);
  const [ticketError, setTicketError] = useState<AppError | null>(null);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [unbindOpen, setUnbindOpen] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [, refreshExpiry] = useState(0);

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const nextStatus = await wechatService.getBindingStatus(signal);
      if (!signal?.aborted) setStatus(nextStatus);
    } catch (error) {
      if (!signal?.aborted && !isRequestCancelled(error)) {
        setStatusError(toAppError(error, '公众号绑定状态加载失败'));
      }
    } finally {
      if (!signal?.aborted) setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus, userId]);

  useEffect(() => {
    if (!bindingOpen || !ticket) return;
    const expiresAt = Date.parse(ticket.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;

    const timer = window.setTimeout(
      () => refreshExpiry((version) => version + 1),
      Math.min(expiresAt - Date.now() + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [bindingOpen, ticket]);

  const generateTicket = async () => {
    setTicketLoading(true);
    setTicketError(null);
    setCheckMessage(null);
    setCopied(false);
    try {
      setTicket(await wechatService.createBindingTicket());
    } catch (error) {
      setTicket(null);
      if (!isRequestCancelled(error)) {
        setTicketError(toAppError(error, '绑定命令生成失败，请稍后重试'));
      }
    } finally {
      setTicketLoading(false);
    }
  };

  const openBinding = () => {
    setBindingOpen(true);
    setTicket(null);
    void generateTicket();
  };

  const closeBinding = () => {
    setBindingOpen(false);
    setTicket(null);
    setTicketError(null);
    setCheckMessage(null);
    setCopied(false);
  };

  const copyCommand = async () => {
    if (!ticket) return;
    try {
      await navigator.clipboard.writeText(ticket.command);
      setCopied(true);
      toast({ type: 'success', title: '绑定命令已复制', duration: 2000 });
    } catch {
      toast({ type: 'error', title: '复制失败，请手动选择绑定命令' });
    }
  };

  const checkBinding = async () => {
    if (!ticket || ticketHasExpired(ticket)) {
      await generateTicket();
      return;
    }

    setChecking(true);
    setTicketError(null);
    setCheckMessage(null);
    try {
      const nextStatus = await wechatService.getBindingStatus();
      setStatus(nextStatus);
      setStatusError(null);
      if (nextStatus.is_bound) {
        closeBinding();
        toast({ type: 'success', title: '微信公众号绑定成功' });
      } else {
        setCheckMessage('尚未检测到绑定，请发送命令后再次检查。');
      }
    } catch (error) {
      if (!isRequestCancelled(error)) {
        setTicketError(toAppError(error, '绑定状态检查失败，请稍后重试'));
      }
    } finally {
      setChecking(false);
    }
  };

  const unbind = async () => {
    setUnbinding(true);
    try {
      await wechatService.unbind();
      setStatus((current) => current ? {
        ...current,
        is_bound: false,
        subscribed: false,
        bound_at: null,
      } : current);
      setUnbindOpen(false);
      toast({ type: 'success', title: '微信公众号已解绑' });
    } catch (error) {
      const feedback = toAppErrorFeedback(error, '微信公众号解绑失败，请稍后重试');
      if (feedback) toast(feedback);
    } finally {
      setUnbinding(false);
    }
  };

  const expired = ticket ? ticketHasExpired(ticket) : false;
  const boundAt = status?.bound_at
    ? formatDateOrFallback(status.bound_at, 'yyyy-MM-dd HH:mm', { fallback: '' })
    : '';
  const accountName = status?.account_name?.trim();

  let statusText = '加载中...';
  if (!statusLoading && statusError) statusText = '状态加载失败';
  else if (!statusLoading && status && !status.available) statusText = '当前环境未启用';
  else if (!statusLoading && status?.is_bound) {
    statusText = status.subscribed ? '已绑定 · 已关注' : '已绑定 · 已取消关注';
  } else if (!statusLoading && status) statusText = '未绑定';

  return (
    <>
      <div className="flex flex-col gap-4 rounded-lg border border-surface-200 bg-surface-50/50 p-4 transition-colors hover:bg-surface-50 dark:border-surface-700 dark:bg-surface-800/50 dark:hover:bg-surface-800 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <div className="rounded-full border border-surface-200 bg-white p-2.5 text-surface-600 dark:border-surface-600 dark:bg-surface-700 dark:text-surface-400">
            <MessageCircle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-surface-900 dark:text-surface-100">微信公众号</p>
            <p className="text-sm text-surface-500 dark:text-surface-400" aria-live="polite">
              {accountName ? `${accountName} · ${statusText}` : statusText}
            </p>
            {status?.is_bound && !status.subscribed && (
              <p className="text-xs text-amber-600 dark:text-amber-400">重新关注后可继续接收消息</p>
            )}
            {status?.is_bound && status.subscribed && boundAt && (
              <p className="text-xs text-surface-400 dark:text-surface-500">绑定于 {boundAt}</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
          {statusLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-surface-400" aria-label="正在加载公众号绑定状态" />
          ) : !statusError && status?.available && status.is_bound ? (
            <Button variant="outline" size="sm" onClick={() => setUnbindOpen(true)}>
              解绑
            </Button>
          ) : !statusError && status?.available ? (
            <Button variant="outline" size="sm" onClick={openBinding}>
              绑定
            </Button>
          ) : null}
        </div>
      </div>

      {statusError ? (
        <RequestErrorNotice
          error={statusError}
          onRetry={() => void loadStatus()}
          onRefresh={() => void loadStatus()}
          className="mt-3"
        />
      ) : null}

      <Modal
        isOpen={bindingOpen}
        onClose={closeBinding}
        title="绑定微信公众号"
        className="max-w-lg rounded-lg p-6"
      >
        <div className="relative z-1 space-y-4">
          {ticketLoading ? (
            <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-surface-500" role="status">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在生成绑定命令...
            </div>
          ) : ticket ? (
            <>
              <p className="text-sm text-surface-600 dark:text-surface-300">
                在微信中向{ticket.account_name?.trim() || '已关注的公众号'}发送以下命令：
              </p>
              <div className="flex min-w-0 items-center gap-2 rounded-md border border-surface-200 bg-surface-50 p-3 dark:border-surface-700 dark:bg-surface-800">
                <code className="min-w-0 flex-1 select-all break-all text-sm font-semibold text-surface-900 dark:text-surface-100">
                  {ticket.command}
                </code>
                <button
                  type="button"
                  onClick={() => void copyCommand()}
                  title="复制绑定命令"
                  aria-label="复制绑定命令"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-surface-500 transition-colors hover:bg-surface-200 hover:text-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:hover:bg-surface-700 dark:hover:text-primary-400"
                >
                  {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
              <p className={`text-xs ${expired ? 'text-red-600 dark:text-red-400' : 'text-surface-500 dark:text-surface-400'}`}>
                {expired
                  ? '绑定命令已过期，请重新生成。'
                  : `有效期至 ${formatDateOrFallback(ticket.expires_at, 'HH:mm:ss', { fallback: '未知' })}`}
              </p>
            </>
          ) : null}

          {ticketError ? (
            <RequestErrorNotice
              error={ticketError}
              onRetry={() => void generateTicket()}
              onRefresh={() => void generateTicket()}
            />
          ) : null}
          {checkMessage && (
            <div className="rounded-md bg-blue-50 p-3 text-sm text-blue-700 dark:bg-blue-900/20 dark:text-blue-300" role="status">
              {checkMessage}
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={closeBinding} disabled={ticketLoading || checking}>
              取消
            </Button>
            {!ticket || expired ? (
              <Button onClick={() => void generateTicket()} disabled={ticketLoading || checking}>
                <RefreshCw className="mr-2 h-4 w-4" />
                重新生成
              </Button>
            ) : (
              <Button onClick={() => void checkBinding()} disabled={checking}>
                {checking ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {checking ? '检查中...' : '检查绑定状态'}
              </Button>
            )}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={unbindOpen}
        onClose={() => setUnbindOpen(false)}
        onConfirm={() => void unbind()}
        loading={unbinding}
        title="解绑微信公众号"
        message="解绑后，该微信将不再接收与此账号相关的公众号消息。"
        confirmText="确认解绑"
        confirmVariant="destructive"
        showIcon={false}
      />
    </>
  );
}
