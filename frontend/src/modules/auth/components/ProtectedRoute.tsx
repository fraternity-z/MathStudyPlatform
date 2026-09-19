import { Navigate } from 'react-router-dom';
import { useAppSelector } from '@/store';
import { selectIsAuthenticated, selectCurrentUser } from '@/modules/auth/store/authSlice';
import { getHomePath } from '@/modules/auth/constants/homePath';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: 'student' | 'teacher' | 'admin';
}

/**
 * 路由守卫组件
 *
 * 功能：
 * - 检查用户是否已登录（token 存在且 user 信息已加载）
 * - 检查用户角色是否匹配（可选）
 * - 未登录时重定向到对应登录入口，角色不匹配时返回本人首页
 *
 * 使用示例：
 * ```tsx
 * <Route path="/exercise" element={<ProtectedRoute><ExercisePage /></ProtectedRoute>} />
 * <Route path="/teacher/dashboard" element={<ProtectedRoute requiredRole="teacher"><TeacherDashboardPage /></ProtectedRoute>} />
 * ```
 */
export function ProtectedRoute({ children, requiredRole }: ProtectedRouteProps): React.ReactNode {
  const isAuthenticated = useAppSelector(selectIsAuthenticated);
  const user = useAppSelector(selectCurrentUser);

  // 未登录（token 不存在或 user 信息未加载），重定向到登录页
  // 注意：仅有 token 但 user 为 null 说明 token 可能已失效或未完成登录流程
  if (!isAuthenticated || !user) {
    // 管理员路由重定向到管理员登录页
    if (requiredRole === 'admin') {
      return <Navigate to="/admin" replace />;
    }
    return <Navigate to="/welcome" replace />;
  }

  // 需要特定角色但用户角色不匹配，重定向到对应首页
  if (requiredRole && user.role !== requiredRole) {
    return <Navigate to={getHomePath(user.role)} replace />;
  }

  return children;
}
