import { useState, useCallback, useEffect, useRef } from 'react';
import {
  exerciseService,
  type ExerciseSolution,
  type GenerateQuestionType,
  type Question,
  type SubmitResult,
} from '@/modules/exercise/services/exerciseService';
import { logger } from '@/libs/utils/logger';
import { toAppError, type AppError } from '@/libs/http/apiClient';
import { uploadService } from '@/modules/upload/services/uploadService';
import { validateAnswerImageFile } from '../utils/answerImageValidation';

const exerciseLogger = logger.createContextLogger('ExerciseViewModel');

/**
 * 练习题错误类型
 */
export type ExerciseErrorType =
  | 'not_enrolled' // 403: 未加入班级
  | 'no_questions' // 无可用题目
  | 'invalid_generation_request' // AI 出题参数无效
  | 'knowledge_point_not_found' // 404: 所选知识点不存在
  | 'generation_rate_limited' // 429: AI 出题请求过于频繁
  | 'generation_unavailable' // 503: AI 出题服务不可用
  | 'invalid_answer' // 答案或图片不符合要求
  | 'answer_unreadable' // OCR 未识别出有效答案
  | 'answer_unsupported' // 当前答案或题型无法自动判定
  | 'answer_rate_limited' // OCR 请求被限流
  | 'answer_service_unavailable' // OCR 或数学判定服务不可用
  | 'exercise_changed' // 作答期间题目内容发生变化
  | 'daily_assignment_stale' // 每日一题任务已完成或失效
  | 'review_not_due' // 复习任务尚未到期
  | 'review_task_stale' // 复习任务版本已更新
  | 'mistake_record_archived' // 精确重做绑定的原错题已归档
  | 'submission_conflict' // 提交标识已绑定到另一份载荷
  | 'network_error' // 网络错误
  | 'unknown'; // 其他错误

export type SubmitPhase = 'idle' | 'uploading' | 'recognizing';

export type ExerciseErrorSource = 'load' | 'generation' | 'submission';

export interface ExerciseAnswerSubmission {
  answerText?: string;
  answerImage?: File | null;
}

export interface ExerciseViewModelOptions {
  dailyAssignmentId?: string;
  reviewTaskId?: string;
  reviewTaskRevision?: number;
  originalAttemptId?: string;
}

type SubmissionStage = 'upload' | 'grading';

interface PendingBoundSubmission {
  signature: string;
  submissionId: string;
  timeSpentSeconds?: number;
  answerImage?: File;
  answerImageUrl?: string;
}

const withMessage = (error: AppError, message: string): AppError => ({
  ...error,
  message,
});

const makeUiError = (message: string): AppError => ({
  kind: 'validation',
  message,
  retryable: false,
  source: 'ui',
});

const getGenerationError = (err: unknown): { error: AppError; type: ExerciseErrorType } => {
  const appError = toAppError(err, '生成题目失败，请稍后重试');
  const code = appError.code?.trim().toUpperCase() ?? '';
  switch (code) {
    case 'AI_GENERATION_TIMEOUT':
      return {
        error: withMessage(appError, 'AI 出题处理超时，请稍后重试'),
        type: 'generation_unavailable',
      };
    case 'MATH_SOLVER_TIMEOUT':
      return {
        error: withMessage(appError, 'AI 题目验证超时，请稍后重试'),
        type: 'generation_unavailable',
      };
    case 'MATH_SOLVER_INVALID_RESPONSE':
      return {
        error: withMessage(appError, 'AI 题目验证服务返回异常，请稍后重试'),
        type: 'generation_unavailable',
      };
    case 'MATH_SOLVER_UNAVAILABLE':
      return {
        error: withMessage(appError, 'AI 题目验证服务暂不可用，请稍后重试'),
        type: 'generation_unavailable',
      };
    case 'AI_GENERATION_UNAVAILABLE':
      return {
        error: withMessage(appError, 'AI 出题服务暂不可用，请稍后重试'),
        type: 'generation_unavailable',
      };
  }

  const status = appError.status;
  if (status === 404) {
    return {
      error: withMessage(appError, '所选知识点不存在，请重新选择'),
      type: 'knowledge_point_not_found',
    };
  }
  if (status === 429) {
    return {
      error: withMessage(appError, 'AI 出题请求过于频繁，请稍后再试'),
      type: 'generation_rate_limited',
    };
  }
  if (status === 503) {
    return {
      error: withMessage(appError, 'AI 出题服务暂不可用，请稍后重试'),
      type: 'generation_unavailable',
    };
  }
  if (status === 504) {
    return {
      error: withMessage(appError, 'AI 出题处理超时，请稍后重试'),
      type: 'generation_unavailable',
    };
  }
  if (status === 502) {
    return {
      error: withMessage(appError, 'AI 出题服务连接异常，请稍后重试'),
      type: 'generation_unavailable',
    };
  }
  if (appError.kind === 'network') {
    return {
      error: withMessage(appError, '无法连接到服务器，请检查网络后重试'),
      type: 'network_error',
    };
  }

  return {
    error: appError,
    type: 'unknown',
  };
};

const getSubmissionError = (
  err: unknown,
  stage: SubmissionStage
): { error: AppError; type: ExerciseErrorType } => {
  const appError = toAppError(err, '提交答案失败，请稍后重试');
  const code = appError.code?.trim().toUpperCase() ?? '';
  switch (code) {
    case 'OCR_UNREADABLE':
      return {
        error: withMessage(appError, '未能从图片中识别出有效答案，请重新拍摄或改用文字答案'),
        type: 'answer_unreadable',
      };
    case 'OCR_UNAVAILABLE':
      return {
        error: withMessage(appError, '图片识别服务暂不可用，请稍后重试或改用文字答案'),
        type: 'answer_service_unavailable',
      };
    case 'OCR_TIMEOUT':
      return {
        error: withMessage(appError, '图片识别超时，请稍后重试'),
        type: 'answer_service_unavailable',
      };
    case 'OCR_RATE_LIMITED':
      return {
        error: withMessage(appError, '图片识别请求过于频繁，请稍后重试'),
        type: 'answer_rate_limited',
      };
    case 'RATE_LIMITED':
      return {
        error: withMessage(appError,
          stage === 'upload'
            ? '图片上传请求过于频繁，请稍后重试'
            : '答案提交请求过于频繁，请稍后重试'),
        type: 'answer_rate_limited',
      };
    case 'ANSWER_PARSE_FAILED':
      return {
        error: withMessage(appError, '答案格式无法安全解析，请检查输入或改用更清晰的图片后重试'),
        type: 'invalid_answer',
      };
    case 'MATH_UNSUPPORTED':
      return {
        error: withMessage(appError, '当前题型暂不支持自动判定，请补充解题步骤或联系教师'),
        type: 'answer_unsupported',
      };
    case 'MATH_SOLVER_INVALID_RESPONSE':
      return {
        error: withMessage(appError, '数学判题服务返回异常，请稍后重试'),
        type: 'answer_service_unavailable',
      };
    case 'MATH_SOLVER_UNAVAILABLE':
      return {
        error: withMessage(appError, '数学判题服务暂不可用，请稍后重试'),
        type: 'answer_service_unavailable',
      };
    case 'MATH_SOLVER_TIMEOUT':
      return {
        error: withMessage(appError, '数学判题服务处理超时，请稍后重试'),
        type: 'answer_service_unavailable',
      };
    case 'EXERCISE_CHANGED':
      return {
        error: withMessage(appError, '题目已更新，请重新加载后提交'),
        type: 'exercise_changed',
      };
    case 'DAILY_ASSIGNMENT_INVALID':
    case 'DAILY_ASSIGNMENT_COMPLETED':
      return {
        error: withMessage(appError, '每日一题状态已更新，正在同步最新任务'),
        type: 'daily_assignment_stale',
      };
    case 'REVIEW_NOT_DUE':
      return {
        error: withMessage(appError, '复习计划状态已变化，请返回错题本后重新进入'),
        type: 'review_not_due',
      };
    case 'REVIEW_TASK_STALE':
      return {
        error: withMessage(appError, '复习任务已更新，请重新加载后继续'),
        type: 'review_task_stale',
      };
    case 'MISTAKE_RECORD_ARCHIVED':
      return {
        error: withMessage(appError, '这条错题记录已归档，请返回错题本'),
        type: 'mistake_record_archived',
      };
    case 'SUBMISSION_ID_CONFLICT':
      return {
        error: withMessage(appError, '提交状态已变化，请重新提交'),
        type: 'submission_conflict',
      };
    default:
      if (code.startsWith('MATH_')) {
        return {
          error: withMessage(appError, '暂时无法可靠判定这份答案，请稍后重试'),
          type: 'answer_service_unavailable',
        };
      }
  }

  if (appError.kind === 'network') {
    return {
      error: withMessage(appError, '无法连接到服务器，请检查网络后重试'),
      type: 'network_error',
    };
  }
  return {
    error: appError,
    type: 'unknown',
  };
};

/**
 * 练习题 ViewModel Hook
 *
 * 管理题目加载、文本或图片答案提交和反馈展示
 */
export function useExerciseViewModel(options: ExerciseViewModelOptions = {}) {
  const dailyAssignmentId = options.dailyAssignmentId?.trim() || undefined;
  const reviewTaskId = options.reviewTaskId?.trim() || undefined;
  const reviewTaskRevision = options.reviewTaskRevision;
  const originalAttemptId = options.originalAttemptId?.trim() || undefined;
  const [currentQuestion, setCurrentQuestion] = useState<Question | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<SubmitPhase>('idle');
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [solution, setSolution] = useState<ExerciseSolution | null>(null);
  const [isLoadingSolution, setIsLoadingSolution] = useState(false);
  const [solutionError, setSolutionError] = useState<AppError | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [errorType, setErrorType] = useState<ExerciseErrorType | null>(null);
  const [errorSource, setErrorSource] = useState<ExerciseErrorSource | null>(null);

  // 答题计时
  const startTimeRef = useRef<number>(Date.now());
  const generationInFlightRef = useRef(false);
  const submissionInFlightRef = useRef(false);
  const solutionInFlightRef = useRef(false);
  const questionVersionRef = useRef(0);
  const submissionRequestRef = useRef(0);
  const solutionRequestRef = useRef(0);
  const pendingBoundSubmissionRef = useRef<PendingBoundSubmission | null>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const generationControllerRef = useRef<AbortController | null>(null);
  const submissionControllerRef = useRef<AbortController | null>(null);
  const solutionControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    loadControllerRef.current?.abort();
    generationControllerRef.current?.abort();
    submissionControllerRef.current?.abort();
    solutionControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    pendingBoundSubmissionRef.current = null;
  }, [dailyAssignmentId, reviewTaskId, reviewTaskRevision, originalAttemptId]);

  const loadQuestion = useCallback((question: Question) => {
    loadControllerRef.current?.abort();
    generationControllerRef.current?.abort();
    submissionControllerRef.current?.abort();
    solutionControllerRef.current?.abort();
    questionVersionRef.current += 1;
    submissionRequestRef.current += 1;
    solutionRequestRef.current += 1;
    submissionInFlightRef.current = false;
    solutionInFlightRef.current = false;
    pendingBoundSubmissionRef.current = null;
    setCurrentQuestion(question);
    setSubmitPhase('idle');
    setSubmitResult(null);
    setSolution(null);
    setIsLoadingSolution(false);
    setSolutionError(null);
    setError(null);
    setErrorType(null);
    setErrorSource(null);
    startTimeRef.current = Date.now();
  }, []);

  const clearQuestion = useCallback(() => {
    loadControllerRef.current?.abort();
    generationControllerRef.current?.abort();
    submissionControllerRef.current?.abort();
    solutionControllerRef.current?.abort();
    questionVersionRef.current += 1;
    submissionRequestRef.current += 1;
    solutionRequestRef.current += 1;
    submissionInFlightRef.current = false;
    solutionInFlightRef.current = false;
    pendingBoundSubmissionRef.current = null;
    setCurrentQuestion(null);
    setSubmitPhase('idle');
    setSubmitResult(null);
    setSolution(null);
    setIsLoadingSolution(false);
    setSolutionError(null);
    setError(null);
    setErrorType(null);
    setErrorSource(null);
  }, []);

  const loadNextQuestion = useCallback(async (conceptId?: string, difficulty?: number) => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setIsLoading(true);
    setError(null);
    setErrorType(null);
    setErrorSource(null);
    try {
      const question = await exerciseService.fetchNextQuestion(conceptId, difficulty, controller.signal);
      if (!question) {
        questionVersionRef.current += 1;
        pendingBoundSubmissionRef.current = null;
        setCurrentQuestion(null);
        setSubmitResult(null);
        setSolution(null);
        setSolutionError(null);
        setError(null);
        setErrorType('no_questions');
        setErrorSource('load');
        exerciseLogger.info('No questions available');
        return;
      }
      questionVersionRef.current += 1;
      pendingBoundSubmissionRef.current = null;
      setCurrentQuestion(question);
      setSubmitResult(null);
      setSolution(null);
      setSolutionError(null);
      startTimeRef.current = Date.now();
      exerciseLogger.debug('Question loaded', { questionId: question.id });
    } catch (err) {
      const requestError = toAppError(err, '加载题目失败，请稍后重试');
      if (controller.signal.aborted || requestError.kind === 'cancelled') return;
      setError(requestError);
      setErrorSource('load');
      if (requestError.status === 403 || requestError.kind === 'forbidden') {
        setErrorType('not_enrolled');
      } else if (requestError.status === 404 || requestError.kind === 'not_found') {
        setErrorType('no_questions');
      } else if (requestError.kind === 'network') {
        setErrorType('network_error');
      } else {
        setErrorType('unknown');
      }
      exerciseLogger.error('Failed to load question', { error: requestError });
    } finally {
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
        setIsLoading(false);
      }
    }
  }, []);

  const generateQuestion = useCallback(async (
    conceptId: string,
    difficulty: number,
    questionType: GenerateQuestionType = 'multiple_choice',
  ) => {
    if (generationInFlightRef.current || submissionInFlightRef.current) return;

    const normalizedConceptId = conceptId.trim();
    if (!normalizedConceptId) {
      setError(makeUiError('请选择知识点'));
      setErrorType('invalid_generation_request');
      setErrorSource('generation');
      return;
    }
    if (!Number.isFinite(difficulty) || difficulty < 0 || difficulty > 1) {
      setError(makeUiError('请选择有效难度'));
      setErrorType('invalid_generation_request');
      setErrorSource('generation');
      return;
    }

    generationInFlightRef.current = true;
    generationControllerRef.current?.abort();
    const controller = new AbortController();
    generationControllerRef.current = controller;
    setIsGenerating(true);
    setError(null);
    setErrorType(null);
    setErrorSource(null);

    try {
      const question = await exerciseService.generateQuestion({
        conceptId: normalizedConceptId,
        difficulty,
        questionType,
      }, controller.signal);
      questionVersionRef.current += 1;
      pendingBoundSubmissionRef.current = null;
      setCurrentQuestion(question);
      setSubmitResult(null);
      setSolution(null);
      setSolutionError(null);
      startTimeRef.current = Date.now();
      exerciseLogger.info('AI question generated', {
        questionId: question.id,
        conceptId: normalizedConceptId,
        difficulty,
        questionType,
      });
    } catch (err) {
      const generationError = getGenerationError(err);
      if (controller.signal.aborted || generationError.error.kind === 'cancelled') return;
      setError(generationError.error);
      setErrorType(generationError.type);
      setErrorSource('generation');
      exerciseLogger.error('Failed to generate question', { error: err });
    } finally {
      generationInFlightRef.current = false;
      if (generationControllerRef.current === controller) {
        generationControllerRef.current = null;
        setIsGenerating(false);
      }
    }
  }, []);

  const submitAnswer = useCallback(
    async ({ answerText, answerImage }: ExerciseAnswerSubmission) => {
      if (!currentQuestion || submissionInFlightRef.current || generationInFlightRef.current) return;

      const normalizedAnswer = answerText?.trim() ?? '';
      if (!normalizedAnswer && !answerImage) {
        setError(makeUiError('请输入答案或上传答案图片'));
        setErrorType('invalid_answer');
        setErrorSource('submission');
        return;
      }

      const submittedQuestion = currentQuestion;
      const submittedQuestionVersion = questionVersionRef.current;
      const submissionRequest = submissionRequestRef.current + 1;
      submissionRequestRef.current = submissionRequest;
      const submissionBinding = [
        dailyAssignmentId ?? '',
        reviewTaskId ?? '',
        reviewTaskRevision?.toString() ?? '',
        originalAttemptId ?? '',
      ].join('\u0000');
      const submissionSignature = normalizedAnswer
        ? `${submissionBinding}\u0000${submittedQuestion.id}\u0000text\u0000${normalizedAnswer}`
        : `${submissionBinding}\u0000${submittedQuestion.id}\u0000image`;
      const currentPending = pendingBoundSubmissionRef.current;
      const matchesPending = currentPending?.signature === submissionSignature
        && (normalizedAnswer !== '' || currentPending.answerImage === answerImage)
        && Boolean(currentPending.submissionId);
      let pendingBoundSubmission: PendingBoundSubmission = matchesPending
        ? currentPending
        : {
            signature: submissionSignature,
            submissionId: crypto.randomUUID(),
            ...(!normalizedAnswer && answerImage ? { answerImage } : {}),
          };
      pendingBoundSubmissionRef.current = pendingBoundSubmission;
      let submissionStage: SubmissionStage = normalizedAnswer ? 'grading' : 'upload';
      submissionInFlightRef.current = true;
      submissionControllerRef.current?.abort();
      const controller = new AbortController();
      submissionControllerRef.current = controller;
      setError(null);
      setErrorType(null);
      setErrorSource(null);
      setSubmitResult(null);
      setSolution(null);
      setSolutionError(null);
      try {
        let answerImageUrl = pendingBoundSubmission.answerImageUrl;
        if (!normalizedAnswer && answerImage) {
          const validation = validateAnswerImageFile(answerImage);
          if (!validation.valid) {
            setError(makeUiError(validation.error ?? '答案图片不符合上传要求'));
            setErrorType('invalid_answer');
            setErrorSource('submission');
            return;
          }

          if (!answerImageUrl) {
            setSubmitPhase('uploading');
            const uploaded = await uploadService.uploadImage(answerImage, undefined, controller.signal);
            answerImageUrl = uploaded.url.trim();
            if (!answerImageUrl) {
              throw new Error('图片上传失败，请稍后重试');
            }
            pendingBoundSubmission = { ...pendingBoundSubmission, answerImageUrl };
            pendingBoundSubmissionRef.current = pendingBoundSubmission;
          }
        }

        submissionStage = 'grading';
        setSubmitPhase('recognizing');
        const timeSpentSeconds = pendingBoundSubmission.timeSpentSeconds
          ?? Math.round((Date.now() - startTimeRef.current) / 1000);
        if (pendingBoundSubmission.timeSpentSeconds === undefined) {
          pendingBoundSubmission = { ...pendingBoundSubmission, timeSpentSeconds };
          pendingBoundSubmissionRef.current = pendingBoundSubmission;
        }
        const result = await exerciseService.submitAnswer({
          exerciseId: submittedQuestion.id,
          ...(dailyAssignmentId ? { dailyAssignmentId } : {}),
          ...(reviewTaskId ? { reviewTaskId } : {}),
          ...(reviewTaskRevision !== undefined ? { reviewTaskRevision } : {}),
          ...(originalAttemptId ? { originalAttemptId } : {}),
          submissionId: pendingBoundSubmission.submissionId,
          ...(normalizedAnswer ? { answerText: normalizedAnswer } : {}),
          ...(answerImageUrl ? { answerImageUrl } : {}),
          timeSpentSeconds,
        }, controller.signal);
        if (questionVersionRef.current !== submittedQuestionVersion) {
          exerciseLogger.info('Discarded stale answer result', {
            questionId: submittedQuestion.id,
          });
          return;
        }
        setSubmitResult(result);
        pendingBoundSubmissionRef.current = null;
        exerciseLogger.info('Answer submitted', {
          questionId: submittedQuestion.id,
          isCorrect: result.isCorrect,
          recorded: result.recorded,
          gradingStatus: result.gradingStatus,
        });
      } catch (err) {
        const requestError = toAppError(err, '提交答案失败，请稍后重试');
        if (controller.signal.aborted || requestError.kind === 'cancelled') return;
        if (questionVersionRef.current !== submittedQuestionVersion) {
          exerciseLogger.info('Discarded stale answer error', {
            questionId: submittedQuestion.id,
          });
          return;
        }
        const submissionError = getSubmissionError(err, submissionStage);
        if (
          submissionError.type === 'review_task_stale'
          || submissionError.type === 'review_not_due'
          || submissionError.type === 'mistake_record_archived'
          || submissionError.type === 'exercise_changed'
          || submissionError.type === 'submission_conflict'
        ) {
          pendingBoundSubmissionRef.current = null;
        }
        setError(submissionError.error);
        setErrorType(submissionError.type);
        setErrorSource('submission');
        exerciseLogger.error('Failed to submit answer', {
          questionId: submittedQuestion.id,
          error: err,
        });
      } finally {
        if (submissionRequestRef.current === submissionRequest) {
          submissionInFlightRef.current = false;
          setSubmitPhase('idle');
        }
        if (submissionControllerRef.current === controller) {
          submissionControllerRef.current = null;
        }
      }
    },
    [currentQuestion, dailyAssignmentId, reviewTaskId, reviewTaskRevision, originalAttemptId]
  );

  const loadSolution = useCallback(async () => {
    if (!currentQuestion || solutionInFlightRef.current) return;

    const requestedQuestion = currentQuestion;
    const requestedQuestionVersion = questionVersionRef.current;
    const solutionRequest = solutionRequestRef.current + 1;
    solutionRequestRef.current = solutionRequest;
    solutionInFlightRef.current = true;
    solutionControllerRef.current?.abort();
    const controller = new AbortController();
    solutionControllerRef.current = controller;
    setIsLoadingSolution(true);
    setSolutionError(null);
    try {
      const solutionOriginalAttemptId = reviewTaskId ? undefined : originalAttemptId;
      const solutionDailyAssignmentId = reviewTaskId || solutionOriginalAttemptId
        ? undefined
        : dailyAssignmentId;
      const shouldBindSolutionAttempt = Boolean(reviewTaskId)
        || Boolean(solutionOriginalAttemptId && submitResult?.isCorrect === false);
      const solutionAttemptId = shouldBindSolutionAttempt
        ? submitResult?.attemptId
        : undefined;
      const nextSolution = await exerciseService.getSolution(
        requestedQuestion.id,
        solutionDailyAssignmentId,
        reviewTaskId,
        reviewTaskId
          ? (submitResult?.reviewTaskRevision ?? reviewTaskRevision)
          : undefined,
        solutionOriginalAttemptId,
        solutionAttemptId,
        controller.signal,
      );
      if (questionVersionRef.current !== requestedQuestionVersion) return;
      setSolution(nextSolution);
    } catch (err) {
      if (questionVersionRef.current !== requestedQuestionVersion) return;
      const requestError = toAppError(err, '获取题目解析失败，请稍后重试');
      if (controller.signal.aborted || requestError.kind === 'cancelled') return;
      setSolutionError(requestError);
      exerciseLogger.error('Failed to load solution', {
        questionId: requestedQuestion.id,
        error: err,
      });
    } finally {
      if (solutionRequestRef.current === solutionRequest) {
        solutionInFlightRef.current = false;
        setIsLoadingSolution(false);
      }
      if (solutionControllerRef.current === controller) {
        solutionControllerRef.current = null;
      }
    }
  }, [
    currentQuestion,
    dailyAssignmentId,
    originalAttemptId,
    reviewTaskId,
    reviewTaskRevision,
    submitResult?.attemptId,
    submitResult?.isCorrect,
    submitResult?.reviewTaskRevision,
  ]);

  return {
    currentQuestion,
    isLoading,
    isGenerating,
    isSubmitting: submitPhase !== 'idle',
    submitPhase,
    submitResult,
    solution,
    isLoadingSolution,
    solutionError,
    error,
    errorType,
    errorSource,
    loadQuestion,
    clearQuestion,
    loadNextQuestion,
    generateQuestion,
    submitAnswer,
    loadSolution,
  };
}
