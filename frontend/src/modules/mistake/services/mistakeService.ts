/**
 * 错题本服务
 *
 * 对接后端 /mistakes API
 */

import { apiClient } from '@/libs/http/apiClient';
import { logger } from '@/libs/utils/logger';

const mistakeLogger = logger.createContextLogger('MistakeService');

// ========== 类型定义 ==========

export interface MistakeExercise {
  id: string;
  title: string;
  content: string;
  difficulty: number;
  knowledgePoints: string[];
  knowledgePointNames: string[];
}

export interface MistakeAttempt {
  studentAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  score: number;
  submittedAt: string | null;
  timeSpentSeconds: number;
}

export interface MistakeDiagnosis {
  errorType: string | null;
  errorSubtype: string;
  severity: string;
  explanation: string;
  suggestion: string;
  relatedConcepts: string[];
}

export interface MistakeMastery {
  current: number;
  previous: number;
  trend: 'improving' | 'declining' | 'stable';
}

export interface MistakeRecord {
  id: string;
  exercise: MistakeExercise;
  attempt: MistakeAttempt;
  diagnosis: MistakeDiagnosis;
  mastery: MistakeMastery;
  errorCount: number;
  lastReviewedAt: string | null;
  isEarlyPractice: boolean;
  /** Current review-plan projection; absent for legacy records without a task. */
  reviewTaskId?: string | null;
  reviewStatus?: 'pending' | 'verification_due' | 'mastered' | 'archived' | null;
  reviewDueAt?: string | null;
  reviewStage?: number | null;
  reviewCount?: number;
  successfulReviewCount?: number;
  masteredAt?: string | null;
  reviewRevision?: number | null;
  reviewLastOutcome?: boolean | null;
  reviewLastReviewedAt?: string | null;
  reviewIsDue?: boolean;
  dailyCorrection?: boolean;
  canReview: boolean;
  canDelete: boolean;
  canArchive: boolean;
}

export interface PaginationInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface MistakeStatistics {
  totalMistakes: number;
  weakConcepts: number;
  avgMastery: number;
}

export interface MistakeListResponse {
  items: MistakeRecord[];
  pagination: PaginationInfo;
  statistics: MistakeStatistics;
}

export interface ErrorTypeDistribution {
  count: number;
  percentage: number;
  label: string;
}

export interface ConceptWeakness {
  conceptId: string;
  conceptName: string;
  mistakeCount: number;
  mastery: number;
  recentMistakes: number;
}

export interface StatisticsOverview {
  totalMistakes: number;
  totalExercises: number;
  mistakeRate: number;
  avgMastery: number;
}

export interface MistakeStatisticsResponse {
  overview: StatisticsOverview;
  errorTypeDistribution: Record<string, ErrorTypeDistribution>;
  conceptWeakness: ConceptWeakness[];
}

export interface MistakeDetailExercise {
  id: string;
  title: string;
  content: string;
  difficulty: number;
  knowledgePoints: string[];
  hints: string[];
}

export interface MistakeDetailAttempt {
  studentAnswer: string;
  studentSteps: string[];
  correctAnswer: string;
  submittedAt: string | null;
  timeSpentSeconds: number;
}

export interface MistakeDetailDiagnosis {
  errorType: string | null;
  errorStepIndex: number | null;
  explanation: string;
  suggestion: string;
  relatedConcepts: string[];
}

export interface MistakeSolution {
  answer: string;
  steps: string[];
  source: string;
}

export interface MistakeHistory {
  attemptId: string;
  submittedAt: string | null;
  isCorrect: boolean;
  score: number;
}

export interface MistakeDetail {
  attemptId: string;
  exercise: MistakeDetailExercise;
  attempt: MistakeDetailAttempt;
  diagnosis: MistakeDetailDiagnosis;
  solution: MistakeSolution;
  history: MistakeHistory[];
}

export interface MarkAsMasteredResponse {
  success: boolean;
  masteredAt: string;
  masteryUpdate: Record<string, number>;
}

export interface ReviewExercise {
  id: string;
  title: string;
  content: string;
  difficulty: number;
  type: 'multiple_choice' | 'short_answer' | 'proof';
  knowledgePoints: string[];
  knowledgePointNames: string[];
  hintsAvailable: boolean;
  estimatedTimeSeconds: number;
  options: string[] | null;
}

export interface ReviewContext {
  isReview: boolean;
  originalAttemptId: string;
  reviewTaskId?: string;
  reviewTaskRevision?: number;
  dailyAssignmentId?: string;
  previousAnswer: string;
  previousErrorType: string | null;
  previousExplanation: string;
  previousSuggestion: string;
  masteryBefore: number;
  errorCount: number;
}

export interface ReviewExerciseResponse {
  exercise: ReviewExercise;
  context: ReviewContext;
}

export type ReviewTaskView = 'due' | 'mastered';

export interface ReviewTaskCounts {
  active: number;
  dueNow: number;
  mastered: number;
}

export interface ReviewTask {
  id: string;
  sourceAttemptId: string;
  status: 'pending' | 'verification_due' | 'mastered';
  stage: number;
  revision: number;
  reviewCount: number;
  successfulReviewCount: number;
  errorCount: number;
  dueAt: string | null;
  lastOutcome: boolean | null;
  lastReviewedAt: string | null;
  masteredAt: string | null;
  isDue: boolean;
  canReview: boolean;
  exercise: MistakeExercise;
  diagnosis: MistakeDiagnosis;
  mastery: MistakeMastery;
}

export interface ReviewTaskListResponse {
  items: ReviewTask[];
  pagination: PaginationInfo;
  counts: ReviewTaskCounts;
}

export interface ReviewTaskQueryParams {
  view: ReviewTaskView;
  page?: number;
  pageSize?: number;
  conceptId?: string;
  errorType?: string;
  dueStatus?: 'all' | 'due' | 'scheduled';
  stage?: number;
  errorCountMin?: number;
  sortBy?: 'due_at' | 'mastered_at' | 'error_count' | 'mastery' | 'stage';
  sortOrder?: 'asc' | 'desc';
}

export interface ArchiveMistakeResponse {
  success: boolean;
  message: string;
}

export interface MistakeQueryParams {
  page?: number;
  pageSize?: number;
  errorType?: string;
  conceptId?: string;
  difficultyMin?: number;
  difficultyMax?: number;
  dateFrom?: string;
  dateTo?: string;
  masteryStatus?: 'all' | 'weak' | 'improving' | 'mastered';
  sortBy?: 'time' | 'error_count' | 'mastery';
  sortOrder?: 'asc' | 'desc';
  dueStatus?: 'all' | 'due' | 'scheduled';
  stage?: number;
  errorCountMin?: number;
}

export interface ReviewParams {
  focusConcept?: string;
  focusErrorType?: string;
}

// ========== 后端原始响应（snake_case）==========

interface MistakeListResponseRaw {
  items: Array<{
    id: string;
    exercise: {
      id: string;
      title: string;
      content: string;
      difficulty: number;
      knowledge_points: string[] | null;
      knowledge_point_names?: string[] | null;
    };
    attempt: {
      student_answer: string;
      correct_answer: string;
      is_correct: boolean;
      score: number;
      submitted_at: string | null;
      time_spent_seconds: number;
    };
    diagnosis: {
      error_type: string | null;
      error_subtype: string;
      severity: string;
      explanation: string;
      suggestion: string;
      related_concepts: string[] | null;
    };
    mastery: {
      current: number;
      previous: number;
      trend: 'improving' | 'declining' | 'stable';
    };
    error_count: number;
    last_reviewed_at: string | null;
    is_early_practice: boolean;
    review_task_id?: string | null;
    review_status?: MistakeRecord['reviewStatus'];
    review_due_at?: string | null;
    review_stage?: number | null;
    review_count?: number;
    successful_review_count?: number;
    mastered_at?: string | null;
    review_revision?: number | null;
    review_last_outcome?: boolean | null;
    review_last_reviewed_at?: string | null;
    review_is_due?: boolean;
    daily_correction?: boolean;
    can_review: boolean;
    can_delete: boolean;
    can_archive: boolean;
  }>;
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
  statistics: {
    total_mistakes: number;
    weak_concepts: number;
    avg_mastery: number;
  };
}

interface MistakeStatisticsResponseRaw {
  overview: {
    total_mistakes: number;
    total_exercises: number;
    mistake_rate: number;
    avg_mastery: number;
  };
  error_type_distribution: Record<
    string,
    {
      count: number;
      percentage: number;
      label: string;
    }
  >;
  concept_weakness: Array<{
    concept_id: string;
    concept_name: string;
    mistake_count: number;
    mastery: number;
    recent_mistakes: number;
  }>;
}

interface MistakeDetailRaw {
  attempt_id: string;
  exercise: {
    id: string;
    title: string;
    content: string;
    difficulty: number;
    knowledge_points: string[] | null;
    hints: string[] | null;
  };
  attempt: {
    student_answer: string;
    student_steps: string[] | null;
    correct_answer: string;
    submitted_at: string | null;
    time_spent_seconds: number;
  };
  diagnosis: {
    error_type: string | null;
    error_step_index: number | null;
    explanation: string;
    suggestion: string;
    related_concepts: string[] | null;
  };
  solution: {
    answer: string;
    steps: string[] | null;
    source: string;
  };
  history: Array<{
    attempt_id: string;
    submitted_at: string | null;
    is_correct: boolean;
    score: number;
  }>;
}

interface MarkAsMasteredResponseRaw {
  success: boolean;
  mastered_at: string;
  mastery_update: Record<string, number>;
}

interface ReviewExerciseResponseRaw {
  exercise: {
    id: string;
    title: string;
    content: string;
    difficulty: number;
    type: string;
    knowledge_points: string[] | null;
    knowledge_point_names: string[] | null;
    hints_available: boolean;
    estimated_time_seconds: number;
    options: string[] | null;
  };
  context: {
    is_review: boolean;
    original_attempt_id: string;
    review_task_id?: string;
    review_task_revision?: number;
    daily_assignment_id?: string;
    previous_answer: string;
    previous_error_type: string | null;
    previous_explanation: string;
    previous_suggestion: string;
    mastery_before: number;
    error_count: number;
  };
}

interface ReviewTaskListResponseRaw {
  items: Array<{
    id: string;
    source_attempt_id: string;
    status: ReviewTask['status'];
    stage: number;
    revision: number;
    review_count: number;
    successful_review_count: number;
    error_count: number;
    due_at: string | null;
    last_outcome: boolean | null;
    last_reviewed_at: string | null;
    mastered_at: string | null;
    is_due: boolean;
    can_review: boolean;
    exercise: {
      id: string;
      title: string;
      content: string;
      difficulty: number;
      knowledge_points: string[] | null;
      knowledge_point_names?: string[] | null;
    };
    diagnosis: {
      error_type: string | null;
      error_subtype: string;
      severity: string;
      explanation: string;
      suggestion: string;
      related_concepts: string[] | null;
    };
    mastery: {
      current: number;
      previous: number;
      trend: MistakeMastery['trend'];
    };
  }>;
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
  counts: {
    active: number;
    due_now: number;
    mastered: number;
  };
}

// ========== 数据映射（snake_case -> camelCase）==========

function mapMistakeRecord(raw: MistakeListResponseRaw['items'][number]): MistakeRecord {
  return {
    id: raw.id,
    exercise: {
      id: raw.exercise.id,
      title: raw.exercise.title,
      content: raw.exercise.content,
      difficulty: raw.exercise.difficulty,
      knowledgePoints: raw.exercise.knowledge_points ?? [],
      knowledgePointNames: raw.exercise.knowledge_point_names ?? [],
    },
    attempt: {
      studentAnswer: raw.attempt.student_answer,
      correctAnswer: raw.attempt.correct_answer,
      isCorrect: raw.attempt.is_correct,
      score: raw.attempt.score,
      submittedAt: raw.attempt.submitted_at,
      timeSpentSeconds: raw.attempt.time_spent_seconds,
    },
    diagnosis: {
      errorType: raw.diagnosis.error_type,
      errorSubtype: raw.diagnosis.error_subtype,
      severity: raw.diagnosis.severity,
      explanation: raw.diagnosis.explanation,
      suggestion: raw.diagnosis.suggestion,
      relatedConcepts: raw.diagnosis.related_concepts ?? [],
    },
    mastery: raw.mastery,
    errorCount: raw.error_count,
    lastReviewedAt: raw.last_reviewed_at,
    isEarlyPractice: raw.is_early_practice ?? false,
    reviewTaskId: raw.review_task_id ?? null,
    reviewStatus: raw.review_status ?? null,
    reviewDueAt: raw.review_due_at ?? null,
    reviewStage: raw.review_stage ?? null,
    reviewCount: raw.review_count ?? 0,
    successfulReviewCount: raw.successful_review_count ?? 0,
    masteredAt: raw.mastered_at ?? null,
    reviewRevision: raw.review_revision ?? null,
    reviewLastOutcome: raw.review_last_outcome ?? null,
    reviewLastReviewedAt: raw.review_last_reviewed_at ?? null,
    reviewIsDue: raw.review_is_due ?? false,
    dailyCorrection: raw.daily_correction ?? false,
    canReview: raw.can_review,
    canDelete: raw.can_delete,
    canArchive: raw.can_archive,
  };
}

function mapMistakeListResponse(raw: MistakeListResponseRaw): MistakeListResponse {
  return {
    items: raw.items.map(mapMistakeRecord),
    pagination: {
      page: raw.pagination.page,
      pageSize: raw.pagination.page_size,
      total: raw.pagination.total,
      totalPages: raw.pagination.total_pages,
    },
    statistics: {
      totalMistakes: raw.statistics.total_mistakes,
      weakConcepts: raw.statistics.weak_concepts,
      avgMastery: raw.statistics.avg_mastery,
    },
  };
}

function mapMistakeStatisticsResponse(raw: MistakeStatisticsResponseRaw): MistakeStatisticsResponse {
  return {
    overview: {
      totalMistakes: raw.overview.total_mistakes,
      totalExercises: raw.overview.total_exercises,
      mistakeRate: raw.overview.mistake_rate,
      avgMastery: raw.overview.avg_mastery,
    },
    errorTypeDistribution: raw.error_type_distribution,
    conceptWeakness: raw.concept_weakness.map((c) => ({
      conceptId: c.concept_id,
      conceptName: c.concept_name,
      mistakeCount: c.mistake_count,
      mastery: c.mastery,
      recentMistakes: c.recent_mistakes,
    })),
  };
}

function mapMistakeDetail(raw: MistakeDetailRaw): MistakeDetail {
  return {
    attemptId: raw.attempt_id,
    exercise: {
      id: raw.exercise.id,
      title: raw.exercise.title,
      content: raw.exercise.content,
      difficulty: raw.exercise.difficulty,
      knowledgePoints: raw.exercise.knowledge_points ?? [],
      hints: raw.exercise.hints ?? [],
    },
    attempt: {
      studentAnswer: raw.attempt.student_answer,
      studentSteps: raw.attempt.student_steps ?? [],
      correctAnswer: raw.attempt.correct_answer,
      submittedAt: raw.attempt.submitted_at,
      timeSpentSeconds: raw.attempt.time_spent_seconds,
    },
    diagnosis: {
      errorType: raw.diagnosis.error_type,
      errorStepIndex: raw.diagnosis.error_step_index,
      explanation: raw.diagnosis.explanation,
      suggestion: raw.diagnosis.suggestion,
      relatedConcepts: raw.diagnosis.related_concepts ?? [],
    },
    solution: {
      answer: raw.solution.answer,
      steps: raw.solution.steps ?? [],
      source: raw.solution.source,
    },
    history: raw.history.map((h) => ({
      attemptId: h.attempt_id,
      submittedAt: h.submitted_at,
      isCorrect: h.is_correct,
      score: h.score,
    })),
  };
}

function mapReviewExerciseResponse(raw: ReviewExerciseResponseRaw): ReviewExerciseResponse {
  return {
    exercise: {
      id: raw.exercise.id,
      title: raw.exercise.title,
      content: raw.exercise.content,
      difficulty: raw.exercise.difficulty,
      type: raw.exercise.type as ReviewExercise['type'],
      knowledgePoints: raw.exercise.knowledge_points ?? [],
      knowledgePointNames: raw.exercise.knowledge_point_names ?? [],
      hintsAvailable: raw.exercise.hints_available,
      estimatedTimeSeconds: raw.exercise.estimated_time_seconds,
      options: raw.exercise.options,
    },
    context: {
      isReview: raw.context.is_review,
      originalAttemptId: raw.context.original_attempt_id,
      ...(raw.context.review_task_id
        ? { reviewTaskId: raw.context.review_task_id }
        : {}),
      ...(raw.context.review_task_revision !== undefined
        ? { reviewTaskRevision: raw.context.review_task_revision }
        : {}),
      ...(raw.context.daily_assignment_id
        ? { dailyAssignmentId: raw.context.daily_assignment_id }
        : {}),
      previousAnswer: raw.context.previous_answer,
      previousErrorType: raw.context.previous_error_type,
      previousExplanation: raw.context.previous_explanation,
      previousSuggestion: raw.context.previous_suggestion,
      masteryBefore: raw.context.mastery_before,
      errorCount: raw.context.error_count,
    },
  };
}

function mapReviewTaskListResponse(raw: ReviewTaskListResponseRaw): ReviewTaskListResponse {
  return {
    items: raw.items.map((item) => ({
      id: item.id,
      sourceAttemptId: item.source_attempt_id,
      status: item.status,
      stage: item.stage,
      revision: item.revision,
      reviewCount: item.review_count,
      successfulReviewCount: item.successful_review_count,
      errorCount: item.error_count,
      dueAt: item.due_at,
      lastOutcome: item.last_outcome,
      lastReviewedAt: item.last_reviewed_at,
      masteredAt: item.mastered_at,
      isDue: item.is_due,
      canReview: item.can_review,
      exercise: {
        id: item.exercise.id,
        title: item.exercise.title,
        content: item.exercise.content,
        difficulty: item.exercise.difficulty,
        knowledgePoints: item.exercise.knowledge_points ?? [],
        knowledgePointNames: item.exercise.knowledge_point_names ?? [],
      },
      diagnosis: {
        errorType: item.diagnosis.error_type,
        errorSubtype: item.diagnosis.error_subtype,
        severity: item.diagnosis.severity,
        explanation: item.diagnosis.explanation,
        suggestion: item.diagnosis.suggestion,
        relatedConcepts: item.diagnosis.related_concepts ?? [],
      },
      mastery: item.mastery,
    })),
    pagination: {
      page: raw.pagination.page,
      pageSize: raw.pagination.page_size,
      total: raw.pagination.total,
      totalPages: raw.pagination.total_pages,
    },
    counts: {
      active: raw.counts.active,
      dueNow: raw.counts.due_now,
      mastered: raw.counts.mastered,
    },
  };
}

// ========== API 方法 ==========

/**
 * 获取错题列表
 */
export async function fetchMistakes(
  params: MistakeQueryParams = {},
  signal?: AbortSignal
): Promise<MistakeListResponse> {
  mistakeLogger.info('Fetching mistakes', { params });

  try {
    const response = await apiClient.get<MistakeListResponseRaw>('/mistakes', {
      params: {
        page: params.page || 1,
        page_size: params.pageSize || 20,
        error_type: params.errorType,
        concept_id: params.conceptId,
        difficulty_min: params.difficultyMin,
        difficulty_max: params.difficultyMax,
        date_from: params.dateFrom,
        date_to: params.dateTo,
        mastery_status: params.masteryStatus || 'all',
        sort_by: params.sortBy || 'time',
        sort_order: params.sortOrder || 'desc',
        due_status: params.dueStatus || 'all',
        stage: params.stage,
        error_count_min: params.errorCountMin,
      },
      signal,
    });

    const mapped = mapMistakeListResponse(response.data);

    mistakeLogger.info('Mistakes fetched successfully', {
      total: mapped.pagination.total,
    });

    return mapped;
  } catch (error) {
    mistakeLogger.error('Failed to fetch mistakes', { error });
    throw error;
  }
}

/**
 * 获取错题统计
 */
export async function fetchStatistics(
  timeRange: string = 'month'
): Promise<MistakeStatisticsResponse> {
  mistakeLogger.info('Fetching mistake statistics', { timeRange });

  try {
    const response = await apiClient.get<MistakeStatisticsResponseRaw>(
      '/mistakes/statistics',
      {
        params: { time_range: timeRange },
      }
    );

    mistakeLogger.info('Statistics fetched successfully');

    return mapMistakeStatisticsResponse(response.data);
  } catch (error) {
    mistakeLogger.error('Failed to fetch statistics', { error });
    throw error;
  }
}

/**
 * 获取错题详情
 */
export async function fetchMistakeDetail(
  attemptId: string
): Promise<MistakeDetail> {
  mistakeLogger.info('Fetching mistake detail', { attemptId });

  try {
    const response = await apiClient.get<MistakeDetailRaw>(
      `/mistakes/${attemptId}`
    );

    mistakeLogger.info('Mistake detail fetched successfully');

    return mapMistakeDetail(response.data);
  } catch (error) {
    mistakeLogger.error('Failed to fetch mistake detail', { error });
    throw error;
  }
}

/**
 * 标记错题已掌握
 */
export async function markAsMastered(
  attemptId: string
): Promise<MarkAsMasteredResponse> {
  mistakeLogger.info('Marking mistake as mastered', { attemptId });

  try {
    const response = await apiClient.post<MarkAsMasteredResponseRaw>(
      `/mistakes/${attemptId}/master`
    );

    mistakeLogger.info('Mistake marked as mastered successfully');

    return {
      success: response.data.success,
      masteredAt: response.data.mastered_at,
      masteryUpdate: response.data.mastery_update,
    };
  } catch (error) {
    mistakeLogger.error('Failed to mark mistake as mastered', { error });
    throw error;
  }
}

/**
 * 删除错题
 */
export async function archiveMistake(
  attemptId: string
): Promise<ArchiveMistakeResponse> {
  const normalizedAttemptId = attemptId.trim();
  if (!normalizedAttemptId) {
    throw new Error('缺少错题记录 ID');
  }

  mistakeLogger.info('Archiving mistake record', { attemptId: normalizedAttemptId });

  try {
    const response = await apiClient.delete<{
      success: boolean;
      message: string;
    }>(`/mistakes/${encodeURIComponent(normalizedAttemptId)}`);

    mistakeLogger.info('Mistake record archived successfully');
    return {
      success: response.data.success,
      message: response.data.message,
    };
  } catch (error) {
    mistakeLogger.error('Failed to archive mistake record', { error });
    throw error;
  }
}

/**
 * 兼容现有 Redux thunk；后端已将该操作改为归档而非删除作答证据。
 */
export async function deleteMistake(attemptId: string): Promise<void> {
  await archiveMistake(attemptId);
}

/**
 * 获取待复习或已验证掌握的任务。
 */
export async function fetchReviewTasks(
  params: ReviewTaskQueryParams,
  signal?: AbortSignal
): Promise<ReviewTaskListResponse> {
  mistakeLogger.info('Fetching mistake review tasks', { params });

  try {
    const response = await apiClient.get<ReviewTaskListResponseRaw>(
      '/mistakes/review-tasks',
      {
        params: {
          view: params.view,
          page: params.page || 1,
          page_size: params.pageSize || 20,
          concept_id: params.conceptId,
          error_type: params.errorType,
          due_status: params.dueStatus,
          stage: params.stage,
          error_count_min: params.errorCountMin,
          sort_by: params.sortBy,
          sort_order: params.sortOrder,
        },
        signal,
      }
    );
    const mapped = mapReviewTaskListResponse(response.data);
    mistakeLogger.info('Mistake review tasks fetched successfully', {
      view: params.view,
      total: mapped.pagination.total,
    });
    return mapped;
  } catch (error) {
    mistakeLogger.error('Failed to fetch mistake review tasks', { error });
    throw error;
  }
}

/**
 * 获取复习题目
 */
export async function fetchReviewExercise(
  params: ReviewParams = {}
): Promise<ReviewExerciseResponse> {
  mistakeLogger.info('Fetching review exercise', { params });

  try {
    const response = await apiClient.get<ReviewExerciseResponseRaw>(
      '/mistakes/review/next',
      {
        params: {
          focus_concept: params.focusConcept,
          focus_error_type: params.focusErrorType,
        },
      }
    );

    mistakeLogger.info('Review exercise fetched successfully');

    return mapReviewExerciseResponse(response.data);
  } catch (error) {
    mistakeLogger.error('Failed to fetch review exercise', { error });
    throw error;
  }
}

/**
 * 获取指定错题的重做内容
 */
export async function fetchReviewExerciseByAttempt(
  attemptId: string,
  signal?: AbortSignal
): Promise<ReviewExerciseResponse> {
  const normalizedAttemptId = attemptId.trim();
  if (!normalizedAttemptId) {
    throw new Error('缺少错题记录 ID');
  }

  mistakeLogger.info('Fetching exact mistake review exercise', {
    attemptId: normalizedAttemptId,
  });

  try {
    const response = await apiClient.get<ReviewExerciseResponseRaw>(
      `/mistakes/${encodeURIComponent(normalizedAttemptId)}/review`,
      { signal }
    );
    return mapReviewExerciseResponse(response.data);
  } catch (error) {
    mistakeLogger.error('Failed to fetch exact mistake review exercise', { error });
    throw error;
  }
}

// 默认导出
export const mistakeService = {
  fetchMistakes,
  fetchStatistics,
  fetchMistakeDetail,
  markAsMastered,
  archiveMistake,
  deleteMistake,
  fetchReviewTasks,
  fetchReviewExercise,
  fetchReviewExerciseByAttempt,
};

export default mistakeService;
