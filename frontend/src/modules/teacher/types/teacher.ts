/**
 * 教师相关类型定义
 */

/**
 * 教师工作台统计数据
 */
export interface DashboardStats {
  /** 总学生数 */
  total_students: number;
  /** 今日活跃率（百分比） */
  active_today: number;
  /** 保留的兼容字段；当前没有独立的工作台完成率口径 */
  avg_completion_rate: number | null;
  /** 保留的兼容字段；平台当前没有人工批改队列 */
  pending_grading: number | null;
}

/**
 * 学生管理统计数据
 */
export interface StudentsStats {
  /** 总学生数 */
  total_students: number;
  /** 平均成绩 */
  avg_score: number;
  /** 今日活跃率（百分比） */
  active_today: number;
  /** 需关注学生数 */
  need_attention: number;
}

/** 教师学生列表查询参数 */
export interface TeacherStudentListParams {
  page?: number;
  page_size?: number;
  class_id?: string;
  search?: string;
}

/** 教师学生列表项 */
export interface TeacherStudentListItem {
  id: string;
  username: string;
  email: string;
  display_name?: string | null;
  class_id: string;
  class_name: string;
}

/** 教师学生列表分页响应 */
export interface TeacherStudentListResponse {
  items: TeacherStudentListItem[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

// =============================================================================
// 数据分析类型 (TeacherDashboardPage)
// =============================================================================

/** 数据分析页概览统计 */
export interface AnalyticsOverview {
  total_students: number;
  avg_completion_rate: number;
  avg_score: number;
  avg_study_hours: number;
}

/** 知识点掌握度 */
export interface KnowledgePointMastery {
  concept_id: string;
  name: string;
  mastery: number;
  student_count: number;
}

/** 周活跃度数据项 */
export interface WeeklyActivityItem {
  date: string;
  day_label: string;
  active_rate: number;
}

/** 成绩排行学生 */
export interface TopStudentItem {
  rank: number;
  student_id: string;
  name: string;
  avg_score: number;
}

/** 教师数据分析页完整数据 */
export interface TeacherAnalyticsData {
  overview: AnalyticsOverview;
  knowledge_points: KnowledgePointMastery[];
  weekly_activity: WeeklyActivityItem[];
  top_students: TopStudentItem[];
}

// =============================================================================
// 班级分析类型 (ClassDetailPage)
// =============================================================================

/** 班级分析统计 */
export interface ClassAnalyticsStats {
  average_mastery: number;
  average_score: number;
  weekly_study_hours: number;
}

/** 班级知识点掌握度 */
export interface ClassTopicMastery {
  concept_id: string;
  topic: string;
  mastery: number;
  student_count: number;
}

/** 班级高频错题 */
export interface ClassCommonError {
  id: string;
  content: string;
  count: number;
  topic: string;
  error_type: string;
}

/** 学情预警 */
export interface ClassAlert {
  id: string;
  student_id: string;
  student_name: string;
  type: string;
  message: string;
  severity: 'high' | 'medium';
}

/** 班级学生排名 */
export interface ClassStudentRank {
  student_id: string;
  name: string;
  avg_score: number;
}

/** 班级分析完整数据 */
export interface ClassAnalyticsData {
  stats: ClassAnalyticsStats;
  topic_mastery: ClassTopicMastery[];
  common_errors: ClassCommonError[];
  alerts: ClassAlert[];
  student_rankings: ClassStudentRank[];
}

// =============================================================================
// 学生详情类型 (StudentDetailPage)
// =============================================================================

/** 学生基本信息 */
export interface StudentBasicInfo {
  id: string;
  name: string;
  username: string;
  email: string;
  class_name: string;
  joined_at: string | null;
  last_active: string | null;
  total_study_hours: number;
  total_exercises: number;
  correct_rate: number;
  avg_score: number;
  rank: number;
  total_class_students: number;
  streak_days: number;
}

/** 学生知识点掌握度 */
export interface StudentTopicMastery {
  concept_id: string;
  topic: string;
  mastery: number;
  exercise_count: number;
}

/** 学生最近学习动态 */
export interface StudentRecentActivity {
  id: string;
  type: string;
  content: string;
  time: string;
  status: string;
}

/** 学生最近错题 */
export interface StudentMistake {
  id: string;
  content: string;
  error_type: string;
  date: string;
  explanation: string | null;
}

/** 学生详情完整数据 */
export interface StudentDetailData {
  student: StudentBasicInfo;
  topic_mastery: StudentTopicMastery[];
  recent_activity: StudentRecentActivity[];
  recent_mistakes: StudentMistake[];
}
