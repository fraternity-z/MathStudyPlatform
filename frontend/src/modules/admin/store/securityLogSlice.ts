/**
 * 安全日志 Redux Slice
 *
 * 管理安全日志的状态
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '@/store';
import { securityLogService } from '@/modules/admin/services/securityLogService';
import type {
  SecurityLogGroup,
  SecurityLogStatsResponse,
  SecurityLogQueryParams,
  SecurityLogDeleteRequest,
  SecurityLogExportRequest,
} from '@/modules/admin/types/securityLog';
import { toAppError, type AppError } from '@/libs/http/apiClient';

// =============================================================================
// 状态类型
// =============================================================================

interface SecurityLogState {
  // 日志数据
  groups: SecurityLogGroup[];
  total: number;
  hasMore: boolean;

  // 统计数据
  stats: SecurityLogStatsResponse | null;

  // 加载状态
  loading: 'idle' | 'loading' | 'succeeded' | 'failed';
  statsLoading: 'idle' | 'loading' | 'succeeded' | 'failed';
  deleteLoading: boolean;
  exportLoading: boolean;

  // 选中状态
  selectedIds: string[];

  // 查询参数
  queryParams: SecurityLogQueryParams;

  // 错误信息
  error: AppError | null;
}

// =============================================================================
// 初始状态
// =============================================================================

const initialState: SecurityLogState = {
  groups: [],
  total: 0,
  hasMore: false,
  stats: null,
  loading: 'idle',
  statsLoading: 'idle',
  deleteLoading: false,
  exportLoading: false,
  selectedIds: [],
  queryParams: {
    page: 1,
    page_size: 50,
    include_archived: false,
  },
  error: null,
};

// =============================================================================
// 异步 Thunks
// =============================================================================

/**
 * 获取安全日志列表
 */
export const fetchSecurityLogs = createAsyncThunk(
  'securityLog/fetchLogs',
  async (params: SecurityLogQueryParams | undefined, { getState, rejectWithValue, signal }) => {
    try {
      const state = getState() as { securityLog: SecurityLogState };
      const queryParams = params || state.securityLog.queryParams;
      return await securityLogService.getLogs(queryParams, signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '获取安全日志失败'));
    }
  },
  {
    condition: (_, { getState }) => {
      const { loading } = (getState() as RootState).securityLog;
      return loading !== 'loading';
    },
  }
);

/**
 * 获取安全日志统计
 */
export const fetchSecurityLogStats = createAsyncThunk(
  'securityLog/fetchStats',
  async (_, { rejectWithValue, signal }) => {
    try {
      return await securityLogService.getStats(signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '获取统计数据失败'));
    }
  }
);

/**
 * 删除安全日志
 */
export const deleteSecurityLogs = createAsyncThunk(
  'securityLog/deleteLogs',
  async (request: SecurityLogDeleteRequest, { dispatch, rejectWithValue }) => {
    try {
      const result = await securityLogService.deleteLogs(request);
      // 删除后刷新列表
      dispatch(fetchSecurityLogs(undefined));
      dispatch(fetchSecurityLogStats());
      return result;
    } catch (error: unknown) {
      return rejectWithValue(toAppError(error, '删除日志失败'));
    }
  }
);

/**
 * 导出安全日志
 */
export const exportSecurityLogs = createAsyncThunk(
  'securityLog/exportLogs',
  async (request: SecurityLogExportRequest, { rejectWithValue }) => {
    try {
      const result = await securityLogService.exportLogs(request);
      // 触发文件下载
      securityLogService.downloadExportedFile(result);
      return result;
    } catch (error: unknown) {
      return rejectWithValue(toAppError(error, '导出日志失败'));
    }
  }
);

// =============================================================================
// Slice
// =============================================================================

const securityLogSlice = createSlice({
  name: 'securityLog',
  initialState,
  reducers: {
    // 切换选中状态
    toggleSelectLog: (state, action: PayloadAction<string>) => {
      const id = action.payload;
      const index = state.selectedIds.indexOf(id);
      if (index === -1) {
        state.selectedIds.push(id);
      } else {
        state.selectedIds.splice(index, 1);
      }
    },

    // 全选/取消全选
    toggleSelectAll: (state) => {
      const allIds = state.groups.flatMap((g) => g.logs.map((l) => l.id));
      if (state.selectedIds.length === allIds.length) {
        state.selectedIds = [];
      } else {
        state.selectedIds = allIds;
      }
    },

    // 清空选中
    clearSelection: (state) => {
      state.selectedIds = [];
    },

    // 更新查询参数
    setQueryParams: (state, action: PayloadAction<Partial<SecurityLogQueryParams>>) => {
      state.queryParams = { ...state.queryParams, ...action.payload };
    },

    // 重置查询参数
    resetQueryParams: (state) => {
      state.queryParams = initialState.queryParams;
    },

    // 清空错误
    clearError: (state) => {
      state.error = null;
    },

    // 重置状态
    resetState: () => initialState,
  },
  extraReducers: (builder) => {
    builder
      // 获取日志列表
      .addCase(fetchSecurityLogs.pending, (state) => {
        state.loading = 'loading';
        state.error = null;
      })
      .addCase(fetchSecurityLogs.fulfilled, (state, action) => {
        state.loading = 'succeeded';
        state.groups = action.payload.groups;
        state.total = action.payload.total;
        state.hasMore = action.payload.has_more;
      })
      .addCase(fetchSecurityLogs.rejected, (state, action) => {
        if (action.meta.aborted) {
          state.loading = state.groups.length ? 'succeeded' : 'idle';
          return;
        }
        state.loading = 'failed';
        state.error = action.payload as AppError;
      })

      // 获取统计
      .addCase(fetchSecurityLogStats.pending, (state) => {
        state.statsLoading = 'loading';
      })
      .addCase(fetchSecurityLogStats.fulfilled, (state, action) => {
        state.statsLoading = 'succeeded';
        state.stats = action.payload;
      })
      .addCase(fetchSecurityLogStats.rejected, (state, action) => {
        state.statsLoading = action.meta.aborted ? 'idle' : 'failed';
        if (!action.meta.aborted && action.payload) state.error = action.payload as AppError;
      })

      // 删除日志
      .addCase(deleteSecurityLogs.pending, (state) => {
        state.deleteLoading = true;
      })
      .addCase(deleteSecurityLogs.fulfilled, (state) => {
        state.deleteLoading = false;
        state.selectedIds = [];
      })
      .addCase(deleteSecurityLogs.rejected, (state, action) => {
        state.deleteLoading = false;
        state.error = action.payload as AppError;
      })

      // 导出日志
      .addCase(exportSecurityLogs.pending, (state) => {
        state.exportLoading = true;
      })
      .addCase(exportSecurityLogs.fulfilled, (state) => {
        state.exportLoading = false;
      })
      .addCase(exportSecurityLogs.rejected, (state, action) => {
        state.exportLoading = false;
        state.error = action.payload as AppError;
      });
  },
});

// =============================================================================
// 导出
// =============================================================================

export const {
  toggleSelectLog,
  toggleSelectAll,
  clearSelection,
  setQueryParams,
  resetQueryParams,
  clearError,
  resetState,
} = securityLogSlice.actions;

export default securityLogSlice.reducer;
