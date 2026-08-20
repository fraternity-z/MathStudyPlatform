import { useRef, useState } from 'react';
import { Image as ImageIcon, Loader2, Paperclip, X } from 'lucide-react';

import { toAppErrorFeedback, type AppErrorFeedback } from '@/libs/http/apiClient';
import { MAX_MESSAGE_ATTACHMENTS, type MessageAttachment } from '@/modules/message-center/attachmentTypes';
import { MessageImagePreview } from '@/modules/message-center/MessageImagePreview';
import { uploadService } from '@/modules/upload/services/uploadService';

interface MessageAttachmentPickerProps {
  value: MessageAttachment[];
  onChange: (attachments: MessageAttachment[]) => void;
  onUploadingChange?: (uploading: boolean) => void;
  onError?: (message: string) => void;
  onFeedback?: (feedback: AppErrorFeedback) => void;
  disabled?: boolean;
  onPendingChange?: (attachments: PendingMessageAttachment[]) => void;
}

type MessageAttachmentControlsProps = MessageAttachmentPickerProps;

interface MessageAttachmentSelectionProps {
  value: MessageAttachment[];
  onChange: (attachments: MessageAttachment[]) => void;
  disabled?: boolean;
}

export interface PendingMessageAttachment {
  id: string;
  name: string;
  kind: MessageAttachment['kind'];
  previewUrl?: string;
  progress: number;
}

const documentAccept = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
].join(',');

export function MessageAttachmentControls({
  value,
  onChange,
  onUploadingChange,
  onError,
  onFeedback,
  onPendingChange,
  disabled = false,
}: MessageAttachmentControlsProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<PendingMessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);

  const replacePending = (attachments: PendingMessageAttachment[]) => {
    pendingRef.current = attachments;
    onPendingChange?.(attachments);
  };

  const updatePendingProgress = (id: string, progress: number) => {
    replacePending(pendingRef.current.map((attachment) => attachment.id === id
      ? { ...attachment, progress }
      : attachment));
  };

  const uploadFiles = async (files: File[], kind: MessageAttachment['kind']) => {
    const available = MAX_MESSAGE_ATTACHMENTS - value.length;
    if (available <= 0) {
      onError?.(`每条消息最多添加 ${MAX_MESSAGE_ATTACHMENTS} 个附件`);
      return;
    }
    const selected = files.slice(0, available);
    if (files.length > available) {
      onError?.(`最多还能添加 ${available} 个附件`);
    }
    const validFiles = selected.filter((file) => {
      const validation = kind === 'image'
        ? uploadService.validateImageFile(file)
        : uploadService.validateDocumentFile(file);
      if (!validation.valid) onError?.(validation.error ?? '附件格式无效');
      return validation.valid;
    });
    if (validFiles.length === 0) return;

    const pending = validFiles.map((file, index) => ({
      id: `${Date.now()}-${index}-${file.name}`,
      name: file.name,
      kind,
      previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
      progress: 0,
    }));
    replacePending(pending);

    setUploading(true);
    onUploadingChange?.(true);
    try {
      const results = await Promise.allSettled(validFiles.map(async (file, index): Promise<MessageAttachment> => {
        const reportProgress = (progress: number) => updatePendingProgress(pending[index].id, progress);
        const response = kind === 'image'
          ? await uploadService.uploadImage(file, reportProgress)
          : await uploadService.uploadMessageFile(file, reportProgress);
        return {
          url: response.url,
          name: file.name,
          kind,
          content_type: response.content_type,
          size: response.size,
        };
      }));
      const uploaded = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      if (uploaded.length > 0) {
        onChange([...value, ...uploaded]);
      }
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) {
        const feedback = toAppErrorFeedback(failures[0].reason, '附件上传失败');
        if (feedback) {
          if (onFeedback) {
            onFeedback({
              ...feedback,
              description: failures.length === 1
                ? feedback.description
                : `${failures.length} 个附件上传失败：${feedback.description}`,
            });
          } else {
            const detail = feedback.description;
            onError?.(failures.length === 1 ? detail : `${failures.length} 个附件上传失败：${detail}`);
          }
        }
      }
    } finally {
      pendingRef.current.forEach((attachment) => {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      });
      replacePending([]);
      setUploading(false);
      onUploadingChange?.(false);
      if (imageInputRef.current) imageInputRef.current.value = '';
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const controlsDisabled = disabled || uploading || value.length >= MAX_MESSAGE_ATTACHMENTS;

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        title="添加文件"
        aria-label="添加文件"
        disabled={controlsDisabled}
        onClick={() => fileInputRef.current?.click()}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-surface-400 dark:hover:bg-surface-700 dark:hover:text-surface-100"
      >
        <Paperclip className="h-5 w-5" />
      </button>
      <button
        type="button"
        title="添加图片"
        aria-label="添加图片"
        disabled={controlsDisabled}
        onClick={() => imageInputRef.current?.click()}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-surface-400 dark:hover:bg-surface-700 dark:hover:text-surface-100"
      >
        <ImageIcon className="h-5 w-5" />
      </button>
      {uploading && <Loader2 className="mx-1 h-4 w-4 shrink-0 animate-spin text-surface-400" aria-label="附件上传中" />}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []), 'image')}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept={documentAccept}
        multiple
        className="hidden"
        onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []), 'file')}
      />
    </div>
  );
}

export function MessageAttachmentSelection({ value, onChange, disabled = false }: MessageAttachmentSelectionProps) {
  const [previewImage, setPreviewImage] = useState<MessageAttachment | null>(null);

  if (value.length === 0) return null;

  return (
    <>
      <div className="flex flex-col items-start gap-2">
        {value.map((attachment, index) => (
          <div key={`${attachment.url}-${index}`} className="flex w-full max-w-sm items-center gap-1.5 rounded-md border border-surface-200 bg-surface-50 p-1.5 text-xs text-surface-700 dark:border-surface-700 dark:bg-surface-800 dark:text-surface-200">
            {attachment.kind === 'image' ? (
              <button
                type="button"
                title={`查看图片 ${attachment.name}`}
                onClick={() => setPreviewImage(attachment)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:text-surface-900 dark:hover:text-white"
              >
                <img src={attachment.url} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
                <span className="truncate">{attachment.name}</span>
              </button>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-2 px-1">
                <Paperclip className="h-4 w-4 shrink-0" />
                <span className="truncate">{attachment.name}</span>
              </span>
            )}
            <button
              type="button"
              title="移除附件"
              aria-label={`移除附件 ${attachment.name}`}
              disabled={disabled}
              onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-surface-400 hover:bg-surface-200 hover:text-surface-700 disabled:opacity-40 dark:hover:bg-surface-700 dark:hover:text-surface-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <MessageImagePreview image={previewImage} onClose={() => setPreviewImage(null)} />
    </>
  );
}

export function MessageAttachmentPendingList({ value }: { value: PendingMessageAttachment[] }) {
  if (value.length === 0) return null;

  return (
    <div className="flex flex-col items-start gap-2" aria-live="polite">
      {value.map((attachment) => (
        <div key={attachment.id} className="flex w-full max-w-sm items-center gap-2 rounded-md border border-surface-200 bg-surface-50 p-2 text-xs text-surface-700 dark:border-surface-700 dark:bg-surface-800 dark:text-surface-200">
          {attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
          ) : (
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded bg-white dark:bg-surface-900">
              <Paperclip className="h-4 w-4 text-surface-400" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate">{attachment.name}</span>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-700">
              <span className="block h-full rounded-full bg-primary-500 transition-[width]" style={{ width: `${attachment.progress}%` }} />
            </span>
          </span>
          <span className="w-10 shrink-0 text-right tabular-nums text-surface-400">{attachment.progress}%</span>
        </div>
      ))}
    </div>
  );
}

export function MessageAttachmentPicker(props: MessageAttachmentPickerProps) {
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<PendingMessageAttachment[]>([]);

  return (
    <div className="space-y-2">
      <MessageAttachmentControls
        {...props}
        onUploadingChange={(nextUploading) => {
          setUploading(nextUploading);
          props.onUploadingChange?.(nextUploading);
        }}
        onPendingChange={setPending}
      />
      <MessageAttachmentPendingList value={pending} />
      <MessageAttachmentSelection
        value={props.value}
        onChange={props.onChange}
        disabled={props.disabled || uploading}
      />
    </div>
  );
}
