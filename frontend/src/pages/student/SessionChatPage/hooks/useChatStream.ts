import { useCallback, useEffect, useRef } from 'react';
import { useAppDispatch } from '@/store';
import {
  addMessage,
  appendToLastMessage,
  removeMessagesById,
  setCurrentTaskId,
  setSendingState,
  setStreamStatus,
  setStreamingMessageId,
  type StreamStatus,
} from '@/modules/session/store/sessionSlice';
import { sessionService } from '@/modules/session/services/sessionService';
import { uploadService, type UploadResponse } from '@/modules/upload/services/uploadService';
import type { ParsedDocument } from '@/libs/utils/documentParser';
import {
  formatChatMessageForDisplay,
  formatDocumentsForChat,
} from '@/modules/session/documentMessage';
import type { SSEController, SSEError, SSEHandlers } from '@/libs/http/sseClient';
import {
  MAX_CHAT_DOCUMENTS,
  MAX_CHAT_IMAGES,
  MAX_CHAT_MESSAGE_BYTES,
  MAX_CHAT_MESSAGE_KIB,
} from '@/modules/session/limits';
import type {
  DraftFirstRequest,
  DraftSessionIdentity,
  SessionMode,
} from '@/modules/session/types';

export type ChatTarget =
  | { kind: 'existing'; sessionId: string }
  | {
      kind: 'draft';
      sessionId?: string;
      topic?: string;
      mode: SessionMode;
      firstRequest?: DraftFirstRequest;
    };

interface UseChatStreamProps {
  resolveChatTarget: () => ChatTarget | null;
  isStreaming: boolean;
  attachmentsPending: boolean;
  selectedImages: File[];
  sseControllerRef: React.MutableRefObject<SSEController | null>;
  onSendStart?: (sentInputText: string) => void;
  onSessionPrepared?: (identity: DraftSessionIdentity) => void;
  onFirstRequestPrepared?: (sessionId: string, request: DraftFirstRequest) => void;
  onSessionMaterialized?: (sessionId: string) => void;
  onFirstTurnCompleted?: (sessionId: string) => void;
  onChatSettled?: (settlement: ChatSettlement) => void;
  onClearImages: () => void;
  /** 获取已解析的文档列表 */
  getParsedDocuments: () => ParsedDocument[];
  /** 清空文件 */
  onClearFiles: () => void;
}

export type ChatSendOutcome = 'done' | 'error' | 'cancelled' | 'closed';

export interface ChatSettlement {
  sessionId: string | null;
  outcome: ChatSendOutcome;
  retryText: string;
  errorMessage?: string;
  errorCode?: string;
  errorStatus?: number;
  isFirstTurn: boolean;
}

type FinishSend = (
  outcome: ChatSendOutcome,
  nextStreamStatus: StreamStatus,
  appendedMessage?: string,
  errorMessage?: string,
  errorCode?: string,
  errorStatus?: number
) => void;

export const useChatStream = ({
  resolveChatTarget,
  isStreaming,
  attachmentsPending,
  selectedImages,
  sseControllerRef,
  onSendStart,
  onSessionPrepared,
  onFirstRequestPrepared,
  onSessionMaterialized,
  onFirstTurnCompleted,
  onChatSettled,
  onClearImages,
  getParsedDocuments,
  onClearFiles,
}: UseChatStreamProps) => {
  const dispatch = useAppDispatch();

  // 流式更新：rAF 节流相关 refs
  const contentBufferRef = useRef<string>('');
  const rafIdRef = useRef<number | null>(null);
  const sendPendingRef = useRef(false);
  const sendAbortControllerRef = useRef<AbortController | null>(null);
  const activeFinishRef = useRef<FinishSend | null>(null);
  const activeRef = useRef(true);
  const uploadedImageCacheRef = useRef<WeakMap<File, UploadResponse>>(new WeakMap());

  // 取消待执行的 rAF 刷新
  const cancelPendingFlush = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  // 刷新缓冲区中的剩余内容到 Redux
  const flushBuffer = useCallback(() => {
    cancelPendingFlush();
    if (contentBufferRef.current) {
      dispatch(appendToLastMessage(contentBufferRef.current));
      contentBufferRef.current = '';
    }
  }, [dispatch, cancelPendingFlush]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      activeFinishRef.current = null;
      sendAbortControllerRef.current?.abort();
      sendAbortControllerRef.current = null;
      sendPendingRef.current = false;
      sseControllerRef.current?.close();
      sseControllerRef.current = null;
      cancelPendingFlush();
      contentBufferRef.current = '';
      dispatch(setSendingState('idle'));
      dispatch(setStreamStatus('idle'));
      dispatch(setStreamingMessageId(null));
      dispatch(setCurrentTaskId(null));
    };
  }, [cancelPendingFlush, dispatch, sseControllerRef]);

  // 发送消息
  const handleSendMessage = useCallback(
    async (messageContent: string): Promise<boolean> => {
      const parsedDocs = [...getParsedDocuments()];
      const imageSnapshot = [...selectedImages];
      if (
        isStreaming ||
        attachmentsPending ||
        sendPendingRef.current
      ) {
        return false;
      }

      const target = resolveChatTarget();
      if (!target) return false;
      const frozenFirstRequest = target.kind === 'draft' ? target.firstRequest : undefined;
      const sentInputText = frozenFirstRequest?.inputText ?? messageContent;
      if (
        !frozenFirstRequest &&
        !messageContent.trim() &&
        imageSnapshot.length === 0 &&
        parsedDocs.length === 0
      ) {
        return false;
      }

      sendPendingRef.current = true;
      const abortController = new AbortController();
      sendAbortControllerRef.current = abortController;
      dispatch(setSendingState('loading'));

      const releaseSend = () => {
        if (sendAbortControllerRef.current !== abortController) return;
        sendAbortControllerRef.current = null;
        sendPendingRef.current = false;
        dispatch(setSendingState('idle'));
      };
      const isAborted = () => abortController.signal.aborted || !activeRef.current;
      let recoverySessionId = target.kind === 'existing'
        ? target.sessionId
        : target.sessionId ?? crypto.randomUUID();
      let sessionMaterialized = target.kind === 'existing';
      let optimisticMessageIds: string[] = [];
      let settled = false;

      if (target.kind === 'draft') {
        onSessionPrepared?.({
          sessionId: recoverySessionId,
          topic: target.topic,
          mode: target.mode,
        });
      }

      const finishSend: FinishSend = (
        outcome: ChatSendOutcome,
        nextStreamStatus: StreamStatus,
        appendedMessage?: string,
        errorMessage?: string,
        errorCode?: string,
        errorStatus?: number
      ) => {
        if (settled || activeFinishRef.current !== finishSend) return;
        settled = true;
        activeFinishRef.current = null;
        if (outcome !== 'done') abortController.abort();
        if (activeRef.current) {
          flushBuffer();
          if (appendedMessage && optimisticMessageIds.length > 0) {
            dispatch(appendToLastMessage(appendedMessage));
          }
          if (!sessionMaterialized && outcome !== 'done' && optimisticMessageIds.length > 0) {
            dispatch(removeMessagesById(optimisticMessageIds));
          }
        } else {
          cancelPendingFlush();
          contentBufferRef.current = '';
        }
        releaseSend();
        dispatch(setStreamStatus(nextStreamStatus));
        dispatch(setStreamingMessageId(null));
        dispatch(setCurrentTaskId(null));
        if (activeRef.current && outcome === 'done') {
          if (target.kind === 'draft') onFirstTurnCompleted?.(recoverySessionId);
          uploadedImageCacheRef.current = new WeakMap();
          onClearImages();
          onClearFiles();
        }
        const streamController = sseControllerRef.current;
        sseControllerRef.current = null;
        if (outcome !== 'closed') streamController?.close();
        if (activeRef.current) {
          onChatSettled?.({
            sessionId: recoverySessionId,
            outcome,
            retryText: sentInputText,
            errorMessage,
            errorCode,
            errorStatus,
            isFirstTurn: target.kind === 'draft',
          });
        }
      };
      activeFinishRef.current = finishSend;

      try {
        let fullMessage = frozenFirstRequest?.message ?? '';
        let uploadedImageUrls = [...(frozenFirstRequest?.attachments ?? [])];
        if (!frozenFirstRequest) {
          if (imageSnapshot.length > MAX_CHAT_IMAGES) {
            throw new Error(`每次最多上传 ${MAX_CHAT_IMAGES} 张图片`);
          }
          if (parsedDocs.length > MAX_CHAT_DOCUMENTS) {
            throw new Error(`每次最多上传 ${MAX_CHAT_DOCUMENTS} 个文档`);
          }

          // 在上传和创建草稿会话前完成文档拼接及大小校验。
          const promptMessage = messageContent.trim()
            ? messageContent
            : parsedDocs.length > 0
              ? '请分析我上传的文档。'
              : '请分析我上传的图片。';
          fullMessage = formatDocumentsForChat(parsedDocs, promptMessage);
          if (new TextEncoder().encode(fullMessage).byteLength > MAX_CHAT_MESSAGE_BYTES) {
            throw new Error(`消息和文档内容合计不能超过 ${MAX_CHAT_MESSAGE_KIB} KiB`);
          }

          // 上传成功后再冻结首轮请求，避免上传失败留下不可重放的半成品。
          const uploadPromises = imageSnapshot.map(async (file) => {
            const cached = uploadedImageCacheRef.current.get(file);
            if (cached) return cached;

            const uploaded = await uploadService.uploadImage(
              file,
              undefined,
              abortController.signal
            );
            uploadedImageCacheRef.current.set(file, uploaded);
            return uploaded;
          });
          if (uploadPromises.length > 0) {
            const results = await Promise.all(uploadPromises);
            uploadedImageUrls = results.map((result) => result.url);
          }
          if (isAborted()) {
            return false;
          }
          if (target.kind === 'draft') {
            onFirstRequestPrepared?.(recoverySessionId, {
              inputText: messageContent,
              message: fullMessage,
              attachments: uploadedImageUrls,
            });
          }
        }

        const optimisticSessionId = recoverySessionId;
        const displayMessage = formatChatMessageForDisplay(fullMessage);

        const userMessageId = crypto.randomUUID();
        const aiMessageId = crypto.randomUUID();
        optimisticMessageIds = [userMessageId, aiMessageId];

        // 输入和附件准备完成后，才使上一轮异步对账失效。
        onSendStart?.(sentInputText);

        // 1. 添加用户消息到 UI
        dispatch(
          addMessage({
            id: userMessageId,
            sessionId: optimisticSessionId,
            role: 'user',
            content: displayMessage,
            timestamp: new Date().toISOString(),
            attachments: uploadedImageUrls,
          })
        );

        // 2. 创建 AI 消息占位
        dispatch(
          addMessage({
            id: aiMessageId,
            sessionId: optimisticSessionId,
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            metadata: { agent: null },
          })
        );

        // 3. 设置流式状态
        dispatch(setStreamStatus('streaming'));
        dispatch(setStreamingMessageId(aiMessageId));

        const streamHandlers: SSEHandlers = {
          onTaskInfo: (taskId: string) => {
            if (!settled && activeRef.current) dispatch(setCurrentTaskId(taskId));
          },
          onChunk: (content: string) => {
            if (settled || !activeRef.current) return;
            // rAF 节流：缓冲内容，每帧最多 dispatch 一次
            contentBufferRef.current += content;
            if (rafIdRef.current === null) {
              rafIdRef.current = requestAnimationFrame(() => {
                if (contentBufferRef.current) {
                  dispatch(appendToLastMessage(contentBufferRef.current));
                  contentBufferRef.current = '';
                }
                rafIdRef.current = null;
              });
            }
          },
          onDone: () => finishSend('done', 'idle'),
          onError: (error: SSEError) => {
            if (settled) return;
            console.error('SSE error:', error);
            finishSend(
              'error',
              'error',
              `\n\n[错误: ${error.message}]`,
              error.message,
              error.code,
              error.status
            );
          },
          onCancelled: () => finishSend(
            'cancelled',
            'cancelled',
            '\n\n[响应已取消]',
            '响应已取消'
          ),
          onClose: () => finishSend('closed', 'idle', undefined, '连接已关闭'),
        };

        // 草稿通过一个原子接口创建；已有会话继续使用原聊天接口。
        if (target.kind === 'draft') {
          sseControllerRef.current = sessionService.startChatStream(
            {
              sessionId: recoverySessionId,
              topic: target.topic,
              mode: target.mode,
              message: fullMessage,
              attachments: uploadedImageUrls.length > 0 ? uploadedImageUrls : undefined,
            },
            {
              ...streamHandlers,
              onSessionInfo: (materializedSessionId: string) => {
                if (settled || !activeRef.current) return;
                recoverySessionId = materializedSessionId;
                sessionMaterialized = true;
                onSessionMaterialized?.(materializedSessionId);
              },
            }
          );
        } else {
          sseControllerRef.current = sessionService.chatStream(
            target.sessionId,
            fullMessage,
            streamHandlers,
            uploadedImageUrls.length > 0 ? uploadedImageUrls : undefined
          );
        }
        return true;
      } catch (error) {
        if (settled || isAborted()) return false;
        console.error('消息发送准备失败:', error);
        finishSend(
          'error',
          'error',
          undefined,
          error instanceof Error ? error.message : '消息发送失败'
        );
        return false;
      }
    },
    [
      resolveChatTarget,
      isStreaming,
      attachmentsPending,
      selectedImages,
      sseControllerRef,
      onSendStart,
      onSessionPrepared,
      onFirstRequestPrepared,
      onSessionMaterialized,
      onFirstTurnCompleted,
      onChatSettled,
      onClearImages,
      onClearFiles,
      getParsedDocuments,
      dispatch,
      flushBuffer,
      cancelPendingFlush,
    ]
  );

  const cancelCurrentSend = useCallback((): boolean => {
    const finishSend = activeFinishRef.current;
    if (!finishSend) return false;

    // 先完成幂等本地结算，再关闭连接；随后到达的 onClose 会被忽略。
    finishSend(
      'cancelled',
      'cancelled',
      '\n\n[响应已取消]',
      '响应已取消'
    );
    return true;
  }, []);

  return {
    handleSendMessage,
    cancelCurrentSend,
  };
};
