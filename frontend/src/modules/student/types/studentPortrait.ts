/**
 * 学生画像类型定义
 */

import type { LearningFeedback } from '@/types/learningFeedback';

export interface StudentPortrait {
  student_id: string;
  portrait_content: string | null;
  portrait_generated_at: string | null;
  portrait_range: PortraitRangeType | null;
  portrait_snapshot_at: string | null;
  portrait_version: number;
  total_exercises: number;
  correct_rate: number;
  total_study_time_minutes: number;
  has_content: boolean;
}

export interface GeneratePortraitResponse {
  portrait_content: string;
  portrait_generated_at: string;
  portrait_range: PortraitRangeType;
  portrait_snapshot_at: string;
  portrait_version: number;
}

export interface ClearPortraitResponse {
  cleared: boolean;
  message: string;
}

export type PortraitRangeType = 'week' | 'month' | 'semester' | 'all';
export type PortraitComparisonBasis = 'unavailable' | 'all_classmates' | 'eligible_sample';

export interface PortraitInsightMetric {
  key: 'accuracy' | 'practice' | 'study_time' | 'active_days';
  label: string;
  personal_value: number;
  comparison_value: number | null;
  unit: string;
  class_average: number | null;
  exceeded_percent: number | null;
  sample_size: number;
  available: boolean;
  comparison_basis: PortraitComparisonBasis;
  unavailable_reason?: string;
}

export interface PortraitInsightTopic {
  learning_feedback?: LearningFeedback;
  concept_id: string;
  name: string;
  mastery: number | null;
  class_average: number | null;
  exceeded_percent: number | null;
  attempt_count: number;
  confidence: number;
  sample_size: number;
  available: boolean;
  comparison_basis: PortraitComparisonBasis;
  unavailable_reason?: string;
}

export interface PortraitInsightAction {
  learning_feedback?: LearningFeedback;
  type: 'practice' | 'review';
  title: string;
  description: string;
  concept_id: string | null;
  target_count: number;
  completed_count: number;
  status: 'not_started' | 'in_progress' | 'completed';
  started_at: string | null;
}

export interface PortraitActionStartResponse {
  concept_id: string;
  target_count: number;
  completed_count: number;
  status: 'in_progress' | 'completed';
  started_at: string;
}

export interface PortraitInsights {
  range: {
    type: PortraitRangeType;
    start_date: string;
    end_date: string;
  };
  metrics: PortraitInsightMetric[];
  strengths: PortraitInsightTopic[];
  improvements: PortraitInsightTopic[];
  observations: PortraitInsightTopic[];
  actions: PortraitInsightAction[];
  class_context: {
    in_class: boolean;
    class_size: number;
    active_students: number;
  };
  data_updated_at: string;
}
