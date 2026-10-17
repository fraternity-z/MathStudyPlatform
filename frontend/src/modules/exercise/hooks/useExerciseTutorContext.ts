import { useCallback, useEffect, useMemo, useState } from 'react';
import { toAppError, type AppError } from '@/libs/http/appError';
import { useNavigate } from 'react-router-dom';
import { sessionService } from '@/modules/session/api';
import type { ExerciseTutorLaunchState } from '../tutorContext';

interface LoadState {
  request: { exerciseId: string | null; attempt: number };
  context: ExerciseTutorLaunchState | null;
  error: AppError | null;
}

// Legacy exercise links enter the same server-bound tutor as the exercise button.
export function useExerciseTutorContext(exerciseId: string | null) {
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState | null>(null);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const request = useMemo(() => ({ exerciseId, attempt }), [exerciseId, attempt]);

  useEffect(() => {
    if (!request.exerciseId) return;
    const controller = new AbortController();
    void sessionService.prepareExerciseTutor(request.exerciseId, controller.signal).then((tutor) => {
      if (!controller.signal.aborted) navigate(`/session/${tutor.session_id}`, { replace: true });
    }).catch((cause) => {
      if (!controller.signal.aborted) setState({ request, context: null, error: toAppError(cause, '题目加载失败，请重试') });
    });
    return () => controller.abort();
  }, [request, navigate]);

  const current = exerciseId && state?.request === request ? state : null;
  return {
    context: current?.context ?? null,
    error: current?.error ?? null,
    loading: Boolean(exerciseId) && current === null,
    retry,
  };
}
