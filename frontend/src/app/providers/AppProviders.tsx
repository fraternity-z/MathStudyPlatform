import { Suspense, useEffect } from 'react';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import { store } from '@/store';
import { ToastProvider } from '@/components/ui/Toast';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { clearLegacyXidianStorage } from '@/modules/xidian';
import ScrollToTop from '@/components/ScrollToTop';
import LoadingFallback from '@/components/LoadingFallback';
import { ThemeProvider } from './ThemeProvider';
import { AuthProvider } from './AuthProvider';
import { useRateLimitToast } from '@/hooks/useRateLimitToast';
import { SystemAnnouncementDialog } from '@/modules/announcement/SystemAnnouncementDialog';
import { AIPracticeProvider } from '@/modules/exercise/components/AIPracticeProvider';

/** 全局事件监听桥接（需要在 ToastProvider 内部） */
const GlobalEventListeners: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useRateLimitToast();
  useEffect(() => {
    clearLegacyXidianStorage();
  }, []);
  return <>{children}</>;
};

/**
 * 应用级 Provider 组合组件
 * 统一管理所有全局 Provider 的嵌套顺序
 *
 * 嵌套顺序（从外到内）：
 * ErrorBoundary → Redux Provider → Theme → Toast → Router → Auth
 */
export const AppProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <ErrorBoundary>
      <Provider store={store}>
        <ThemeProvider>
          <ToastProvider>
            <BrowserRouter>
              <GlobalEventListeners>
                <AuthProvider>
                  <ScrollToTop />
                  <SystemAnnouncementDialog />
                  <AIPracticeProvider>
                    <Suspense fallback={<LoadingFallback />}>
                      {children}
                    </Suspense>
                  </AIPracticeProvider>
                </AuthProvider>
              </GlobalEventListeners>
            </BrowserRouter>
          </ToastProvider>
        </ThemeProvider>
      </Provider>
    </ErrorBoundary>
  );
};
