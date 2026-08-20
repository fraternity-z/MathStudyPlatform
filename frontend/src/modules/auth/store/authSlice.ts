import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import type { LoadingState } from '@/types';
import { createFieldSelector } from '@/store/utils/sliceFactory';
import { authService } from '@/modules/auth/services/authService';
import { authTokenStorage } from '@/libs/auth/tokenStorage';
import { isRequestCancelled, toAppError, type AppError } from '@/libs/http/appError';

/**
 * 认证状态
 */
export interface AuthState {
  token: string | null;
  user: {
    id: string;
    name: string;
    email?: string;
    role: 'student' | 'teacher' | 'admin';
    avatar?: string;
  } | null;
  isAuthenticated: boolean;
  loadingState: LoadingState;
  error: AppError | null;
  currentUserRequestId: string | null;
}

type AuthUser = NonNullable<AuthState['user']>;

const USER_CACHE_KEY = 'auth_user_cache';
const VALID_ROLES: AuthUser['role'][] = ['student', 'teacher', 'admin'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthRole(value: unknown): value is AuthUser['role'] {
  return typeof value === 'string' && VALID_ROLES.includes(value as AuthUser['role']);
}

function normalizeCachedUser(value: unknown): AuthState['user'] {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.trim() === '') return null;
  if (typeof value.name !== 'string' || value.name.trim() === '') return null;
  if (!isAuthRole(value.role)) return null;

  const user: AuthUser = {
    id: value.id,
    name: value.name,
    role: value.role,
  };
  if (typeof value.email === 'string') {
    user.email = value.email;
  }
  if (typeof value.avatar === 'string') {
    user.avatar = value.avatar;
  }
  return user;
}

function clearUserCache(): void {
  try {
    localStorage.removeItem(USER_CACHE_KEY);
  } catch {
    // 存储不可用时忽略
  }
}

function loadUserFromCache(): AuthState['user'] {
  try {
    const cached = localStorage.getItem(USER_CACHE_KEY);
    if (!cached) return null;
    const user = normalizeCachedUser(JSON.parse(cached));
    if (!user) {
      clearUserCache();
    }
    return user;
  } catch {
    clearUserCache();
    return null;
  }
}

function saveUserToCache(user: AuthState['user']): void {
  try {
    const normalizedUser = normalizeCachedUser(user);
    if (normalizedUser) {
      localStorage.setItem(USER_CACHE_KEY, JSON.stringify(normalizedUser));
    } else {
      clearUserCache();
    }
  } catch {
    // 存储失败时静默处理
  }
}

const cachedUser = loadUserFromCache();
const token = authTokenStorage.get();

const initialState: AuthState = {
  token,
  // 有 token 且有缓存用户时直接恢复，避免首次加载阻塞
  user: token ? cachedUser : null,
  isAuthenticated: !!token,
  loadingState: 'idle',
  error: null,
  currentUserRequestId: null,
};

// 异步 thunk：获取当前用户信息
export const fetchCurrentUser = createAsyncThunk<AuthUser, void, { rejectValue: AppError }>(
  'auth/fetchCurrentUser',
  async (_, { rejectWithValue, signal }) => {
    try {
      const userInfo = await authService.getCurrentUser(signal);
      return {
        id: userInfo.id,
        name: userInfo.username,
        email: userInfo.email,
        role: userInfo.role,
      };
    } catch (error) {
      return rejectWithValue(toAppError(error, '获取用户信息失败'));
    }
  }
);

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    // 设置凭证
    setCredentials(
      state,
      action: PayloadAction<{
        token: string;
        user: AuthState['user'];
      }>
    ) {
      const { token, user } = action.payload;
      state.token = token;
      state.user = user;
      state.isAuthenticated = true;
      state.loadingState = 'success';
      state.error = null;
      state.currentUserRequestId = null;
      authTokenStorage.set(token);
      saveUserToCache(user);
    },

    // 登出
    logout(state) {
      state.token = null;
      state.user = null;
      state.isAuthenticated = false;
      state.loadingState = 'idle';
      state.error = null;
      state.currentUserRequestId = null;
      authTokenStorage.clear();
      saveUserToCache(null);
    },

    // 更新用户信息
    updateUser(state, action: PayloadAction<Partial<AuthState['user']>>) {
      if (state.user) {
        state.user = {
          ...state.user,
          ...action.payload,
        };
      }
    },

    // 设置加载状态
    setLoadingState(state, action: PayloadAction<LoadingState>) {
      state.loadingState = action.payload;
      if (action.payload === 'loading') {
        state.error = null;
      }
    },

    // 设置错误信息
    setError(state, action: PayloadAction<AppError>) {
      state.error = action.payload;
      state.loadingState = 'error';
    },

    // 清除错误
    clearError(state) {
      state.error = null;
    },

    // 刷新 token
    refreshToken(state, action: PayloadAction<string>) {
      state.token = action.payload;
      state.isAuthenticated = true;
      authTokenStorage.set(action.payload);
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchCurrentUser.pending, (state, action) => {
        state.loadingState = 'loading';
        state.currentUserRequestId = action.meta.requestId;
      })
      .addCase(fetchCurrentUser.fulfilled, (state, action) => {
        if (state.currentUserRequestId !== action.meta.requestId || !state.token) return;

        state.user = action.payload;
        state.isAuthenticated = true;
        state.loadingState = 'success';
        state.error = null;
        state.currentUserRequestId = null;
        saveUserToCache(action.payload);
      })
      .addCase(fetchCurrentUser.rejected, (state, action) => {
        if (state.currentUserRequestId !== action.meta.requestId) return;

        state.currentUserRequestId = null;
        const requestError = action.payload ?? toAppError(action.error, '获取用户信息失败');
        if (action.meta.aborted || isRequestCancelled(requestError)) {
          state.loadingState = state.user ? 'success' : 'idle';
          state.error = null;
          return;
        }

        if (requestError.kind === 'unauthenticated') {
          state.token = null;
          state.user = null;
          state.isAuthenticated = false;
          state.loadingState = 'error';
          state.error = null;
          authTokenStorage.clear();
          saveUserToCache(null);
          return;
        }

        state.loadingState = 'error';
        state.error = requestError;
      });
  },
});

export const {
  setCredentials,
  logout,
  updateUser,
  setLoadingState,
  setError,
  clearError,
  refreshToken,
} = authSlice.actions;

// ============ Selectors ============
// 使用工厂函数生成字段 selectors
export const selectCurrentUser = createFieldSelector<AuthState, 'auth', 'user'>('auth', 'user');
export const selectIsAuthenticated = createFieldSelector<AuthState, 'auth', 'isAuthenticated'>('auth', 'isAuthenticated');
export const selectAuthToken = createFieldSelector<AuthState, 'auth', 'token'>('auth', 'token');
export const selectAuthLoadingState = createFieldSelector<AuthState, 'auth', 'loadingState'>('auth', 'loadingState');
export const selectAuthError = createFieldSelector<AuthState, 'auth', 'error'>('auth', 'error');

// 派生 selector
export const selectIsAuthLoading = (state: { auth: AuthState }) =>
  state.auth.loadingState === 'loading';

export default authSlice.reducer;
