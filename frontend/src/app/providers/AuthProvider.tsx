import { useEffect, useRef } from 'react';
import { useAppSelector, useAppDispatch } from '@/store';
import { selectIsAuthenticated, selectCurrentUser, selectAuthError, selectAuthLoadingState, fetchCurrentUser, logout, refreshToken } from '@/modules/auth/store/authSlice';
import { subscribeAuthExpired } from '@/libs/auth/authEvents';
import { getCsrfToken } from '@/libs/auth/csrfToken';
import { refreshAccessToken } from '@/libs/http/tokenRefresh';
import LoadingFallback from '@/components/LoadingFallback';
import { RequestErrorNotice } from '@/components/feedback';

/**
 * 认证初始化组件
 * 在应用启动时检查 token 并恢复用户信息
 * 优化：有缓存用户时直接渲染，后台静默刷新用户信息
 */
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  const isAuthenticated = useAppSelector(selectIsAuthenticated);
  const user = useAppSelector(selectCurrentUser);
  const loadingState = useAppSelector(selectAuthLoadingState);
  const authError = useAppSelector(selectAuthError);
  const fetchStarted = useRef(false);
  const sessionRestoreStarted = useRef(false);
  const sessionRestoreCancelled = useRef(false);
  const initialAuthenticationState = useRef(isAuthenticated);

  useEffect(() => {
    // StrictMode replays this effect; the second setup re-enables the active mount.
    sessionRestoreCancelled.current = false;
    return () => {
      sessionRestoreCancelled.current = true;
    };
  }, []);

  useEffect(() => {
    // 会话恢复只属于应用初始化。主动退出后的未认证状态不能再次触发 refresh。
    if (!sessionRestoreStarted.current) {
      sessionRestoreStarted.current = true;
      // CSRF Cookie 与 HttpOnly refresh Cookie 同时签发和过期，可作为恢复会话的前置判断。
      if (isAuthenticated || !getCsrfToken()) return;

      void refreshAccessToken().then((token) => {
        if (token && !sessionRestoreCancelled.current) {
          dispatch(refreshToken(token));
        }
      });
      return;
    }

    // 初始化恢复进行期间若认证状态已被登录/退出操作改变，忽略迟到的恢复结果。
    if (isAuthenticated !== initialAuthenticationState.current) {
      sessionRestoreCancelled.current = true;
    }
  }, [dispatch, isAuthenticated]);

  useEffect(() => {
    // 有 token 时始终后台刷新用户信息（无论是否有缓存）
    // 有缓存时不阻塞渲染，静默更新；无缓存时会触发 LoadingFallback
    if (isAuthenticated && !fetchStarted.current) {
      fetchStarted.current = true;
      dispatch(fetchCurrentUser());
    }
  }, [dispatch, isAuthenticated]);

  useEffect(() => {
    const unsubscribe = subscribeAuthExpired(() => {
      dispatch(logout());
    });

    return unsubscribe;
  }, [dispatch]);

  // 有 token 但没有用户信息（无缓存），且正在加载或即将加载，显示加载状态
  if (isAuthenticated && !user && loadingState !== 'error') {
    return <LoadingFallback />;
  }

  if (isAuthenticated && !user && authError) {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <RequestErrorNotice
          error={authError}
          onRetry={() => void dispatch(fetchCurrentUser())}
          onRefresh={() => void dispatch(fetchCurrentUser())}
          className="w-full max-w-lg"
        />
      </main>
    );
  }

  return <>{children}</>;
};
