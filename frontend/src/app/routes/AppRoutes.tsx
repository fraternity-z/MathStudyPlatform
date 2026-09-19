import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAppSelector } from '@/store';
import { AnimatePresence } from 'framer-motion';
import { selectIsAuthenticated, selectCurrentUser } from '@/modules/auth/store/authSlice';
import { ProtectedRoute } from '@/modules/auth/components/ProtectedRoute';
import { getHomePath } from '@/modules/auth/constants/homePath';
import { routes, notFoundRoute } from './index';

/**
 * 路由配置组件
 * 根据路由配置表动态生成路由，支持角色权限控制
 */
export const AppRoutes = () => {
  const location = useLocation();
  const isAuthenticated = useAppSelector(selectIsAuthenticated);
  const user = useAppSelector(selectCurrentUser);

  // 真正的登录状态：token 存在且 user 信息已加载
  const isLoggedIn = isAuthenticated && user !== null;

  return (
    <AnimatePresence mode="sync">
      <Routes location={location} key={location.pathname}>
        {/* 首页特殊处理：未登录显示欢迎页，已登录显示主页 */}
        <Route
          path="/"
          element={isLoggedIn && user ? <Navigate to={getHomePath(user.role)} replace /> : <Navigate to="/welcome" replace />}
        />

        {/* 动态生成路由 */}
        {routes.map((route) => {
          const Component = route.component;

          if (route.protected) {
            return (
              <Route
                key={route.path}
                path={route.path}
                element={
                  <ProtectedRoute requiredRole={route.requiredRole}>
                    <Component />
                  </ProtectedRoute>
                }
              />
            );
          }

          return (
            <Route
              key={route.path}
              path={route.path}
              element={<Component />}
            />
          );
        })}

        {/* 404 路由 */}
        <Route path={notFoundRoute.path} element={<notFoundRoute.component />} />
      </Routes>
    </AnimatePresence>
  );
};
