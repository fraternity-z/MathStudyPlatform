import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  MailCheck,
  PlugZap,
  Save,
  Send,
  Server,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { RequestErrorNotice } from '@/components/feedback';
import { emailSchema, emailSettingsSchema } from '@/libs/validation';
import type { AppError } from '@/libs/http/apiClient';
import { isAdminRequestCancelled, toAdminAppError } from '@/modules/admin/utils/errorFeedback';
import { adminEmailService } from '@/modules/email/services/adminEmailService';
import type {
  EmailSettings,
  EmailSettingsOverride,
  EmailSettingsUpdate,
} from '@/modules/email/types/email';

interface SMTPFormState {
  smtpHost: string;
  smtpPort: string;
  smtpUsername: string;
  smtpPassword: string;
  smtpFrom: string;
  smtpFromName: string;
  smtpUseTLS: boolean;
}

interface FeedbackState {
  type: 'success' | 'error';
  message: string;
}

type SMTPAction = 'load' | 'save' | 'test' | 'send' | 'clear';

const emptyForm: SMTPFormState = {
  smtpHost: '',
  smtpPort: '587',
  smtpUsername: '',
  smtpPassword: '',
  smtpFrom: '',
  smtpFromName: '',
  smtpUseTLS: false,
};

const settingsToForm = (settings: EmailSettings): SMTPFormState => ({
  smtpHost: settings.smtp_host,
  smtpPort: String(settings.smtp_port),
  smtpUsername: settings.smtp_username,
  smtpPassword: '',
  smtpFrom: settings.smtp_from,
  smtpFromName: settings.smtp_from_name,
  smtpUseTLS: settings.smtp_use_tls,
});

export const SMTPSettingsCard: React.FC = () => {
  const [form, setForm] = useState<SMTPFormState>(emptyForm);
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [testRecipient, setTestRecipient] = useState('');
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [requestError, setRequestError] = useState<AppError | null>(null);
  const [failedAction, setFailedAction] = useState<SMTPAction | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeAction, setActiveAction] = useState<Exclude<SMTPAction, 'load'> | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    setRequestError(null);
    setFailedAction(null);
    try {
      const data = await adminEmailService.getSettings(signal);
      if (signal?.aborted) return;
      setSettings(data);
      setForm(settingsToForm(data));
    } catch (error) {
      if (signal?.aborted || isAdminRequestCancelled(error)) return;
      setRequestError(toAdminAppError(error, '加载邮件配置失败'));
      setFailedAction('load');
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadSettings(controller.signal);
    return () => controller.abort();
  }, [loadSettings]);

  const validateForm = (): boolean => {
    const result = emailSettingsSchema.safeParse({
      smtpServer: form.smtpHost,
      smtpPort: Number(form.smtpPort),
      senderEmail: form.smtpFrom,
      senderName: form.smtpFromName || undefined,
      username: form.smtpUsername || undefined,
      password: form.smtpPassword || undefined,
      useTls: form.smtpUseTLS,
    });
    if (!result.success) {
      setFeedback({ type: 'error', message: result.error.issues[0]?.message ?? '邮件配置无效' });
      return false;
    }
    return true;
  };

  const draftPayload = (): EmailSettingsOverride => ({
    smtp_host: form.smtpHost.trim(),
    smtp_port: Number(form.smtpPort),
    smtp_username: form.smtpUsername.trim(),
    smtp_password: form.smtpPassword || undefined,
    smtp_from: form.smtpFrom.trim(),
    smtp_from_name: form.smtpFromName.trim(),
    smtp_use_tls: form.smtpUseTLS,
  });

  const updatePayload = (clearPassword: boolean): EmailSettingsUpdate => ({
    smtp_host: form.smtpHost.trim(),
    smtp_port: Number(form.smtpPort),
    smtp_username: form.smtpUsername.trim(),
    smtp_password: clearPassword ? undefined : form.smtpPassword || undefined,
    smtp_from: form.smtpFrom.trim(),
    smtp_from_name: form.smtpFromName.trim(),
    smtp_use_tls: form.smtpUseTLS,
    clear_password: clearPassword,
  });

  const handleSave = async () => {
    setFeedback(null);
    setRequestError(null);
    setFailedAction(null);
    if (!validateForm()) return;
    setActiveAction('save');
    try {
      const updated = await adminEmailService.updateSettings(updatePayload(false));
      setSettings(updated);
      setForm(settingsToForm(updated));
      setFeedback({ type: 'success', message: '邮件配置已保存' });
    } catch (error) {
      if (!isAdminRequestCancelled(error)) {
        setRequestError(toAdminAppError(error, '保存邮件配置失败'));
        setFailedAction('save');
      }
    } finally {
      setActiveAction(null);
    }
  };

  const handleTestConnection = async () => {
    setFeedback(null);
    setRequestError(null);
    setFailedAction(null);
    if (!validateForm()) return;
    setActiveAction('test');
    try {
      const result = await adminEmailService.testSMTP(draftPayload());
      setFeedback({ type: 'success', message: result.message });
    } catch (error) {
      if (!isAdminRequestCancelled(error)) {
        setRequestError(toAdminAppError(error, 'SMTP 连接测试失败'));
        setFailedAction('test');
      }
    } finally {
      setActiveAction(null);
    }
  };

  const handleSendTestEmail = async () => {
    setFeedback(null);
    setRequestError(null);
    setFailedAction(null);
    if (!validateForm()) return;
    const recipientResult = emailSchema.safeParse(testRecipient.trim());
    if (!recipientResult.success) {
      setFeedback({ type: 'error', message: recipientResult.error.issues[0]?.message ?? '收件邮箱无效' });
      return;
    }
    setActiveAction('send');
    try {
      const result = await adminEmailService.sendTestEmail(testRecipient.trim(), draftPayload());
      setFeedback({ type: 'success', message: result.message });
    } catch (error) {
      if (!isAdminRequestCancelled(error)) {
        setRequestError(toAdminAppError(error, '测试邮件发送失败'));
        setFailedAction('send');
      }
    } finally {
      setActiveAction(null);
    }
  };

  const handleClearPassword = async () => {
    setFeedback(null);
    setRequestError(null);
    setFailedAction(null);
    if (!validateForm()) {
      setShowClearConfirm(false);
      return;
    }
    setActiveAction('clear');
    try {
      const updated = await adminEmailService.updateSettings(updatePayload(true));
      setSettings(updated);
      setForm(settingsToForm(updated));
      setShowClearConfirm(false);
      setFeedback({ type: 'success', message: 'SMTP 密码已清除' });
    } catch (error) {
      if (!isAdminRequestCancelled(error)) {
        setRequestError(toAdminAppError(error, '清除 SMTP 密码失败'));
        setFailedAction('clear');
        setShowClearConfirm(false);
      }
    } finally {
      setActiveAction(null);
    }
  };

  const retryFailedAction = () => {
    switch (failedAction) {
      case 'save':
        void handleSave();
        break;
      case 'test':
        void handleTestConnection();
        break;
      case 'send':
        void handleSendTestEmail();
        break;
      case 'clear':
        void handleClearPassword();
        break;
      default:
        void loadSettings();
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Server className="h-5 w-5" />
            SMTP 配置
          </CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-surface-400" />
        </CardContent>
      </Card>
    );
  }

  if (requestError && !settings) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Server className="h-5 w-5" />
            SMTP 配置
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RequestErrorNotice
            error={requestError}
            onRetry={requestError.kind === 'conflict' ? undefined : () => void loadSettings()}
            onRefresh={() => void loadSettings()}
          />
        </CardContent>
      </Card>
    );
  }

  const isBusy = activeAction !== null;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-xl">
                <Server className="h-5 w-5" />
                SMTP 配置
              </CardTitle>
              <CardDescription>系统通知发信通道</CardDescription>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span
                className={`h-2.5 w-2.5 rounded-full ${settings?.configured ? 'bg-emerald-500' : 'bg-surface-300 dark:bg-surface-600'}`}
              />
              <span className="text-surface-600 dark:text-surface-400">
                {settings?.configured ? '已配置' : '未配置'}
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {requestError ? (
            <RequestErrorNotice
              error={requestError}
              onRetry={requestError.kind === 'conflict' ? undefined : retryFailedAction}
              onRefresh={() => void loadSettings()}
              onDismiss={() => setRequestError(null)}
            />
          ) : null}
          {feedback ? <Feedback feedback={feedback} /> : null}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="SMTP 服务器" htmlFor="smtp-host">
              <Input
                id="smtp-host"
                value={form.smtpHost}
                onChange={(event) => setForm((current) => ({ ...current, smtpHost: event.target.value }))}
                placeholder="smtp.example.com"
                autoComplete="off"
              />
            </Field>
            <Field label="端口" htmlFor="smtp-port">
              <Input
                id="smtp-port"
                type="number"
                min={1}
                max={65535}
                value={form.smtpPort}
                onChange={(event) => setForm((current) => ({ ...current, smtpPort: event.target.value }))}
              />
            </Field>
            <Field label="登录用户名" htmlFor="smtp-username">
              <Input
                id="smtp-username"
                value={form.smtpUsername}
                onChange={(event) => setForm((current) => ({ ...current, smtpUsername: event.target.value }))}
                autoComplete="username"
              />
            </Field>
            <Field label="登录密码" htmlFor="smtp-password">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="smtp-password"
                    type={showPassword ? 'text' : 'password'}
                    value={form.smtpPassword}
                    onChange={(event) => setForm((current) => ({ ...current, smtpPassword: event.target.value }))}
                    autoComplete="new-password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-surface-400 hover:text-surface-700 dark:hover:text-surface-200"
                    title={showPassword ? '隐藏密码' : '显示密码'}
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {settings?.smtp_password_configured ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setShowClearConfirm(true)}
                    disabled={isBusy}
                    title="清除 SMTP 密码"
                    aria-label="清除 SMTP 密码"
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                ) : null}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 text-xs text-surface-500 dark:text-surface-400">
                <KeyRound className="h-3.5 w-3.5" />
                {settings?.smtp_password_configured ? '已配置密码' : '未配置密码'}
              </div>
            </Field>
            <Field label="发件邮箱" htmlFor="smtp-from">
              <Input
                id="smtp-from"
                type="email"
                value={form.smtpFrom}
                onChange={(event) => setForm((current) => ({ ...current, smtpFrom: event.target.value }))}
                autoComplete="email"
              />
            </Field>
            <Field label="发件人名称" htmlFor="smtp-from-name">
              <Input
                id="smtp-from-name"
                value={form.smtpFromName}
                onChange={(event) => setForm((current) => ({ ...current, smtpFromName: event.target.value }))}
                maxLength={50}
              />
            </Field>
          </div>

          <label className="flex w-fit cursor-pointer items-center gap-3 text-sm text-surface-700 dark:text-surface-300">
            <input
              type="checkbox"
              checked={form.smtpUseTLS}
              onChange={(event) => setForm((current) => ({ ...current, smtpUseTLS: event.target.checked }))}
              className="h-4 w-4 rounded border-surface-300 text-primary-600 focus:ring-primary-500"
            />
            直接 TLS（关闭时使用 STARTTLS）
          </label>

          <div className="flex flex-wrap gap-3 border-t border-surface-200 pt-5 dark:border-surface-700">
            <Button onClick={handleSave} disabled={isBusy}>
              {activeAction === 'save' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              保存配置
            </Button>
            <Button variant="outline" onClick={handleTestConnection} disabled={isBusy}>
              {activeAction === 'test' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlugZap className="mr-2 h-4 w-4" />}
              测试连接
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-3 border-t border-surface-200 pt-5 dark:border-surface-700 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              type="email"
              value={testRecipient}
              onChange={(event) => setTestRecipient(event.target.value)}
              placeholder="测试收件邮箱"
              aria-label="测试收件邮箱"
            />
            <Button variant="secondary" onClick={handleSendTestEmail} disabled={isBusy}>
              {activeAction === 'send' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              发送测试邮件
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={handleClearPassword}
        loading={activeAction === 'clear'}
        title="清除 SMTP 密码"
        message="清除后，使用账号认证的 SMTP 服务将无法发送邮件。"
        confirmText="清除密码"
        confirmVariant="destructive"
        showIcon={false}
      />
    </>
  );
};

const Field: React.FC<{ label: string; htmlFor: string; children: React.ReactNode }> = ({
  label,
  htmlFor,
  children,
}) => (
  <div>
    <label htmlFor={htmlFor} className="mb-2 block text-sm font-medium text-surface-900 dark:text-surface-100">
      {label}
    </label>
    {children}
  </div>
);

const Feedback: React.FC<{ feedback: FeedbackState }> = ({ feedback }) => {
  const success = feedback.type === 'success';
  return (
    <div
      className={`flex items-center gap-2 rounded-md border p-3 text-sm ${
        success
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300'
          : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300'
      }`}
    >
      {success ? <MailCheck className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
      <span>{feedback.message}</span>
      {success ? <CheckCircle className="ml-auto h-4 w-4 shrink-0" /> : null}
    </div>
  );
};
