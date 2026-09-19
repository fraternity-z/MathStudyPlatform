import { lazy } from 'react';
import type { RouteConfig } from './index';

// 学生页面懒加载
const ExercisePage = lazy(() => import('@/pages/student/ExercisePage').then(m => ({ default: m.ExercisePage })));
const DailyQuestionPage = lazy(() => import('@/pages/student/DailyQuestionPage').then(m => ({ default: m.DailyQuestionPage })));
const SessionChatPage = lazy(() => import('@/pages/student/SessionChatPage').then(m => ({ default: m.default })));
const MistakeBookPage = lazy(() => import('@/pages/student/MistakeBookPage').then(m => ({ default: m.MistakeBookPage })));
const MistakeRedoPage = lazy(() => import('@/pages/student/MistakeRedoPage').then(m => ({ default: m.MistakeRedoPage })));
const KnowledgeGraphPage = lazy(() => import('@/pages/student/KnowledgeGraphPage').then(m => ({ default: m.KnowledgeGraphPage })));
const LearningPathPage = lazy(() => import('@/pages/student/LearningPathPage').then(m => ({ default: m.LearningPathPage })));
const DiagnosisReportPage = lazy(() => import('@/pages/student/DiagnosisReportPage').then(m => ({ default: m.DiagnosisReportPage })));
const AnalyticsPage = lazy(() => import('@/pages/student/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));
const ResourcesPage = lazy(() => import('@/pages/student/ResourcesPage').then(m => ({ default: m.ResourcesPage })));
const MyClassPage = lazy(() => import('@/pages/student/MyClassPage').then(m => ({ default: m.MyClassPage })));
const MessageCenterPage = lazy(() => import('@/pages/student/MessageCenterPage').then(m => ({ default: m.MessageCenterPage })));

/**
 * 学生路由 - 需要登录 + student 角色
 */
export const studentRoutes: RouteConfig[] = [
  { path: '/my-class', component: MyClassPage, protected: true, requiredRole: 'student' },
  { path: '/exercise', component: ExercisePage, protected: true, requiredRole: 'student' },
  { path: '/daily-question', component: DailyQuestionPage, protected: true, requiredRole: 'student' },
  { path: '/session/new', component: SessionChatPage, protected: true, requiredRole: 'student' },
  { path: '/session/:sessionId', component: SessionChatPage, protected: true, requiredRole: 'student' },
  { path: '/messages', component: MessageCenterPage, protected: true, requiredRole: 'student' },
  { path: '/mistake-book', component: MistakeBookPage, protected: true, requiredRole: 'student' },
  { path: '/mistake-book/:attemptId/redo', component: MistakeRedoPage, protected: true, requiredRole: 'student' },
  { path: '/knowledge-graph', component: KnowledgeGraphPage, protected: true, requiredRole: 'student' },
  { path: '/learning-path', component: LearningPathPage, protected: true, requiredRole: 'student' },
  { path: '/diagnosis/:id', component: DiagnosisReportPage, protected: true, requiredRole: 'student' },
  { path: '/analytics', component: AnalyticsPage, protected: true, requiredRole: 'student' },
  { path: '/resources', component: ResourcesPage, protected: true, requiredRole: 'student' },
];
