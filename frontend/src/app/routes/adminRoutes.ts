import { lazy } from 'react';
import type { RouteConfig } from './index';

// 管理员页面懒加载
const AdminLoginPage = lazy(() => import('@/pages/admin/AdminLoginPage').then(m => ({ default: m.AdminLoginPage })));
const AdminDashboardPage = lazy(() => import('@/pages/admin/AdminDashboardPage').then(m => ({ default: m.AdminDashboardPage })));
const AccountManagementPage = lazy(() => import('@/pages/admin/AccountManagementPage').then(m => ({ default: m.AccountManagementPage })));
const AIModelSettingsPage = lazy(() => import('@/pages/admin/AIModelSettingsPage').then(m => ({ default: m.AIModelSettingsPage })));
const SystemSettingsPage = lazy(() => import('@/pages/admin/SystemSettingsPage').then(m => ({ default: m.SystemSettingsPage })));
const KnowledgeManagementPage = lazy(() => import('@/pages/admin/KnowledgeManagementPage').then(m => ({ default: m.KnowledgeManagementPage })));
const InboxPage = lazy(() => import('@/pages/admin/InboxPage').then(m => ({ default: m.InboxPage })));
const AIRiskControlPage = lazy(() => import('@/pages/admin/AIRiskControlPage').then(m => ({ default: m.AIRiskControlPage })));
const AnnouncementManagementPage = lazy(() => import('@/pages/admin/AnnouncementManagementPage').then(m => ({ default: m.AnnouncementManagementPage })));
const ForumManagementPage = lazy(() => import('@/pages/admin/ForumManagementPage').then(m => ({ default: m.ForumManagementPage })));

/**
 * 管理员路由 - 登录页公开，其余页面要求 admin 角色
 */
export const adminRoutes: RouteConfig[] = [
  { path: '/admin', component: AdminLoginPage, protected: false },
  { path: '/admin/dashboard', component: AdminDashboardPage, protected: true, requiredRole: 'admin' },
  { path: '/admin/inbox', component: InboxPage, protected: true, requiredRole: 'admin' },
  { path: '/admin/accounts', component: AccountManagementPage, protected: true, requiredRole: 'admin' },
  { path: '/admin/forum', component: ForumManagementPage, protected: true, requiredRole: 'admin' },
  { path: '/admin/ai-models', component: AIModelSettingsPage, protected: true, requiredRole: 'admin' },
  { path: '/admin/risk-control', component: AIRiskControlPage, protected: true, requiredRole: 'admin' },
  { path: '/admin/announcements', component: AnnouncementManagementPage, protected: true, requiredRole: 'admin' },
  { path: '/admin/settings', component: SystemSettingsPage, protected: true, requiredRole: 'admin' },
  { path: '/admin/knowledge', component: KnowledgeManagementPage, protected: true, requiredRole: 'admin' },
];
