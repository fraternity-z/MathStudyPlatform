import { useCallback, useEffect, useMemo, useState } from 'react';
import { sessionService, type ExerciseTutorResponse } from '@/modules/session/services/sessionService';
import { toAppError, type AppError } from '@/libs/http/appError';

export function useBoundExerciseTutor(sessionId: string | null) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const request = useMemo(() => ({ sessionId, revision }), [sessionId, revision]);
  const [state, setState] = useState<{
    request: typeof request;
    tutor: ExerciseTutorResponse | null;
    error: AppError | null;
  } | null>(null);

  useEffect(() => {
    if (!request.sessionId) return;
    const controller = new AbortController();
    void sessionService.getExerciseTutor(request.sessionId, controller.signal).then((tutor) => {
      if (!controller.signal.aborted) setState({ request, tutor, error: null });
    }).catch((cause) => {
      if (!controller.signal.aborted) setState({ request, tutor: null, error: toAppError(cause, '题目辅导加载失败') });
    });
    return () => controller.abort();
  }, [request]);

  const current = sessionId && state?.request === request ? state : null;
  return { tutor: current?.tutor ?? null, error: current?.error ?? null, loading: Boolean(sessionId) && current === null, refresh };
}
