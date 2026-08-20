/**
 * 管理员统计 Redux Slice
 *
 * 管理管理员控制台的统计数据状态
 */

import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import type { LoadingState } from '@/types/common';
import type {
  OverviewStats,
  UserGrowthResponse,
  ActivityItem,
  SystemStatusResponse,
  UserGrowthPeriod,
} from '@/modules/admin/types/adminStats';
import { adminStatsService } from '@/modules/admin/services/adminStatsService';
import { toAppError, type AppError } from '@/libs/http/apiClient';

// =============================================================================
// State 类型定义
// =============================================================================

interface AdminStatsState {
  // 概览统计
  overview: OverviewStats | null;
  overviewLoading: LoadingState;
  overviewError: AppError | null;

  // 用户增长
  userGrowth: UserGrowthResponse | null;
  userGrowthLoading: LoadingState;
  userGrowthError: AppError | null;
  userGrowthPeriod: UserGrowthPeriod;
  userGrowthRequestId: string | null;

  // 最近活动
  recentActivities: ActivityItem[];
  activitiesLoading: LoadingState;
  activitiesError: AppError | null;

  // 系统状态
  systemStatus: SystemStatusResponse | null;
  systemStatusLoading: LoadingState;
  systemStatusError: AppError | null;
  trafficResetLoading: LoadingState;
  trafficResetError: AppError | null;
}

// =============================================================================
// 初始状态
// =============================================================================

const initialState: AdminStatsState = {
  overview: null,
  overviewLoading: 'idle',
  overviewError: null,

  userGrowth: null,
  userGrowthLoading: 'idle',
  userGrowthError: null,
  userGrowthPeriod: '30d',
  userGrowthRequestId: null,

  recentActivities: [],
  activitiesLoading: 'idle',
  activitiesError: null,

  systemStatus: null,
  systemStatusLoading: 'idle',
  systemStatusError: null,
  trafficResetLoading: 'idle',
  trafficResetError: null,
};

// =============================================================================
// Async Thunks
// =============================================================================

/**
 * 获取概览统计
 */
export const fetchOverviewStats = createAsyncThunk(
  'adminStats/fetchOverview',
  async (_, { rejectWithValue, signal }) => {
    try {
      return await adminStatsService.getOverview(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '获取概览统计失败'));
    }
  }
);

/**
 * 获取用户增长数据
 */
export const fetchUserGrowth = createAsyncThunk(
  'adminStats/fetchUserGrowth',
  async (period: UserGrowthPeriod, { rejectWithValue, signal }) => {
    try {
      return await adminStatsService.getUserGrowth(period, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '获取用户增长数据失败'));
    }
  }
);

/**
 * 获取最近活动
 */
export const fetchRecentActivities = createAsyncThunk(
  'adminStats/fetchRecentActivities',
  async (limit: number = 10, { rejectWithValue, signal }) => {
    try {
      return await adminStatsService.getRecentActivities(limit, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '获取最近活动失败'));
    }
  }
);

/**
 * 获取系统状态
 */
export const fetchSystemStatus = createAsyncThunk(
  'adminStats/fetchSystemStatus',
  async (_, { rejectWithValue, signal }) => {
    try {
      return await adminStatsService.getSystemStatus(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '获取系统状态失败'));
    }
  }
);

/**
 * 重置运维流量统计窗口
 */
export const resetTrafficMetrics = createAsyncThunk(
  'adminStats/resetTrafficMetrics',
  async (_, { rejectWithValue }) => {
    try {
      return await adminStatsService.resetTrafficMetrics();
    } catch (error) {
      return rejectWithValue(toAppError(error, '重置运维流量指标失败'));
    }
  }
);

// =============================================================================
// Slice 定义
// =============================================================================

const adminStatsSlice = createSlice({
  name: 'adminStats',
  initialState,
  reducers: {
    /**
     * 设置用户增长周期
     */
    setUserGrowthPeriod(state, action: PayloadAction<UserGrowthPeriod>) {
      state.userGrowthPeriod = action.payload;
    },

    clearTrafficResetError(state) {
      state.trafficResetError = null;
    },

    /**
     * 清除所有统计数据
     */
    clearStats(state) {
      Object.assign(state, initialState);
    },
  },
  extraReducers: (builder) => {
    // 概览统计
    builder
      .addCase(fetchOverviewStats.pending, (state) => {
        state.overviewLoading = 'loading';
        state.overviewError = null;
      })
      .addCase(fetchOverviewStats.fulfilled, (state, action) => {
        state.overviewLoading = 'success';
        state.overview = action.payload;
      })
      .addCase(fetchOverviewStats.rejected, (state, action) => {
        if (action.meta.aborted) {
          state.overviewLoading = state.overview ? 'success' : 'idle';
          return;
        }
        state.overviewLoading = 'error';
        state.overviewError = action.payload as AppError;
      });

    // 用户增长
    builder
      .addCase(fetchUserGrowth.pending, (state, action) => {
        state.userGrowthLoading = 'loading';
        state.userGrowthError = null;
        state.userGrowthRequestId = action.meta.requestId;
      })
      .addCase(fetchUserGrowth.fulfilled, (state, action) => {
        if (
          state.userGrowthRequestId !== action.meta.requestId ||
          action.meta.arg !== state.userGrowthPeriod
        ) return;
        state.userGrowthLoading = 'success';
        state.userGrowth = action.payload;
        state.userGrowthRequestId = null;
      })
      .addCase(fetchUserGrowth.rejected, (state, action) => {
        if (state.userGrowthRequestId !== action.meta.requestId) return;
        state.userGrowthRequestId = null;
        if (action.meta.arg !== state.userGrowthPeriod) return;
        if (action.meta.aborted) {
          state.userGrowthLoading = state.userGrowth ? 'success' : 'idle';
          return;
        }
        state.userGrowthLoading = 'error';
        state.userGrowthError = (action.payload as AppError | undefined)
          ?? toAppError(action.error, '获取用户增长数据失败');
      });

    // 最近活动
    builder
      .addCase(fetchRecentActivities.pending, (state) => {
        state.activitiesLoading = 'loading';
        state.activitiesError = null;
      })
      .addCase(fetchRecentActivities.fulfilled, (state, action) => {
        state.activitiesLoading = 'success';
        state.recentActivities = action.payload.items;
      })
      .addCase(fetchRecentActivities.rejected, (state, action) => {
        if (action.meta.aborted) {
          state.activitiesLoading = state.recentActivities.length ? 'success' : 'idle';
          return;
        }
        state.activitiesLoading = 'error';
        state.activitiesError = action.payload as AppError;
      });

    // 系统状态
    builder
      .addCase(fetchSystemStatus.pending, (state) => {
        state.systemStatusLoading = 'loading';
        state.systemStatusError = null;
      })
      .addCase(fetchSystemStatus.fulfilled, (state, action) => {
        state.systemStatusLoading = 'success';
        state.systemStatus = action.payload;
      })
      .addCase(fetchSystemStatus.rejected, (state, action) => {
        if (action.meta.aborted) {
          state.systemStatusLoading = state.systemStatus ? 'success' : 'idle';
          return;
        }
        state.systemStatusLoading = 'error';
        state.systemStatusError = action.payload as AppError;
      });

    // 运维流量统计窗口
    builder
      .addCase(resetTrafficMetrics.pending, (state) => {
        state.trafficResetLoading = 'loading';
        state.trafficResetError = null;
      })
      .addCase(resetTrafficMetrics.fulfilled, (state) => {
        state.trafficResetLoading = 'success';
      })
      .addCase(resetTrafficMetrics.rejected, (state, action) => {
        state.trafficResetLoading = 'error';
        state.trafficResetError = action.payload as AppError;
      });
  },
});

// =============================================================================
// 导出
// =============================================================================

export const { setUserGrowthPeriod, clearTrafficResetError, clearStats } = adminStatsSlice.actions;

export default adminStatsSlice.reducer;
