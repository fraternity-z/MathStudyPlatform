import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Send } from 'lucide-react';

import { IconTooltip } from '@/components/ui/IconTooltip';
import { cn } from '@/libs/utils/cn';
import {
  MessageAttachmentControls,
  MessageAttachmentPendingList,
  MessageAttachmentSelection,
  type PendingMessageAttachment,
} from '@/modules/message-center/MessageAttachmentPicker';
import type { MessageAttachment } from '@/modules/message-center/attachmentTypes';
import type { AppErrorFeedback } from '@/libs/http/apiClient';

interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

interface SpeechRecognitionEventLike {
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

interface MessageComposerProps {
  value: string;
  onChange: (value: string) => void;
  attachments: MessageAttachment[];
  onAttachmentsChange: (attachments: MessageAttachment[]) => void;
  onUploadingChange?: (uploading: boolean) => void;
  onError?: (message: string) => void;
  onFeedback?: (feedback: AppErrorFeedback) => void;
  onSend: () => void | Promise<void>;
  placeholder: string;
  sendLabel?: string;
  disabled?: boolean;
  uploading?: boolean;
  sending?: boolean;
  allowAttachmentOnly?: boolean;
  maxLength?: number;
  className?: string;
}

function speechErrorMessage(error: string): string {
  if (error === 'not-allowed' || error === 'service-not-allowed') return '未获得麦克风权限';
  if (error === 'audio-capture') return '未检测到可用的麦克风';
  if (error === 'no-speech') return '未识别到语音，请再试一次';
  if (error === 'network') return '语音识别网络异常，请稍后重试';
  return '语音识别失败，请稍后重试';
}

export function MessageComposer({
  value,
  onChange,
  attachments,
  onAttachmentsChange,
  onUploadingChange,
  onError,
  onFeedback,
  onSend,
  placeholder,
  sendLabel = '发送',
  disabled = false,
  uploading = false,
  sending = false,
  allowAttachmentOnly = true,
  maxLength,
  className,
}: MessageComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const speechBaseValueRef = useRef('');
  const [listening, setListening] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingMessageAttachment[]>([]);
  const speechWindow = typeof window === 'undefined' ? undefined : window as SpeechRecognitionWindow;
  const SpeechRecognition = speechWindow?.SpeechRecognition ?? speechWindow?.webkitSpeechRecognition;
  const canSend = !disabled
    && !uploading
    && !listening
    && (value.trim().length > 0 || (allowAttachmentOnly && attachments.length > 0));

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`;
  }, [value]);

  useEffect(() => () => {
    recognitionRef.current?.abort();
  }, []);

  const toggleSpeechRecognition = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    speechBaseValueRef.current = value;
    recognition.onstart = () => setListening(true);
    recognition.onresult = (event) => {
      let transcript = '';
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index][0]?.transcript ?? '';
      }
      const baseValue = speechBaseValueRef.current;
      const separator = baseValue && !baseValue.endsWith(' ') ? ' ' : '';
      onChange(`${baseValue}${separator}${transcript}`);
    };
    recognition.onerror = (event) => {
      if (event.error !== 'aborted') onError?.(speechErrorMessage(event.error));
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
      onError?.('语音识别启动失败，请稍后重试');
    }
  };

  const submit = () => {
    if (!canSend) return;
    void onSend();
  };

  return (
    <form
      className={cn('space-y-2', className)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <MessageAttachmentSelection
        value={attachments}
        onChange={onAttachmentsChange}
        disabled={disabled || uploading}
      />
      <MessageAttachmentPendingList value={pendingAttachments} />
      <div className="flex min-h-14 items-end rounded-2xl border border-surface-200 bg-white p-2 shadow-sm transition-colors focus-within:border-primary-400 focus-within:ring-2 focus-within:ring-primary-500/20 dark:border-surface-700 dark:bg-surface-800 dark:focus-within:border-primary-500">
        <MessageAttachmentControls
          value={attachments}
          onChange={onAttachmentsChange}
          onUploadingChange={onUploadingChange}
          onError={onError}
          onFeedback={onFeedback}
          onPendingChange={setPendingAttachments}
          disabled={disabled}
        />
        <textarea
          ref={textareaRef}
          rows={1}
          maxLength={maxLength}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          className="min-h-10 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-2 py-2.5 text-sm leading-5 text-surface-900 outline-none placeholder:text-surface-400 disabled:cursor-not-allowed disabled:opacity-50 dark:text-surface-100 dark:placeholder:text-surface-500"
        />
        <div className="flex shrink-0 items-center gap-0.5">
          {SpeechRecognition && (
            <button
              type="button"
              title={listening ? '停止语音输入' : '语音输入'}
              aria-label={listening ? '停止语音输入' : '语音输入'}
              aria-pressed={listening}
              disabled={disabled}
              onClick={toggleSpeechRecognition}
              className={cn(
                'grid h-10 w-10 shrink-0 place-items-center rounded-lg text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-700 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-surface-700 dark:hover:text-surface-100',
                listening && 'bg-red-50 text-red-600 hover:bg-red-100 hover:text-red-700 dark:bg-red-950/40 dark:text-red-400',
              )}
            >
              <Mic className={cn('h-5 w-5', listening && 'animate-pulse')} />
            </button>
          )}
          <IconTooltip label={sendLabel} className="shrink-0">
            <button
              type="submit"
              aria-label={sendLabel}
              disabled={!canSend}
              className="grid h-10 w-10 place-items-center rounded-xl bg-primary-600 text-white shadow-sm transition-colors hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-primary-300 disabled:opacity-60 dark:disabled:bg-primary-900"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </IconTooltip>
        </div>
      </div>
    </form>
  );
}
