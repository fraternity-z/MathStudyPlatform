import { apiClient } from '@/libs/http/apiClient';
import { formatDateOrFallback } from '@/libs/utils/dateFormat';
import { classService } from '@/modules/classroom/services/classService';
import { sessionService } from '@/modules/session/services/sessionService';
import { teacherService } from '@/modules/teacher/services/teacherService';
import type { ClassInfo } from '@/modules/classroom/types/classroom';
import type { PersonalHomeData, HomeActionItem, HomeRecentItem, HomeStat } from './types';
import { dailyQuestionService } from '@/modules/daily-question/services/dailyQuestionService';
import {
  getDailyQuestionPresentation,
  type DailyQuestionAssignment,
} from '@/modules/daily-question/types/dailyQuestion';

interface StudentOverviewResponse {
  total_exercises: number;
  correct_count: number;
  correct_rate: number;
  study_time_minutes: number;
  streak_days: number;
  mastered_concepts: number;
}

interface StudentMasteryTopic {
  topic: string;
  mastery: number;
  exercises: number;
  confidence: number;
}

interface StudentMasteryResponse {
  topics: StudentMasteryTopic[];
}

const studentFallbackActions: HomeActionItem[] = [
  {
    id: 'smart-practice',
    title: '智能刷题',
    description: '根据当前掌握情况生成下一组练习',
    href: '/exercise',
    tone: 'blue',
  },
  {
    id: 'ai-tutor',
    title: 'AI 辅导',
    description: '把还没想通的问题交给学习助手',
    href: '/session/new',
    tone: 'violet',
  },
  {
    id: 'learning-path',
    title: '学习路径',
    description: '查看知识点之间的先后关系与进度',
    href: '/learning-path',
    tone: 'emerald',
  },
];

const teacherFallbackActions: HomeActionItem[] = [
  {
    id: 'teaching-overview',
    title: '查看班级学情',
    description: '掌握本周整体学习进度与薄弱知识点',
    href: '/teacher/dashboard',
    tone: 'blue',
  },
  {
    id: 'manage-classes',
    title: '管理班级',
    description: '查看班级成员、邀请码与教学安排',
    href: '/teacher/classes',
    tone: 'violet',
  },
  {
    id: 'question-bank',
    title: '完善题库',
    description: '补充题目并维护知识点关联',
    href: '/teacher/question-bank',
    tone: 'emerald',
  },
];

export function formatStudyMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0分钟';
  const hours = Math.floor(minutes / 60);
  const restMinutes = Math.floor(minutes % 60);
  if (hours === 0) return `${restMinutes}分钟`;
  if (restMinutes === 0) return `${hours}小时`;
  return `${hours}小时${restMinutes}分`;
}

export function getGreeting(hour: number): string {
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function resultValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

function collectFailures(
  entries: Array<[string, PromiseSettledResult<unknown>]>
): string[] {
  return entries.flatMap(([label, result]) => result.status === 'rejected' ? [label] : []);
}

function buildStudentStats(overview: StudentOverviewResponse | null): HomeStat[] {
  return [
    {
      key: 'study-time',
      label: '累计学习',
      value: overview ? formatStudyMinutes(overview.study_time_minutes) : '—',
      detail: overview ? `累计完成 ${overview.total_exercises} 道题` : undefined,
      tone: 'blue',
    },
    {
      key: 'accuracy',
      label: '正确率',
      value: overview ? `${clampPercent(overview.correct_rate)}%` : '—',
      detail: overview ? `答对 ${overview.correct_count} 道` : undefined,
      tone: 'violet',
    },
    {
      key: 'streak',
      label: '连续学习',
      value: overview ? `${Math.max(0, overview.streak_days)}天` : '—',
      detail: '保持稳定节奏',
      tone: 'emerald',
    },
    {
      key: 'mastered',
      label: '已掌握',
      value: overview ? `${Math.max(0, overview.mastered_concepts)}个知识点` : '—',
      detail: '继续拓展知识边界',
      tone: 'coral',
    },
  ];
}

function buildStudentActions(mastery: StudentMasteryResponse | null): HomeActionItem[] {
  if (!mastery?.topics.length) return studentFallbackActions;

  const tones: HomeActionItem['tone'][] = ['blue', 'violet', 'emerald'];
  return [...mastery.topics]
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, 3)
    .map((topic, index) => {
      const masteryPercent = clampPercent(topic.mastery * 100);
      return {
        id: `${topic.topic}-${index}`,
        title: topic.topic,
        description: topic.exercises > 0
          ? `已完成 ${topic.exercises} 次练习，适合继续巩固`
          : '从基础练习开始建立理解',
        href: '/exercise',
        progress: masteryPercent,
        meta: `掌握 ${masteryPercent}%`,
        tone: tones[index],
      };
    });
}

function buildDailyQuestionAction(assignment: DailyQuestionAssignment | null): HomeActionItem {
  const presentation = getDailyQuestionPresentation(assignment);
  const tone: HomeActionItem['tone'] = presentation.tone === 'success'
    ? 'emerald'
    : presentation.tone === 'warning' || presentation.tone === 'danger'
      ? 'coral'
      : presentation.tone === 'info'
        ? 'violet'
        : 'blue';

  return {
    id: 'daily-question',
    title: '每日一题',
    description: presentation.description,
    href: '/daily-question',
    meta: presentation.label,
    tone,
  };
}

function buildStudentRecentItems(
  sessions: Awaited<ReturnType<typeof sessionService.getSessions>> | null
): HomeRecentItem[] {
  return (sessions?.sessions ?? []).slice(0, 3).map((session) => ({
    id: session.session_id,
    title: session.topic?.trim() || '高等数学学习会话',
    description: `${session.message_count} 条消息 · ${session.status === 'active' ? '可以继续学习' : '已保存学习记录'}`,
    timestamp: formatDateOrFallback(session.started_at, 'M月d日 HH:mm', { fallback: '时间未知' }),
    href: `/session/${session.session_id}`,
    status: session.status,
  }));
}

function buildStudentAffiliation(currentClass: ClassInfo | null, unavailable: boolean) {
  if (unavailable) {
    return {
      title: '班级信息暂不可用',
      subtitle: '这不会影响你继续学习',
      detail: '可以稍后重试或直接前往班级页',
      href: '/my-class',
      actionLabel: '查看班级',
      empty: false,
      unavailable: true,
    };
  }

  if (!currentClass) {
    return {
      title: '还没有加入班级',
      subtitle: '班级不是开始学习的前置条件',
      detail: '有班级号时，可以随时加入',
      href: '/my-class',
      actionLabel: '加入班级',
      empty: true,
    };
  }

  return {
    title: currentClass.name,
    subtitle: currentClass.teacher_name ? `任课教师：${currentClass.teacher_name}` : '我的班级',
    detail: currentClass.student_count != null ? `${currentClass.student_count} 名同学` : undefined,
    href: '/my-class',
    actionLabel: '进入班级',
    empty: false,
  };
}

export async function loadStudentHomeData(): Promise<PersonalHomeData> {
  const [overviewResult, masteryResult, sessionsResult, classResult, dailyQuestionResult] = await Promise.allSettled([
    apiClient.get<StudentOverviewResponse>('/progress/overview').then((response) => response.data),
    apiClient.get<StudentMasteryResponse>('/progress/mastery').then((response) => response.data),
    sessionService.getSessions(4, 0, { withUserMessages: true }),
    classService.getMyClass(),
    dailyQuestionService.getToday(),
  ]);

  const overview = resultValue(overviewResult);
  const mastery = resultValue(masteryResult);
  const sessions = resultValue(sessionsResult);
  const currentClass = resultValue(classResult)?.class_info ?? null;
  const dailyQuestion = resultValue(dailyQuestionResult);
  const recentItems = buildStudentRecentItems(sessions);

  return {
    role: 'student',
    primaryHref: recentItems[0]?.status === 'active' ? recentItems[0].href : '/exercise',
    primaryLabel: recentItems[0]?.status === 'active' ? '继续学习' : '开始学习',
    primaryContext: recentItems[0]?.title
      ? `上次学到：${recentItems[0].title}`
      : '从智能练习或 AI 辅导开始今天的学习',
    stats: buildStudentStats(overview),
    actions: [buildDailyQuestionAction(dailyQuestion), ...buildStudentActions(mastery)],
    recentItems,
    affiliation: buildStudentAffiliation(currentClass, classResult.status === 'rejected'),
    failedSections: collectFailures([
      ['学习概览', overviewResult],
      ['掌握度', masteryResult],
      ['学习记录', sessionsResult],
      ['班级信息', classResult],
      ['每日一题', dailyQuestionResult],
    ]),
  };
}

function buildTeacherStats(
  dashboard: Awaited<ReturnType<typeof teacherService.getDashboardStats>> | null,
  analytics: Awaited<ReturnType<typeof teacherService.getAnalytics>> | null
): HomeStat[] {
  return [
    {
      key: 'students',
      label: '学生总数',
      value: dashboard ? `${Math.max(0, dashboard.total_students)}人` : '—',
      detail: '当前教学范围',
      tone: 'blue',
    },
    {
      key: 'active',
      label: '今日活跃',
      value: dashboard ? `${clampPercent(dashboard.active_today)}%` : '—',
      detail: '学生参与情况',
      tone: 'violet',
    },
    {
      key: 'completion',
      label: '平均完成率',
      value: analytics ? `${clampPercent(analytics.overview.avg_completion_rate)}%` : '—',
      detail: analytics ? `平均成绩 ${Math.round(analytics.overview.avg_score)}` : undefined,
      tone: 'emerald',
    },
    {
      key: 'grading',
      label: '待批改',
      value: dashboard ? `${Math.max(0, dashboard.pending_grading)}份` : '—',
      detail: '及时跟进学习反馈',
      tone: 'coral',
    },
  ];
}

function buildTeacherActions(
  analytics: Awaited<ReturnType<typeof teacherService.getAnalytics>> | null
): HomeActionItem[] {
  if (!analytics?.knowledge_points.length) return teacherFallbackActions;

  const tones: HomeActionItem['tone'][] = ['blue', 'violet', 'emerald'];
  return [...analytics.knowledge_points]
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, 3)
    .map((knowledgePoint, index) => ({
      id: knowledgePoint.concept_id || `${knowledgePoint.name}-${index}`,
      title: knowledgePoint.name,
      description: `${knowledgePoint.student_count} 名学生参与，建议优先关注`,
      href: '/teacher/dashboard',
      progress: clampPercent(knowledgePoint.mastery),
      meta: `平均掌握 ${clampPercent(knowledgePoint.mastery)}%`,
      tone: tones[index],
    }));
}

function buildTeacherRecentItems(classes: ClassInfo[]): HomeRecentItem[] {
  return classes.slice(0, 3).map((classInfo) => ({
    id: classInfo.id,
    title: classInfo.name,
    description: classInfo.student_count != null
      ? `${classInfo.student_count} 名学生 · 班级号 ${classInfo.code}`
      : `班级号 ${classInfo.code}`,
    timestamp: formatDateOrFallback(classInfo.created_at, 'M月d日', { fallback: '时间未知' }),
    href: `/teacher/class/${classInfo.id}`,
    status: 'neutral',
  }));
}

function buildTeacherAffiliation(classes: ClassInfo[], unavailable: boolean) {
  if (unavailable) {
    return {
      title: '教学班级暂不可用',
      subtitle: '其他教学入口仍可正常使用',
      detail: '可以稍后重试或直接前往班级管理',
      href: '/teacher/classes',
      actionLabel: '班级管理',
      empty: false,
      unavailable: true,
    };
  }

  if (classes.length === 0) {
    return {
      title: '还没有创建班级',
      subtitle: '创建班级后即可组织学生与学习数据',
      href: '/teacher/classes',
      actionLabel: '创建班级',
      empty: true,
    };
  }

  const totalStudents = classes.reduce((sum, classInfo) => sum + (classInfo.student_count ?? 0), 0);
  return {
    title: `${classes.length} 个教学班级`,
    subtitle: `当前共覆盖 ${totalStudents} 名学生`,
    detail: `最近创建：${classes[0].name}`,
    href: '/teacher/classes',
    actionLabel: '管理班级',
    empty: false,
  };
}

export async function loadTeacherHomeData(): Promise<PersonalHomeData> {
  const [dashboardResult, analyticsResult, classesResult] = await Promise.allSettled([
    teacherService.getDashboardStats(),
    teacherService.getAnalytics('week'),
    classService.listTeacherClasses(),
  ]);

  const dashboard = resultValue(dashboardResult);
  const analytics = resultValue(analyticsResult);
  const classes = resultValue(classesResult)?.items ?? [];

  return {
    role: 'teacher',
    primaryHref: '/teacher/dashboard',
    primaryLabel: '进入教学概览',
    primaryContext: classesResult.status === 'rejected'
      ? '班级信息暂时无法加载，仍可进入教学概览'
      : classes.length > 0
        ? `今天从 ${classes[0].name} 的学情开始`
        : '先创建班级，开始组织教学工作',
    stats: buildTeacherStats(dashboard, analytics),
    actions: buildTeacherActions(analytics),
    recentItems: buildTeacherRecentItems(classes),
    affiliation: buildTeacherAffiliation(classes, classesResult.status === 'rejected'),
    failedSections: collectFailures([
      ['教学概览', dashboardResult],
      ['学情分析', analyticsResult],
      ['班级信息', classesResult],
    ]),
  };
}
