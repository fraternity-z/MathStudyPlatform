import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAppSelector } from '@/store';
import { selectCurrentUser } from '@/modules/auth/store/authSlice';
import { useAuth } from '@/modules/auth/hooks/useAuth';
import { animationCombos } from '@/libs/animations';
import { Button } from '@/components/ui/Button';
import {
  Shield,
  LayoutDashboard,
  Users,
  Brain,
  Settings,
  LogOut,
  Loader2,
  Menu,
  X,
  ChevronRight,
  Network,
  Inbox,
  ShieldAlert,
  Megaphone,
  MessagesSquare,
} from 'lucide-react';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { passwordResetService } from '@/modules/password-reset/services/passwordResetService';
import { useSerialPolling } from '@/hooks/useSerialPolling';

interface AdminLayoutProps {
  children: React.ReactNode;
  className?: string;
}

const desktopSidebarBreakpoint = 768;

function isDesktopViewport(): boolean {
  return typeof window === 'undefined' || window.innerWidth >= desktopSidebarBreakpoint;
}

export const AdminLayout: React.FC<AdminLayoutProps> = ({ children, className = '' }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAppSelector(selectCurrentUser);
  const { handleLogout, isLoggingOut } = useAuth('/admin');
  const [sidebarOpen, setSidebarOpen] = useState(isDesktopViewport);
  const [desktopViewport, setDesktopViewport] = useState(isDesktopViewport);
  const desktopViewportRef = useRef(desktopViewport);
  const [inboxPendingCount, setInboxPendingCount] = useState(0);

  const fetchPendingCount = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await passwordResetService.getPendingCount(signal);
      if (!signal.aborted) {
        setInboxPendingCount(res.pending_count);
      }
    } catch {
      // 静默处理
    }
  }, []);
  useSerialPolling(fetchPendingCount, 60_000);

  useEffect(() => {
    const handleResize = () => {
      const desktop = isDesktopViewport();
      if (desktop !== desktopViewportRef.current) {
        desktopViewportRef.current = desktop;
        setDesktopViewport(desktop);
        setSidebarOpen(desktop);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const navigateFromSidebar = useCallback((path: string) => {
    navigate(path);
    if (!isDesktopViewport()) {
      setSidebarOpen(false);
    }
  }, [navigate]);

  const menuItems = [
    {
      icon: LayoutDashboard,
      label: '运维控制台',
      path: '/admin/dashboard',
    },
    {
      icon: Inbox,
      label: '信箱',
      path: '/admin/inbox',
      badge: inboxPendingCount,
    },
    {
      icon: Users,
      label: '账户管理',
      path: '/admin/accounts',
    },
    {
      icon: MessagesSquare,
      label: '论坛管理',
      path: '/admin/forum',
    },
    {
      icon: Brain,
      label: 'AI 模型',
      path: '/admin/ai-models',
    },
    {
      icon: ShieldAlert,
      label: '风控中心',
      path: '/admin/risk-control',
    },
    {
      icon: Network,
      label: '知识点管理',
      path: '/admin/knowledge',
    },
    {
      icon: Megaphone,
      label: '系统公告',
      path: '/admin/announcements',
    },
    {
      icon: Settings,
      label: '系统设置',
      path: '/admin/settings',
    },
  ];

  const activeMenuItem = menuItems.find((item) => item.path === location.pathname);
  const mobileSidebarHidden = !desktopViewport && !sidebarOpen;

  return (
    <div className={`min-h-screen bg-surface-50 dark:bg-surface-950 flex ${animationCombos.pageEnter} ${className}`}>
      {sidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-surface-950/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-label="关闭管理导航"
        />
      )}
      {/* 侧边栏 */}
      <aside
        aria-hidden={mobileSidebarHidden}
        inert={mobileSidebarHidden ? true : undefined}
        className={`fixed left-0 top-0 z-40 h-full w-64 border-r border-surface-200 bg-white transition-all duration-300 dark:border-surface-800 dark:bg-surface-900 md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0 md:w-64' : '-translate-x-full md:w-20'
        }`}
      >
        {/* Logo 区域 */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-surface-200 dark:border-surface-800">
          {sidebarOpen ? (
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-primary-600 dark:bg-primary-500 rounded-lg flex items-center justify-center">
                <Shield className="w-5 h-5 text-white" />
              </div>
              <div>
                <div className="text-sm font-bold text-surface-900 dark:text-surface-100">管理后台</div>
                <div className="text-xs text-surface-500 dark:text-surface-400">Admin Panel</div>
              </div>
            </div>
          ) : (
            <div className="w-8 h-8 bg-primary-600 dark:bg-primary-500 rounded-lg flex items-center justify-center mx-auto">
              <Shield className="w-5 h-5 text-white" />
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className={`h-8 w-8 ${!sidebarOpen && 'mx-auto mt-2'}`}
            aria-label={sidebarOpen ? '收起管理导航' : '展开管理导航'}
            title={sidebarOpen ? '收起管理导航' : '展开管理导航'}
          >
            {sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </Button>
        </div>

        {/* 导航菜单 */}
        <nav className="p-4 space-y-2">
          {menuItems.map((item, index) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path;
            return (
              <button
                key={index}
                onClick={() => navigateFromSidebar(item.path)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors relative ${
                  isActive
                    ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400'
                    : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800'
                }`}
              >
                <Icon className="w-5 h-5 shrink-0" />
                {sidebarOpen && (
                  <>
                    <span className="flex-1 text-sm font-medium text-left">{item.label}</span>
                    {'badge' in item && typeof item.badge === 'number' && item.badge > 0 && (
                      <span className="min-w-5 h-5 px-1.5 flex items-center justify-center bg-red-500 text-white text-xs font-bold rounded-full">
                        {item.badge > 99 ? '99+' : item.badge}
                      </span>
                    )}
                    {isActive && !('badge' in item && typeof item.badge === 'number' && item.badge > 0) && (
                      <ChevronRight className="w-4 h-4" />
                    )}
                  </>
                )}
                {!sidebarOpen && 'badge' in item && typeof item.badge === 'number' && item.badge > 0 && (
                  <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full" />
                )}
              </button>
            );
          })}
        </nav>

        {/* 底部用户信息 */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-surface-200 dark:border-surface-800">
          {sidebarOpen ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 px-3 py-2">
                <div className="w-8 h-8 bg-primary-100 dark:bg-primary-900/30 rounded-full flex items-center justify-center">
                  <span className="text-sm font-medium text-primary-600 dark:text-primary-400">
                    {user?.name?.charAt(0).toUpperCase() || 'A'}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">
                    {user?.name || '管理员'}
                  </div>
                  <div className="text-xs text-surface-500 dark:text-surface-400 truncate">
                    {user?.email || '未设置邮箱'}
                  </div>
                </div>
              </div>
              <Button variant="outline" size="sm" className="w-full" onClick={handleLogout} disabled={isLoggingOut}>
                {isLoggingOut ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <LogOut className="w-4 h-4 mr-2" />
                )}
                {isLoggingOut ? '退出中...' : '退出登录'}
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="w-full"
              onClick={handleLogout}
              disabled={isLoggingOut}
              aria-label="退出登录"
              title="退出登录"
            >
              {isLoggingOut ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LogOut className="w-4 h-4" />
              )}
            </Button>
          )}
        </div>
      </aside>

      {/* 主内容区域 */}
      <div
        className={`min-w-0 flex-1 transition-all duration-300 ${
          sidebarOpen ? 'md:ml-64' : 'md:ml-20'
        }`}
      >
        {/* 顶部栏 */}
        <header className="flex h-16 items-center justify-between border-b border-surface-200 bg-white px-4 dark:border-surface-800 dark:bg-surface-900 sm:px-6">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 md:hidden"
              onClick={() => setSidebarOpen(true)}
              aria-label="打开管理导航"
              title="打开管理导航"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-100">
              {activeMenuItem?.label ?? '管理后台'}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle variant="ghost" />
          </div>
        </header>

        {/* 页面内容 */}
        <main className="p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
};
