import React from 'react';
import { Link } from 'react-router-dom';
import { useAppSelector } from '@/store';
import { Button } from '@/components/ui/Button';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { cn } from '@/libs/utils/cn';
import { Loader2, LogOut, User, Users } from 'lucide-react';
import { selectIsAuthenticated, selectCurrentUser } from '@/modules/auth/store/authSlice';
import { getNavItemsByRole } from '@/modules/auth/constants/navigationConfig';
import { getHomePath } from '@/modules/auth/constants/homePath';
import { useAuth } from '@/modules/auth/hooks/useAuth';
import { animationCombos } from '@/libs/animations';
import { ResponsiveNavigation } from '@/modules/auth/components/ResponsiveNavigation';
import { MessagePreviewBell } from '@/modules/message-center/components/MessagePreviewBell';

interface HeaderProps {
  variant?: 'default' | 'transparent' | 'dark';
  onLoginClick?: () => void;
  onRegisterClick?: () => void;
}

/**
 * Header - 应用头部组件
 *
 * 设计原则：
 * - 单一职责: 只负责展示头部 UI，业务逻辑通过 hooks 获取
 * - DRY: 导航配置和认证逻辑已提取到独立模块
 * - SOLID: 依赖抽象（hooks），而非具体实现
 */
export const Header: React.FC<HeaderProps> = ({ variant = 'default', onLoginClick, onRegisterClick }) => {
  const isAuthenticated = useAppSelector(selectIsAuthenticated);
  const user = useAppSelector(selectCurrentUser);
  const { handleLogin, handleRegister, handleLogout, isLoggingOut } = useAuth();
  const [isUserMenuOpen, setIsUserMenuOpen] = React.useState(false);
  const userMenuRootRef = React.useRef<HTMLDivElement | null>(null);
  const userMenuTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const userMenuId = React.useId();

  // 真正的登录状态：token 存在且 user 信息已加载
  const isLoggedIn = isAuthenticated && user !== null;

  // 获取导航菜单配置
  const navItems = getNavItemsByRole(user?.role);
  const isTeacher = user?.role === 'teacher';
  const homePath = getHomePath(user?.role);

  const isDark = variant === 'dark' || variant === 'transparent';

  React.useEffect(() => {
    if (!isUserMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!userMenuRootRef.current?.contains(event.target as Node)) setIsUserMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsUserMenuOpen(false);
      userMenuTriggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isUserMenuOpen]);

  return (
    <header className={cn(
      "top-0 z-50 w-full border-b",
      animationCombos.buttonHover,
      variant === 'default' && "sticky border-surface-200/60 bg-white/80 backdrop-blur-md supports-backdrop-filter:bg-white/60 dark:border-surface-700/60 dark:bg-surface-900/80 dark:supports-backdrop-filter:bg-surface-900/60",
      variant === 'transparent' && "fixed border-transparent bg-transparent backdrop-blur-sm",
      variant === 'dark' && "sticky border-surface-800 bg-surface-950/80 backdrop-blur-md"
    )}>
      <div className="container mx-auto flex h-16 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        {/* Logo */}
        <Link to={isLoggedIn ? homePath : '/'} className="group flex shrink-0 items-center space-x-2">
          <div className={cn(
            "h-8 w-8 rounded-lg flex items-center justify-center text-white shadow-lg",
            animationCombos.buttonHover,
            isTeacher
              ? "bg-linear-to-br from-emerald-500 to-teal-600 group-hover:shadow-emerald-500/30"
              : "bg-linear-to-br from-primary-500 to-secondary-600 group-hover:shadow-primary-500/30"
          )}>
            <span className="font-bold text-lg">M</span>
          </div>
          <span className={cn(
            "hidden whitespace-nowrap font-bold text-xl bg-clip-text text-transparent bg-linear-to-r sm:inline",
            isDark ? "from-white to-surface-400" : "from-surface-900 to-surface-600 dark:from-white dark:to-surface-400"
          )}>
            高数智学
          </span>
          {/* 角色标识 */}
          {isLoggedIn && (
            <span className={cn(
              "ml-1 hidden shrink-0 whitespace-nowrap px-2 py-0.5 text-xs font-medium rounded-full xl:inline-flex",
              isTeacher
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400"
                : "bg-primary-100 text-primary-700 dark:bg-primary-900/50 dark:text-primary-400"
            )}>
              {isTeacher ? '教师端' : '学生端'}
            </span>
          )}
        </Link>

        {/* Main navigation - only show when authenticated */}
        {isLoggedIn && (
          <ResponsiveNavigation items={navItems} isTeacher={isTeacher} />
        )}

        {/* User Actions */}
        <div className="flex shrink-0 items-center space-x-3">
          {/* 主题切换按钮 */}
          <ThemeToggle variant="ghost" />

          {isLoggedIn ? (
            <div className="flex items-center space-x-3">
              {(user?.role === 'student' || user?.role === 'teacher') && (
                <MessagePreviewBell cacheKey={user.id} isTeacher={isTeacher} />
              )}
              <span className={cn("hidden sm:inline-block text-sm font-medium", isDark ? "text-surface-300" : "text-surface-700 dark:text-surface-300")}>
                你好，{user?.name || (isTeacher ? '老师' : '同学')}
              </span>
              <div ref={userMenuRootRef} className="relative shrink-0">
                <button
                  ref={userMenuTriggerRef}
                  type="button"
                  onClick={() => setIsUserMenuOpen((open) => !open)}
                  aria-label="用户菜单"
                  aria-haspopup="menu"
                  aria-controls={isUserMenuOpen ? userMenuId : undefined}
                  aria-expanded={isUserMenuOpen}
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-full border text-sm font-bold shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
                    isTeacher
                      ? "border-white bg-linear-to-tr from-emerald-100 to-teal-100 text-emerald-700 hover:ring-2 hover:ring-emerald-200 dark:border-surface-700 dark:from-emerald-900 dark:to-teal-900 dark:text-emerald-300 dark:hover:ring-emerald-700"
                      : "border-white bg-linear-to-tr from-primary-100 to-secondary-100 text-primary-700 hover:ring-2 hover:ring-primary-200 dark:border-surface-700 dark:from-primary-900 dark:to-secondary-900 dark:text-primary-300 dark:hover:ring-primary-700"
                  )}
                >
                  <User className="h-5 w-5" />
                </button>
                {isUserMenuOpen && (
                  <div
                    id={userMenuId}
                    role="menu"
                    aria-label="用户菜单"
                    className="absolute right-0 top-full z-50 mt-2 w-36 origin-top-right rounded-lg border border-surface-100 bg-white py-2 shadow-lg dark:border-surface-700 dark:bg-surface-800"
                  >
                  {user?.role === 'student' && (
                    <Link
                      to="/my-class"
                      role="menuitem"
                      onClick={() => setIsUserMenuOpen(false)}
                      className="w-full px-4 py-2 text-left text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-700 flex items-center"
                    >
                      <Users className="w-4 h-4 mr-2" />
                      我的班级
                    </Link>
                  )}
                  <Link
                    to={isTeacher ? "/teacher/profile" : "/profile"}
                    role="menuitem"
                    onClick={() => setIsUserMenuOpen(false)}
                    className="w-full px-4 py-2 text-left text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-700 flex items-center"
                  >
                    <User className="w-4 h-4 mr-2" />
                    个人中心
                  </Link>
                  <button
                    onClick={() => {
                      setIsUserMenuOpen(false);
                      void handleLogout();
                    }}
                    type="button"
                    role="menuitem"
                    disabled={isLoggingOut}
                    className="w-full px-4 py-2 text-left text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-700 flex items-center"
                  >
                    {isLoggingOut ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <LogOut className="w-4 h-4 mr-2" />
                    )}
                    {isLoggingOut ? '退出中...' : '退出登录'}
                  </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center space-x-2">
              <Button variant="ghost" size="sm" onClick={() => handleLogin(onLoginClick)} className={cn(isDark && "text-surface-300 hover:bg-white/10 hover:text-white")}>登录</Button>
              <Button variant="primary" size="sm" onClick={() => handleRegister(onRegisterClick, onLoginClick)}>注册</Button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
