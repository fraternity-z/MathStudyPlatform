import { lazy } from 'react';
import { publicRoutes } from './publicRoutes';
import { studentRoutes } from './studentRoutes';
import { teacherRoutes } from './teacherRoutes';
import { adminRoutes } from './adminRoutes';

/**
 * 路由配置类型定义
 */
export interface RouteConfig {
  path: string;
  component: React.LazyExoticComponent<React.FC>;
  protected?: boolean;
  requiredRole?: 'student' | 'teacher' | 'admin';
}

/** 合并所有路由配置 */
export const routes: RouteConfig[] = [
  ...publicRoutes,
  ...studentRoutes,
  ...teacherRoutes,
  ...adminRoutes,
];

// 404 页面
const NotFoundPage = lazy(() =>
  import('@/pages/NotFoundPage').then(m => ({ default: m.NotFoundPage }))
);

export const notFoundRoute: RouteConfig = {
  path: '*',
  component: NotFoundPage,
  protected: false,
};
