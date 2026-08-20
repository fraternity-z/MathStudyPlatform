import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  Loader2,
  PlugZap,
  Save,
  Server,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';
import {
  systemSettingService,
  type StorageBackend,
  type StorageSettings,
  type StorageSettingsUpdate,
} from '@/modules/admin/services/systemSettingService';
import { isAdminRequestCancelled, toAdminAppError } from '@/modules/admin/utils/errorFeedback';

interface StorageFormState {
  backend: StorageBackend;
  qiniu: {
    accessKey: string;
    secretKey: string;
    bucketName: string;
    domain: string;
    privateBucket: boolean;
    urlExpireSeconds: string;
    uploadURL: string;
  };
  s3: {
    endpointURL: string;
    accessKey: string;
    secretKey: string;
    bucketName: string;
    region: string;
    publicURLBase: string;
    privateBucket: boolean;
    urlExpireSeconds: string;
  };
}

interface FeedbackState {
  type: 'success' | 'error';
  message: string;
}

const emptyForm: StorageFormState = {
  backend: 'local',
  qiniu: {
    accessKey: '',
    secretKey: '',
    bucketName: '',
    domain: '',
    privateBucket: false,
    urlExpireSeconds: '3600',
    uploadURL: 'https://upload.qiniup.com',
  },
  s3: {
    endpointURL: '',
    accessKey: '',
    secretKey: '',
    bucketName: '',
    region: 'us-east-1',
    publicURLBase: '',
    privateBucket: false,
    urlExpireSeconds: '3600',
  },
};

const settingsToForm = (settings: StorageSettings): StorageFormState => ({
  backend: settings.backend,
  qiniu: {
    accessKey: '',
    secretKey: '',
    bucketName: settings.qiniu.bucket_name,
    domain: settings.qiniu.domain,
    privateBucket: settings.qiniu.private_bucket,
    urlExpireSeconds: String(settings.qiniu.url_expire_seconds),
    uploadURL: settings.qiniu.upload_url,
  },
  s3: {
    endpointURL: settings.s3.endpoint_url,
    accessKey: '',
    secretKey: '',
    bucketName: settings.s3.bucket_name,
    region: settings.s3.region,
    publicURLBase: settings.s3.public_url_base,
    privateBucket: settings.s3.private_bucket,
    urlExpireSeconds: String(settings.s3.url_expire_seconds),
  },
});

const backendOptions: Array<{ value: StorageBackend; label: string; icon: React.ElementType }> = [
  { value: 'local', label: '本地存储', icon: HardDrive },
  { value: 'qiniu', label: '七牛云', icon: Cloud },
  { value: 's3', label: 'S3 兼容', icon: Server },
];

export const StorageSettingsCard: React.FC = () => {
  const [form, setForm] = useState<StorageFormState>(emptyForm);
  const [settings, setSettings] = useState<StorageSettings | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [requestError, setRequestError] = useState<AppError | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeAction, setActiveAction] = useState<'save' | 'test' | null>(null);
  const [visibleCredential, setVisibleCredential] = useState<string | null>(null);

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
      setIsLoading(true);
      setRequestError(null);
      try {
        const data = await systemSettingService.getStorageSettings(signal);
        if (signal?.aborted) return;
        setSettings(data);
        setForm(settingsToForm(data));
      } catch (error) {
        if (signal?.aborted || isAdminRequestCancelled(error)) return;
        setRequestError(toAdminAppError(error, '加载存储配置失败'));
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
    if (form.backend === 'local') {
      if (!settings?.local.configured) {
        setFeedback({ type: 'error', message: '本地存储目录未配置' });
        return false;
      }
      return true;
    }

    const expire = Number(
      form.backend === 'qiniu' ? form.qiniu.urlExpireSeconds : form.s3.urlExpireSeconds
    );
    if (!Number.isInteger(expire) || expire < 1 || expire > 604_800) {
      setFeedback({ type: 'error', message: 'URL 有效期必须是 1 到 604800 秒之间的整数' });
      return false;
    }

    if (form.backend === 'qiniu') {
      if (!form.qiniu.bucketName.trim() || !form.qiniu.domain.trim() || !form.qiniu.uploadURL.trim()) {
        setFeedback({ type: 'error', message: '请填写七牛云存储空间、访问域名和上传地址' });
        return false;
      }
      if (!settings?.qiniu.access_key_configured && !form.qiniu.accessKey.trim()) {
        setFeedback({ type: 'error', message: '请填写七牛云 Access Key' });
        return false;
      }
      if (!settings?.qiniu.secret_key_configured && !form.qiniu.secretKey.trim()) {
        setFeedback({ type: 'error', message: '请填写七牛云 Secret Key' });
        return false;
      }
      if (!validHTTPURL(form.qiniu.domain) || !validHTTPURL(form.qiniu.uploadURL)) {
        setFeedback({ type: 'error', message: '七牛云地址必须是有效的 HTTP 或 HTTPS URL' });
        return false;
      }
      return true;
    }

    if (!form.s3.endpointURL.trim() || !form.s3.bucketName.trim() || !form.s3.region.trim()) {
      setFeedback({ type: 'error', message: '请填写 S3 服务地址、存储桶和区域' });
      return false;
    }
    if (!settings?.s3.access_key_configured && !form.s3.accessKey.trim()) {
      setFeedback({ type: 'error', message: '请填写 S3 Access Key' });
      return false;
    }
    if (!settings?.s3.secret_key_configured && !form.s3.secretKey.trim()) {
      setFeedback({ type: 'error', message: '请填写 S3 Secret Key' });
      return false;
    }
    if (!validHTTPURL(form.s3.endpointURL) || (form.s3.publicURLBase && !validHTTPURL(form.s3.publicURLBase))) {
      setFeedback({ type: 'error', message: 'S3 地址必须是有效的 HTTP 或 HTTPS URL' });
      return false;
    }
    return true;
  };

  const draftPayload = (): StorageSettingsUpdate => ({
    backend: form.backend,
    qiniu: {
      access_key: form.qiniu.accessKey.trim() || undefined,
      secret_key: form.qiniu.secretKey.trim() || undefined,
      bucket_name: form.qiniu.bucketName.trim(),
      domain: form.qiniu.domain.trim(),
      private_bucket: form.qiniu.privateBucket,
      url_expire_seconds: Number(form.qiniu.urlExpireSeconds),
      upload_url: form.qiniu.uploadURL.trim(),
    },
    s3: {
      endpoint_url: form.s3.endpointURL.trim(),
      access_key: form.s3.accessKey.trim() || undefined,
      secret_key: form.s3.secretKey.trim() || undefined,
      bucket_name: form.s3.bucketName.trim(),
      region: form.s3.region.trim(),
      public_url_base: form.s3.publicURLBase.trim(),
      private_bucket: form.s3.privateBucket,
      url_expire_seconds: Number(form.s3.urlExpireSeconds),
    },
  });

  const handleSave = async () => {
    setFeedback(null);
    setRequestError(null);
    if (!validateForm()) return;
    setActiveAction('save');
    try {
      const updated = await systemSettingService.updateStorageSettings(draftPayload());
      setSettings(updated);
      setForm(settingsToForm(updated));
      setFeedback({ type: 'success', message: '存储配置已保存并即时生效' });
    } catch (error) {
      if (!isAdminRequestCancelled(error)) {
        setRequestError(toAdminAppError(error, '保存存储配置失败'));
      }
    } finally {
      setActiveAction(null);
    }
  };

  const handleTest = async () => {
    setFeedback(null);
    setRequestError(null);
    if (!validateForm()) return;
    setActiveAction('test');
    try {
      const result = await systemSettingService.testStorageConnection(draftPayload());
      setFeedback({ type: 'success', message: `${result.message}（${result.latency_ms} ms）` });
    } catch (error) {
      if (!isAdminRequestCancelled(error)) {
        setRequestError(toAdminAppError(error, '存储连接测试失败'));
      }
    } finally {
      setActiveAction(null);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <HardDrive className="h-5 w-5" />
            对象存储
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
            <HardDrive className="h-5 w-5" />
            对象存储
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RequestErrorNotice
            error={requestError}
            onRetry={() => void loadSettings()}
            onRefresh={() => void loadSettings()}
          />
        </CardContent>
      </Card>
    );
  }

  const isBusy = activeAction !== null;
  const hasStoredConfig = settings?.source === 'database';
  const activeConfigured =
    hasStoredConfig &&
    (form.backend === 'local'
      ? settings?.local.configured
      : form.backend === 'qiniu'
        ? settings?.qiniu.configured
        : settings?.s3.configured);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl">
              <HardDrive className="h-5 w-5" />
              对象存储
            </CardTitle>
            <CardDescription>上传文件与答案图片存储</CardDescription>
          </div>
          <div className="flex items-center gap-2 text-sm text-surface-600 dark:text-surface-400">
            <span className={`h-2.5 w-2.5 rounded-full ${activeConfigured ? 'bg-emerald-500' : 'bg-surface-300 dark:bg-surface-600'}`} />
            <span>{hasStoredConfig ? '数据库配置' : '待配置'}</span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {requestError ? (
          <RequestErrorNotice
            error={requestError}
            onRetry={settings ? undefined : () => void loadSettings()}
            onRefresh={settings ? undefined : () => void loadSettings()}
            onDismiss={() => setRequestError(null)}
          />
        ) : null}
        {feedback ? <Feedback feedback={feedback} /> : null}

        <div className="grid h-12 grid-cols-3 overflow-hidden rounded-md border border-surface-200 dark:border-surface-700">
          {backendOptions.map(({ value, label, icon: Icon }, index) => {
            const selected = form.backend === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setForm((current) => ({ ...current, backend: value }));
                  setFeedback(null);
                }}
                disabled={isBusy}
                aria-pressed={selected}
                className={`flex min-w-0 items-center justify-center gap-2 px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50 ${
                  index > 0 ? 'border-l border-surface-200 dark:border-surface-700' : ''
                } ${
                  selected
                    ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                    : 'bg-white text-surface-600 hover:bg-surface-50 dark:bg-surface-900 dark:text-surface-400 dark:hover:bg-surface-800'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>

        {form.backend === 'local' ? (
          <div className="flex min-h-24 items-center gap-4 border-y border-surface-200 py-5 dark:border-surface-700">
            <HardDrive className="h-7 w-7 shrink-0 text-surface-500" />
            <div className="min-w-0">
              <div className="font-medium text-surface-900 dark:text-surface-100">本地文件系统</div>
              <div className="mt-1 text-sm text-surface-500 dark:text-surface-400">
                {settings?.local.configured ? '存储目录已配置' : '存储目录未配置'}
              </div>
            </div>
          </div>
        ) : null}

        {form.backend === 'qiniu' ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <CredentialField
              id="qiniu-access-key"
              label="Access Key"
              value={form.qiniu.accessKey}
              configured={settings?.qiniu.access_key_configured ?? false}
              visible={visibleCredential === 'qiniu-access-key'}
              onVisibilityChange={() => setVisibleCredential((current) => current === 'qiniu-access-key' ? null : 'qiniu-access-key')}
              onChange={(value) => setForm((current) => ({ ...current, qiniu: { ...current.qiniu, accessKey: value } }))}
            />
            <CredentialField
              id="qiniu-secret-key"
              label="Secret Key"
              value={form.qiniu.secretKey}
              configured={settings?.qiniu.secret_key_configured ?? false}
              visible={visibleCredential === 'qiniu-secret-key'}
              onVisibilityChange={() => setVisibleCredential((current) => current === 'qiniu-secret-key' ? null : 'qiniu-secret-key')}
              onChange={(value) => setForm((current) => ({ ...current, qiniu: { ...current.qiniu, secretKey: value } }))}
            />
            <Field label="存储空间" htmlFor="qiniu-bucket">
              <Input id="qiniu-bucket" value={form.qiniu.bucketName} onChange={(event) => setForm((current) => ({ ...current, qiniu: { ...current.qiniu, bucketName: event.target.value } }))} autoComplete="off" />
            </Field>
            <Field label="访问域名" htmlFor="qiniu-domain">
              <Input id="qiniu-domain" type="url" value={form.qiniu.domain} onChange={(event) => setForm((current) => ({ ...current, qiniu: { ...current.qiniu, domain: event.target.value } }))} placeholder="https://cdn.example.com" autoComplete="url" />
            </Field>
            <Field label="上传地址" htmlFor="qiniu-upload-url">
              <Input id="qiniu-upload-url" type="url" value={form.qiniu.uploadURL} onChange={(event) => setForm((current) => ({ ...current, qiniu: { ...current.qiniu, uploadURL: event.target.value } }))} autoComplete="url" />
            </Field>
            <Field label="私有 URL 有效期（秒）" htmlFor="qiniu-expire">
              <Input id="qiniu-expire" type="number" min={1} max={604800} step={1} value={form.qiniu.urlExpireSeconds} onChange={(event) => setForm((current) => ({ ...current, qiniu: { ...current.qiniu, urlExpireSeconds: event.target.value } }))} />
            </Field>
            <PrivateBucketField checked={form.qiniu.privateBucket} onChange={(checked) => setForm((current) => ({ ...current, qiniu: { ...current.qiniu, privateBucket: checked } }))} />
          </div>
        ) : null}

        {form.backend === 's3' ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="服务地址" htmlFor="s3-endpoint">
              <Input id="s3-endpoint" type="url" value={form.s3.endpointURL} onChange={(event) => setForm((current) => ({ ...current, s3: { ...current.s3, endpointURL: event.target.value } }))} placeholder="https://s3.example.com" autoComplete="url" />
            </Field>
            <Field label="存储桶" htmlFor="s3-bucket">
              <Input id="s3-bucket" value={form.s3.bucketName} onChange={(event) => setForm((current) => ({ ...current, s3: { ...current.s3, bucketName: event.target.value } }))} autoComplete="off" />
            </Field>
            <CredentialField
              id="s3-access-key"
              label="Access Key"
              value={form.s3.accessKey}
              configured={settings?.s3.access_key_configured ?? false}
              visible={visibleCredential === 's3-access-key'}
              onVisibilityChange={() => setVisibleCredential((current) => current === 's3-access-key' ? null : 's3-access-key')}
              onChange={(value) => setForm((current) => ({ ...current, s3: { ...current.s3, accessKey: value } }))}
            />
            <CredentialField
              id="s3-secret-key"
              label="Secret Key"
              value={form.s3.secretKey}
              configured={settings?.s3.secret_key_configured ?? false}
              visible={visibleCredential === 's3-secret-key'}
              onVisibilityChange={() => setVisibleCredential((current) => current === 's3-secret-key' ? null : 's3-secret-key')}
              onChange={(value) => setForm((current) => ({ ...current, s3: { ...current.s3, secretKey: value } }))}
            />
            <Field label="区域" htmlFor="s3-region">
              <Input id="s3-region" value={form.s3.region} onChange={(event) => setForm((current) => ({ ...current, s3: { ...current.s3, region: event.target.value } }))} autoComplete="off" />
            </Field>
            <Field label="公共访问地址" htmlFor="s3-public-url">
              <Input id="s3-public-url" type="url" value={form.s3.publicURLBase} onChange={(event) => setForm((current) => ({ ...current, s3: { ...current.s3, publicURLBase: event.target.value } }))} placeholder="https://cdn.example.com" autoComplete="url" />
            </Field>
            <Field label="私有 URL 有效期（秒）" htmlFor="s3-expire">
              <Input id="s3-expire" type="number" min={1} max={604800} step={1} value={form.s3.urlExpireSeconds} onChange={(event) => setForm((current) => ({ ...current, s3: { ...current.s3, urlExpireSeconds: event.target.value } }))} />
            </Field>
            <PrivateBucketField checked={form.s3.privateBucket} onChange={(checked) => setForm((current) => ({ ...current, s3: { ...current.s3, privateBucket: checked } }))} />
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3 border-t border-surface-200 pt-5 dark:border-surface-700">
          <Button onClick={handleSave} disabled={isBusy}>
            {activeAction === 'save' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            保存并应用
          </Button>
          <Button variant="outline" onClick={handleTest} disabled={isBusy}>
            {activeAction === 'test' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlugZap className="mr-2 h-4 w-4" />}
            测试连接
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

const Field: React.FC<{ label: string; htmlFor: string; children: React.ReactNode }> = ({ label, htmlFor, children }) => (
  <div>
    <label htmlFor={htmlFor} className="mb-2 block text-sm font-medium text-surface-900 dark:text-surface-100">
      {label}
    </label>
    {children}
  </div>
);

const CredentialField: React.FC<{
  id: string;
  label: string;
  value: string;
  configured: boolean;
  visible: boolean;
  onVisibilityChange: () => void;
  onChange: (value: string) => void;
}> = ({ id, label, value, configured, visible, onVisibilityChange, onChange }) => (
  <Field label={label} htmlFor={id}>
    <div className="relative">
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={configured ? '已配置，留空保持不变' : ''}
        autoComplete="new-password"
        className="pr-10"
      />
      <button
        type="button"
        onClick={onVisibilityChange}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-surface-400 hover:text-surface-700 dark:hover:text-surface-200"
        title={visible ? '隐藏凭据' : '显示凭据'}
        aria-label={visible ? '隐藏凭据' : '显示凭据'}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
    <div className="mt-1.5 flex items-center gap-1.5 text-xs text-surface-500 dark:text-surface-400">
      <KeyRound className="h-3.5 w-3.5" />
      {configured ? '已配置' : '未配置'}
    </div>
  </Field>
);

const PrivateBucketField: React.FC<{ checked: boolean; onChange: (checked: boolean) => void }> = ({ checked, onChange }) => (
  <label className="flex min-h-10 cursor-pointer items-center gap-3 self-end text-sm text-surface-700 dark:text-surface-300">
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      className="h-4 w-4 rounded border-surface-300 text-primary-600 focus:ring-primary-500"
    />
    私有存储空间
  </label>
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
      {success ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
      <span>{feedback.message}</span>
    </div>
  );
};

function validHTTPURL(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
