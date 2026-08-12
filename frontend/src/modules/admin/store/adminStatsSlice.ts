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
import { getApiErrorMessage } from '@/libs/http/apiClient';

// =============================================================================
// State 类型定义
// =============================================================================

interface AdminStatsState {
  // 概览统计
  overview: OverviewStats | null;
  overviewLoading: LoadingState;
  overviewError: string | null;

  // 用户增长
  userGrowth: UserGrowthResponse | null;
  userGrowthLoading: LoadingState;
  userGrowthError: string | null;
  userGrowthPeriod: UserGrowthPeriod;
  userGrowthRequestId: string | null;

  // 最近活动
  recentActivities: ActivityItem[];
  activitiesLoading: LoadingState;
  activitiesError: string | null;

  // 系统状态
  systemStatus: SystemStatusResponse | null;
  systemStatusLoading: LoadingState;
  systemStatusError: string | null;
  trafficResetLoading: LoadingState;
  trafficResetError: string | null;
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
  async (_, { rejectWithValue }) => {
    try {
      return await adminStatsService.getOverview();
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : '获取概览统计失败'
      );
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
      return rejectWithValue(
        error instanceof Error ? error.message : '获取用户增长数据失败'
      );
    }
  }
);

/**
 * 获取最近活动
 */
export const fetchRecentActivities = createAsyncThunk(
  'adminStats/fetchRecentActivities',
  async (limit: number = 10, { rejectWithValue }) => {
    try {
      return await adminStatsService.getRecentActivities(limit);
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : '获取最近活动失败'
      );
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
      return rejectWithValue(
        error instanceof Error ? error.message : '获取系统状态失败'
      );
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
      return rejectWithValue(getApiErrorMessage(error, '重置运维流量指标失败'));
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
        state.overviewLoading = 'error';
        state.overviewError = action.payload as string;
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
        state.userGrowthError = (action.payload as string | undefined) ?? action.error.message ?? '获取用户增长数据失败';
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
        state.activitiesLoading = 'error';
        state.activitiesError = action.payload as string;
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
        state.systemStatusLoading = 'error';
        state.systemStatusError = action.payload as string;
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
        state.trafficResetError = action.payload as string;
      });
  },
});

// =============================================================================
// 导出
// =============================================================================

export const { setUserGrowthPeriod, clearTrafficResetError, clearStats } = adminStatsSlice.actions;

export default adminStatsSlice.reducer;
