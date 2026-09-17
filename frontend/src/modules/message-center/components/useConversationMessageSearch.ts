import { useCallback, useEffect, useState } from 'react';
import { isRequestCancelled, toAppError, type AppError } from '@/libs/http/appError';
import { conversationService, type MessageSearchResponse } from '@/modules/message-center/services/conversationService';

export function useConversationMessageSearch(conversationID: string, search: string, enabled: boolean) {
  const term = search.trim();
  const [selection, setSelection] = useState({ conversationID, term, page: 1 });
  const page = selection.conversationID === conversationID && selection.term === term ? selection.page : 1;
  const [result, setResult] = useState<{ key: string; data: MessageSearchResponse | null; error: AppError | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const key = `${conversationID}\u0000${term}\u0000${page}\u0000${revision}`;
  const active = enabled && Boolean(conversationID && term);

  if (selection.conversationID !== conversationID || selection.term !== term) {
    setSelection({ conversationID, term, page: 1 });
  }

  useEffect(() => {
    if (!active) return;
    let current = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void conversationService.searchMessages(conversationID, term, page, controller.signal)
        .then((data) => {
          if (!current) return;
          const lastPage = Math.max(1, Math.ceil(data.total / data.page_size));
          if (page > lastPage) {
            setSelection({ conversationID, term, page: lastPage });
            return;
          }
          setResult({ key, data, error: null });
        })
        .catch((error: unknown) => {
          if (current && !isRequestCancelled(error)) setResult({ key, data: null, error: toAppError(error, '搜索聊天记录失败') });
        });
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, conversationID, key, page, term]);

  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  return {
    messages: active && result?.key === key ? result.data?.messages ?? [] : [],
    total: active && result?.key === key ? result.data?.total ?? 0 : 0,
    error: active && result?.key === key ? result.error : null,
    loading: active && result?.key !== key,
    page,
    pageSize: 50,
    setPage: (nextPage: number) => setSelection({ conversationID, term, page: nextPage }),
    refresh,
  };
}
