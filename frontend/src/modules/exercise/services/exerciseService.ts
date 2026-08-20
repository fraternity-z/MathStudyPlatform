/**
 * 练习服务
 *
 * 对接后端 /exercise API，替代原有 Mock 实现
 */

import { apiClient } from '@/libs/http/apiClient';
import { logger } from '@/libs/utils/logger';

const exerciseLogger = logger.createContextLogger('ExerciseService');

// ========== 类型定义 ==========

export interface Question {
  id: string;
  title: string;
  content: string; // LaTeX
  difficulty: number;
  type: 'multiple_choice' | 'short_answer' | 'proof';
  source: 'class' | 'ai_generated' | 'review' | 'daily';
  knowledgePoints: string[];
  knowledgePointNames: string[];
  hintsAvailable: boolean;
  estimatedTimeSeconds: number;
  options?: string[] | null;
}

export type GenerateQuestionType = 'multiple_choice' | 'short_answer';

export interface ExerciseQuestionResponse {
  id: string;
  title: string;
  content: string;
  difficulty: number;
  type: string;
  source?: Question['source'];
  knowledge_points?: string[];
  knowledge_point_names?: string[];
  hints_available: boolean;
  estimated_time_seconds: number;
  options?: string[] | null;
}

export interface GenerateQuestionPayload {
  conceptId: string;
  difficulty: number;
  questionType: GenerateQuestionType;
}

export interface DiagnosisDetail {
  errorType: string | null;
  errorSubtype?: string;
  taxonomyCode?: string;
  errorDescription: string;
  errorStepIndex: number | null;
  severity: string;
  suggestion: string;
  relatedConcepts: string[];
}

export interface EvaluationEvidence {
  kind: string;
  summary: string;
}

export interface EvaluationDetail {
  method: string;
  reasonCode: string;
  reason: string;
  confidence: number;
  degraded: boolean;
  retryable: boolean;
  evidence: EvaluationEvidence[];
}

export interface SolutionFailure {
  code: string;
  stage: string;
  message: string;
  retryable: boolean;
}

export interface ExerciseSolution {
  answer: string;
  steps: string[];
  source: string;
  verification: EvaluationDetail | null;
  failure: SolutionFailure | null;
}

export interface SubmitResult {
  attemptId?: string;
  reviewTaskRevision?: number;
  masteryWeight?: number;
  isCorrect: boolean;
  recorded?: boolean;
  gradingStatus?: 'correct' | 'incorrect' | 'indeterminate';
  evaluation?: EvaluationDetail | null;
  score: number;
  studentAnswerLatex: string;
  correctAnswerLatex: string;
  diagnosis: DiagnosisDetail | null;
  feedback: string;
  masteryUpdate: Record<string, number> | null;
  masteryModel: string;
  nextRecommendation: 'continue' | 'review' | 'advance' | 'retry';
}

export interface SubmitPayload {
  exerciseId: string;
  dailyAssignmentId?: string;
  reviewTaskId?: string;
  reviewTaskRevision?: number;
  originalAttemptId?: string;
  submissionId: string;
  answerText?: string;
  answerImageUrl?: string;
  answerSteps?: string[];
  timeSpentSeconds: number;
}

const submitTimeoutMs = 120_000;

interface EvaluationResponse {
  method: string;
  reason_code: string;
  reason: string;
  confidence: number;
  degraded: boolean;
  retryable: boolean;
  evidence?: Array<{
    kind: string;
    summary: string;
  }>;
}

const mapEvaluation = (data?: EvaluationResponse | null): EvaluationDetail | null =>
  data
    ? {
        method: data.method,
        reasonCode: data.reason_code,
        reason: data.reason,
        confidence: data.confidence,
        degraded: data.degraded,
        retryable: data.retryable,
        evidence: (data.evidence ?? []).map((item) => ({
          kind: item.kind,
          summary: item.summary,
        })),
      }
    : null;

export const mapExerciseQuestion = (
  data: ExerciseQuestionResponse,
  sourceOverride?: Question['source'],
): Question => ({
  id: data.id,
  title: data.title,
  content: data.content,
  difficulty: data.difficulty,
  type: data.type as Question['type'],
  source: sourceOverride ?? data.source ?? 'class',
  knowledgePoints: data.knowledge_points ?? [],
  knowledgePointNames: data.knowledge_point_names ?? [],
  hintsAvailable: data.hints_available,
  estimatedTimeSeconds: data.estimated_time_seconds,
  options: data.options,
});

// ========== API 调用 ==========

export const exerciseService = {
  /**
   * 获取下一道自适应练习题
   */
  async fetchNextQuestion(
    conceptId?: string,
    difficulty?: number,
    signal?: AbortSignal,
  ): Promise<Question | null> {
    exerciseLogger.debug('Fetching next question', { conceptId, difficulty });

    const params: Record<string, string> = {};
    if (conceptId) params.concept_id = conceptId;
    if (difficulty !== undefined) params.difficulty = String(difficulty);

    const res = await apiClient.get<ExerciseQuestionResponse | null>('/exercise/next', {
      params,
      signal,
    });

    const data = res.data;
    if (!data) {
      return null;
    }
    return mapExerciseQuestion(data);
  },

  /**
   * 按指定知识点和难度生成一道学生自主练习题
   */
  async generateQuestion(
    payload: GenerateQuestionPayload,
    signal?: AbortSignal,
  ): Promise<Question> {
    exerciseLogger.debug('Generating question', {
      conceptId: payload.conceptId,
      difficulty: payload.difficulty,
      questionType: payload.questionType,
    });

    const res = await apiClient.post<ExerciseQuestionResponse>('/exercise/generate', {
      concept_id: payload.conceptId,
      difficulty: payload.difficulty,
      question_type: payload.questionType,
    }, {
      timeout: 60000,
      signal,
    });

    return mapExerciseQuestion(res.data);
  },

  /**
   * 提交答案
   */
  async submitAnswer(payload: SubmitPayload, signal?: AbortSignal): Promise<SubmitResult> {
    exerciseLogger.debug('Submitting answer', {
      exerciseId: payload.exerciseId,
    });

    const res = await apiClient.post<{
      attempt_id?: string;
      is_correct: boolean;
      recorded?: boolean;
      grading_status?: SubmitResult['gradingStatus'];
      evaluation?: EvaluationResponse | null;
      score: number;
      student_answer_latex: string;
      correct_answer_latex: string;
      diagnosis: {
        error_type: string | null;
        error_subtype?: string;
        taxonomy_code?: string;
        error_description: string;
        error_step_index: number | null;
        severity: string;
        suggestion: string;
        related_concepts: string[];
      } | null;
      feedback: string;
      mastery_update: Record<string, number> | null;
      mastery_model: string;
      next_recommendation: string;
      mastery_weight?: number;
      review_task_revision?: number;
    }>('/exercise/submit', {
      exercise_id: payload.exerciseId,
      ...(payload.dailyAssignmentId ? { daily_assignment_id: payload.dailyAssignmentId } : {}),
      ...(payload.reviewTaskId ? { review_task_id: payload.reviewTaskId } : {}),
      ...(payload.reviewTaskRevision !== undefined
        ? { review_task_revision: payload.reviewTaskRevision }
        : {}),
      ...(payload.originalAttemptId
        ? { original_attempt_id: payload.originalAttemptId }
        : {}),
      submission_id: payload.submissionId,
      ...(payload.answerText ? { answer_text: payload.answerText } : {}),
      ...(payload.answerImageUrl ? { answer_image_url: payload.answerImageUrl } : {}),
      answer_steps: payload.answerSteps,
      time_spent_seconds: payload.timeSpentSeconds,
    }, {
      timeout: submitTimeoutMs,
      signal,
    });

    const data = res.data;
    const recorded = data.recorded !== false;
    return {
      attemptId: data.attempt_id,
      ...(data.review_task_revision !== undefined
        ? { reviewTaskRevision: data.review_task_revision }
        : {}),
      ...(data.mastery_weight !== undefined
        ? { masteryWeight: data.mastery_weight }
        : {}),
      isCorrect: data.is_correct,
      recorded,
      gradingStatus:
        data.grading_status ?? (recorded ? (data.is_correct ? 'correct' : 'incorrect') : 'indeterminate'),
      evaluation: mapEvaluation(data.evaluation),
      score: data.score,
      studentAnswerLatex: data.student_answer_latex,
      correctAnswerLatex: data.correct_answer_latex,
      diagnosis: data.diagnosis
        ? {
            errorType: data.diagnosis.error_type,
            errorSubtype: data.diagnosis.error_subtype,
            taxonomyCode: data.diagnosis.taxonomy_code,
            errorDescription: data.diagnosis.error_description,
            errorStepIndex: data.diagnosis.error_step_index,
            severity: data.diagnosis.severity,
            suggestion: data.diagnosis.suggestion,
            relatedConcepts: data.diagnosis.related_concepts,
          }
        : null,
      feedback: data.feedback,
      masteryUpdate: data.mastery_update,
      masteryModel: data.mastery_model,
      nextRecommendation: data.next_recommendation as SubmitResult['nextRecommendation'],
    };
  },

  /**
   * 获取题目解析
   */
  async getSolution(
    exerciseId: string,
    dailyAssignmentId?: string,
    reviewTaskId?: string,
    reviewTaskRevision?: number,
    originalAttemptId?: string,
    solutionAttemptId?: string,
    signal?: AbortSignal,
  ): Promise<ExerciseSolution> {
    const normalizedDailyAssignmentId = dailyAssignmentId?.trim();
    const normalizedReviewTaskId = reviewTaskId?.trim();
    const normalizedOriginalAttemptId = originalAttemptId?.trim();
    const normalizedSolutionAttemptId = solutionAttemptId?.trim();
    const res = await apiClient.get<{
      exercise_id: string;
      answer: string;
      steps: string[];
      source: string;
      verification?: EvaluationResponse | null;
      failure?: {
        code: string;
        stage: string;
        message: string;
        retryable: boolean;
      } | null;
    }>(`/exercise/${exerciseId}/solution`, {
      params: {
        ...(normalizedDailyAssignmentId
          ? { daily_assignment_id: normalizedDailyAssignmentId }
          : {}),
        ...(normalizedReviewTaskId
          ? { review_task_id: normalizedReviewTaskId }
          : {}),
        ...(reviewTaskRevision !== undefined
          ? { review_task_revision: reviewTaskRevision }
          : {}),
        ...(normalizedOriginalAttemptId
          ? { original_attempt_id: normalizedOriginalAttemptId }
          : {}),
        ...(normalizedSolutionAttemptId
          ? { attempt_id: normalizedSolutionAttemptId }
          : {}),
      },
      signal,
    });

    return {
      answer: res.data.answer,
      steps: res.data.steps ?? [],
      source: res.data.source ?? 'cached',
      verification: mapEvaluation(res.data.verification),
      failure: res.data.failure
        ? {
            code: res.data.failure.code,
            stage: res.data.failure.stage,
            message: res.data.failure.message,
            retryable: res.data.failure.retryable,
          }
        : null,
    };
  },
};

export default exerciseService;
