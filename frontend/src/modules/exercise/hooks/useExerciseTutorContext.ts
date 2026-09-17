import { useCallback, useEffect, useMemo, useState } from 'react';
import { toAppError, type AppError } from '@/libs/http/appError';
import { exerciseService } from '../services/exerciseService';
import { buildExerciseTutorLaunch, type ExerciseTutorLaunchState } from '../tutorContext';

interface LoadState {
  request: { exerciseId: string | null; attempt: number };
  context: ExerciseTutorLaunchState | null;
  error: AppError | null;
}

// Fetches exercise context only; the caller owns navigation, input and mode selection.
export function useExerciseTutorContext(exerciseId: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState | null>(null);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const request = useMemo(() => ({ exerciseId, attempt }), [exerciseId, attempt]);

  useEffect(() => {
    if (!request.exerciseId) return;
    const controller = new AbortController();
    void exerciseService.getQuestion(request.exerciseId, controller.signal).then((question) => {
      if (!controller.signal.aborted) setState({ request, context: buildExerciseTutorLaunch(question), error: null });
    }).catch((cause) => {
      if (!controller.signal.aborted) setState({ request, context: null, error: toAppError(cause, '题目加载失败，请重试') });
    });
    return () => controller.abort();
  }, [request]);

  const current = exerciseId && state?.request === request ? state : null;
  return {
    context: current?.context ?? null,
    error: current?.error ?? null,
    loading: Boolean(exerciseId) && current === null,
    retry,
  };
}
