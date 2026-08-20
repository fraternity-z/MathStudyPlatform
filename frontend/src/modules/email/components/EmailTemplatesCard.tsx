import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle,
  Eye,
  FileText,
  Loader2,
  Pencil,
  RotateCcw,
  Save,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';
import { isAdminRequestCancelled, toAdminAppError } from '@/modules/admin/utils/errorFeedback';
import { adminEmailService } from '@/modules/email/services/adminEmailService';
import type {
  EmailTemplate,
  EmailTemplatePreviewResponse,
} from '@/modules/email/types/email';

interface TemplateDraft {
  subject: string;
  htmlBody: string;
}

interface FeedbackState {
  type: 'success';
  message: string;
}

const templateIdentity = (template: EmailTemplate): string => `${template.event}:${template.locale}`;

export const EmailTemplatesCard: React.FC = () => {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [draft, setDraft] = useState<TemplateDraft>({ subject: '', htmlBody: '' });
  const [preview, setPreview] = useState<EmailTemplatePreviewResponse | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<EmailTemplate | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [requestError, setRequestError] = useState<AppError | null>(null);
  const [editorError, setEditorError] = useState<AppError | null>(null);
  const [editorFailedAction, setEditorFailedAction] = useState<'save' | 'preview' | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeAction, setActiveAction] = useState<'save' | 'preview' | 'restore' | null>(null);

  const loadTemplates = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    setRequestError(null);
    try {
      const response = await adminEmailService.listTemplates(signal);
      if (!signal?.aborted) setTemplates(response.items);
    } catch (error) {
      if (signal?.aborted || isAdminRequestCancelled(error)) return;
      setRequestError(toAdminAppError(error, '加载邮件模板失败'));
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadTemplates(controller.signal);
    return () => controller.abort();
  }, [loadTemplates]);

  const replaceTemplate = (updated: EmailTemplate) => {
    setTemplates((current) =>
      current.map((template) =>
        templateIdentity(template) === templateIdentity(updated) ? updated : template,
      ),
    );
  };

  const openEditor = (template: EmailTemplate) => {
    setEditing(template);
    setDraft({ subject: template.subject, htmlBody: template.html_body });
    setPreview(null);
    setEditorError(null);
    setEditorFailedAction(null);
  };

  const closeEditor = () => {
    if (activeAction !== null) return;
    setEditing(null);
    setPreview(null);
    setEditorError(null);
    setEditorFailedAction(null);
  };

  const openPreview = async (template: EmailTemplate) => {
    openEditor(template);
    setEditorFailedAction(null);
    setActiveAction('preview');
    try {
      const result = await adminEmailService.previewTemplate({
        event: template.event,
        locale: template.locale,
        subject: template.subject,
        html_body: template.html_body,
      });
      setPreview(result);
    } catch (error) {
      if (!isAdminRequestCancelled(error)) {
        setEditorError(toAdminAppError(error, '预览邮件模板失败'));
        setEditorFailedAction('preview');
      }
    } finally {
      setActiveAction(null);
    }
  };

  const handlePreview = async () => {
    if (!editing) return;
    setEditorError(null);
    setEditorFailedAction(null);
    setActiveAction('preview');
    try {
      const result = await adminEmailService.previewTemplate({
        event: editing.event,
        locale: editing.locale,
        subject: draft.subject,
        html_body: draft.htmlBody,
      });
      setPreview(result);
    } catch (error) {
      if (!isAdminRequestCancelled(error)) {
        setEditorError(toAdminAppError(error, '预览邮件模板失败'));
        setEditorFailedAction('preview');
      }
    } finally {
      setActiveAction(null);
    }
  };

  const handleSave = async () => {
    if (!editing) return;
    setEditorError(null);
    setEditorFailedAction(null);
    setActiveAction('save');
    try {
      const updated = await adminEmailService.updateTemplate(editing.event, editing.locale, {
        subject: draft.subject,
        html_body: draft.htmlBody,
      });
      replaceTemplate(updated);
      setEditing(null);
      setPreview(null);
      setFeedback({ type: 'success', message: `${updated.name}模板已保存` });
    } catch (error) {
      if (!isAdminRequestCancelled(error)) {
        setEditorError(toAdminAppError(error, '保存邮件模板失败'));
        setEditorFailedAction('save');
      }
    } finally {
      setActiveAction(null);
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    setFeedback(null);
    setRequestError(null);
    setActiveAction('restore');
    try {
      const restored = await adminEmailService.restoreTemplate(
        restoreTarget.event,
        restoreTarget.locale,
      );
      replaceTemplate(restored);
      if (editing && templateIdentity(editing) === templateIdentity(restored)) {
        setEditing(restored);
        setDraft({ subject: restored.subject, htmlBody: restored.html_body });
        setPreview(null);
        setEditorError(null);
      }
      setRestoreTarget(null);
      setFeedback({ type: 'success', message: `${restored.name}模板已恢复` });
    } catch (error) {
      if (!isAdminRequestCancelled(error)) {
        setRequestError(toAdminAppError(error, '恢复官方模板失败'));
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
            <FileText className="h-5 w-5" />
            通知模板
          </CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-surface-400" />
        </CardContent>
      </Card>
    );
  }

  if (requestError && templates.length === 0 && !restoreTarget) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <FileText className="h-5 w-5" />
            通知模板
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RequestErrorNotice
            error={requestError}
            onRetry={requestError.kind === 'conflict' ? undefined : () => void loadTemplates()}
            onRefresh={() => void loadTemplates()}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <FileText className="h-5 w-5" />
            通知模板
          </CardTitle>
          <CardDescription>账号与密码恢复邮件</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {requestError && !restoreTarget ? (
            <RequestErrorNotice
              error={requestError}
              onRetry={requestError.kind === 'conflict' ? undefined : () => void loadTemplates()}
              onRefresh={() => void loadTemplates()}
              onDismiss={() => setRequestError(null)}
            />
          ) : null}
          {feedback ? <Feedback feedback={feedback} /> : null}
          <div className="overflow-x-auto rounded-md border border-surface-200 dark:border-surface-700">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-surface-200 bg-surface-50 dark:border-surface-700 dark:bg-surface-800">
                  <th className="px-4 py-3 text-left font-medium text-surface-600 dark:text-surface-400">模板</th>
                  <th className="px-4 py-3 text-left font-medium text-surface-600 dark:text-surface-400">语言</th>
                  <th className="px-4 py-3 text-left font-medium text-surface-600 dark:text-surface-400">状态</th>
                  <th className="px-4 py-3 text-left font-medium text-surface-600 dark:text-surface-400">更新时间</th>
                  <th className="px-4 py-3 text-right font-medium text-surface-600 dark:text-surface-400">操作</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((template) => (
                  <tr
                    key={templateIdentity(template)}
                    className="border-b border-surface-100 last:border-0 dark:border-surface-800"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-surface-900 dark:text-surface-100">{template.name}</div>
                      <div className="mt-0.5 font-mono text-xs text-surface-400">{template.event}</div>
                    </td>
                    <td className="px-4 py-3 text-surface-600 dark:text-surface-400">
                      {localeLabel(template.locale)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`font-medium ${
                          template.is_custom
                            ? 'text-primary-600 dark:text-primary-400'
                            : 'text-surface-500 dark:text-surface-400'
                        }`}
                      >
                        {template.is_custom ? '自定义' : '官方'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-surface-500 dark:text-surface-400">
                      {template.updated_at ? formatUpdatedAt(template.updated_at) : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openEditor(template)}
                          title="编辑模板"
                          aria-label={`编辑${template.name}${localeLabel(template.locale)}模板`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => void openPreview(template)}
                          title="预览模板"
                          aria-label={`预览${template.name}${localeLabel(template.locale)}模板`}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setRestoreTarget(template)}
                          disabled={!template.is_custom || activeAction !== null}
                          title="恢复官方模板"
                          aria-label={`恢复${template.name}${localeLabel(template.locale)}官方模板`}
                        >
                          <RotateCcw className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <TemplateEditorModal
        template={editing}
        draft={draft}
        preview={preview}
        error={editorError}
        failedAction={editorFailedAction}
        activeAction={activeAction}
        onClose={closeEditor}
        onDraftChange={(next) => {
          setDraft(next);
          setPreview(null);
        }}
        onPreview={handlePreview}
        onSave={handleSave}
        onRefresh={() => {
          closeEditor();
          void loadTemplates();
        }}
      />

      <ConfirmDialog
        isOpen={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        onConfirm={handleRestore}
        loading={activeAction === 'restore'}
        title="恢复官方模板"
        message={restoreTarget ? (
          <div className="space-y-3">
            <p>{`${restoreTarget.name}（${localeLabel(restoreTarget.locale)}）将恢复为官方内容。`}</p>
            {requestError ? (
              <RequestErrorNotice
                error={requestError}
                onRetry={requestError.kind === 'conflict' ? undefined : () => void handleRestore()}
                onRefresh={() => {
                  setRestoreTarget(null);
                  void loadTemplates();
                }}
              />
            ) : null}
          </div>
        ) : ''}
        confirmText="恢复模板"
        confirmVariant="primary"
        showIcon={false}
      />
    </>
  );
};

interface TemplateEditorModalProps {
  template: EmailTemplate | null;
  draft: TemplateDraft;
  preview: EmailTemplatePreviewResponse | null;
  error: AppError | null;
  failedAction: 'save' | 'preview' | null;
  activeAction: 'save' | 'preview' | 'restore' | null;
  onClose: () => void;
  onDraftChange: (draft: TemplateDraft) => void;
  onPreview: () => void;
  onSave: () => void;
  onRefresh: () => void;
}

const TemplateEditorModal: React.FC<TemplateEditorModalProps> = ({
  template,
  draft,
  preview,
  error,
  failedAction,
  activeAction,
  onClose,
  onDraftChange,
  onPreview,
  onSave,
  onRefresh,
}) => (
  <Modal
    isOpen={template !== null}
    onClose={onClose}
    title={template ? `${template.name} · ${localeLabel(template.locale)}` : '邮件模板'}
    className="max-h-[92vh] max-w-5xl overflow-y-auto"
  >
    {template ? (
      <div className="relative z-10 space-y-5">
        {error ? (
          <RequestErrorNotice
            error={error}
            onRetry={activeAction === null
              ? error.kind === 'conflict'
                ? undefined
                : failedAction === 'save' ? onSave : onPreview
              : undefined}
            onRefresh={onRefresh}
          />
        ) : null}

        <div className="text-xs text-surface-500 dark:text-surface-400">
          变量：{template.variables.map((variable) => `{{.${variable}}}`).join('、')}
        </div>

        <div>
          <label htmlFor="email-template-subject" className="mb-2 block text-sm font-medium text-surface-900 dark:text-surface-100">
            主题
          </label>
          <Input
            id="email-template-subject"
            value={draft.subject}
            onChange={(event) => onDraftChange({ ...draft, subject: event.target.value })}
            maxLength={200}
          />
        </div>

        <div>
          <label htmlFor="email-template-body" className="mb-2 block text-sm font-medium text-surface-900 dark:text-surface-100">
            HTML 正文
          </label>
          <textarea
            id="email-template-body"
            value={draft.htmlBody}
            onChange={(event) => onDraftChange({ ...draft, htmlBody: event.target.value })}
            rows={14}
            className="w-full resize-y rounded-md border border-surface-200 bg-white px-3 py-2 font-mono text-sm text-surface-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-surface-700 dark:bg-surface-800 dark:text-surface-100"
          />
        </div>

        {preview ? (
          <div className="space-y-3 border-t border-surface-200 pt-5 dark:border-surface-700">
            <div>
              <div className="mb-1 text-xs font-medium text-surface-500 dark:text-surface-400">预览主题</div>
              <div className="break-words text-sm font-medium text-surface-900 dark:text-surface-100">{preview.subject}</div>
            </div>
            <iframe
              title="邮件模板预览"
              srcDoc={preview.html_body}
              sandbox=""
              className="h-96 w-full rounded-md border border-surface-200 bg-white dark:border-surface-700"
            />
          </div>
        ) : null}

        <div className="flex flex-wrap justify-end gap-3 border-t border-surface-200 pt-5 dark:border-surface-700">
          <Button variant="outline" onClick={onClose} disabled={activeAction !== null}>
            取消
          </Button>
          <Button variant="outline" onClick={onPreview} disabled={activeAction !== null}>
            {activeAction === 'preview' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
            预览
          </Button>
          <Button onClick={onSave} disabled={activeAction !== null}>
            {activeAction === 'save' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            保存模板
          </Button>
        </div>
      </div>
    ) : null}
  </Modal>
);

const Feedback: React.FC<{ feedback: FeedbackState }> = ({ feedback }) => {
  return (
    <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300">
      <CheckCircle className="h-4 w-4 shrink-0" />
      {feedback.message}
    </div>
  );
};

const localeLabel = (locale: string): string => (locale === 'zh-CN' ? '中文' : 'English');

const formatUpdatedAt = (value: string): string =>
  new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
