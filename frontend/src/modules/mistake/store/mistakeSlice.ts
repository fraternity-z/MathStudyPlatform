import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import type { LoadingState } from '@/types';
import { createLoadingReducers, type WithLoadingState } from '@/store/utils/sliceFactory';
import * as mistakeService from '@/modules/mistake/services/mistakeService';
import { toAppError, type AppError } from '@/libs/http/appError';
import type {
  MistakeRecord,
  MistakeStatisticsResponse,
  MistakeDetail,
  MistakeQueryParams,
  PaginationInfo,
  MistakeStatistics,
} from '@/modules/mistake/services/mistakeService';

/**
 * 错题本状态
 */
export interface MistakeState extends WithLoadingState {
  mistakes: MistakeRecord[];
  statistics: MistakeStatisticsResponse | null;
  selectedMistake: MistakeDetail | null;
  queryParams: MistakeQueryParams;
  pagination: PaginationInfo;
  listStatistics: MistakeStatistics | null;
  detailLoading: LoadingState;
  statisticsLoading: LoadingState;
  /** Structured request error retained alongside the legacy text field. */
  requestError: AppError | null;
}

const initialState: MistakeState = {
  mistakes: [],
  statistics: null,
  selectedMistake: null,
  queryParams: {
    page: 1,
    pageSize: 20,
    masteryStatus: 'all',
    sortBy: 'time',
    sortOrder: 'desc',
  },
  pagination: {
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  },
  listStatistics: null,
  loadingState: 'idle',
  detailLoading: 'idle',
  statisticsLoading: 'idle',
  error: null,
  requestError: null,
};

// ========== Async Thunks ==========

/**
 * 获取错题列表
 */
export const fetchMistakes = createAsyncThunk<
  Awaited<ReturnType<typeof mistakeService.fetchMistakes>>,
  MistakeQueryParams,
  { rejectValue: AppError }
>(
  'mistake/fetchMistakes',
  async (params: MistakeQueryParams, { rejectWithValue, signal }) => {
    try {
      const response = await mistakeService.fetchMistakes(params, signal);
      return response;
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '获取错题列表失败'));
    }
  }
);

/**
 * 获取错题统计
 */
export const fetchStatistics = createAsyncThunk<
  Awaited<ReturnType<typeof mistakeService.fetchStatistics>>,
  string | undefined,
  { rejectValue: AppError }
>(
  'mistake/fetchStatistics',
  async (timeRange: string = 'month', { rejectWithValue, signal }) => {
    try {
      const response = await mistakeService.fetchStatistics(timeRange, signal);
      return response;
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '获取错题统计失败'));
    }
  }
);

/**
 * 获取错题详情
 */
export const fetchMistakeDetail = createAsyncThunk<
  Awaited<ReturnType<typeof mistakeService.fetchMistakeDetail>>,
  string,
  { rejectValue: AppError }
>(
  'mistake/fetchMistakeDetail',
  async (attemptId: string, { rejectWithValue, signal }) => {
    try {
      const response = await mistakeService.fetchMistakeDetail(attemptId, signal);
      return response;
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '获取错题详情失败'));
    }
  }
);

/**
 * 标记错题已掌握
 */
export const markAsMastered = createAsyncThunk<
  Awaited<ReturnType<typeof mistakeService.markAsMastered>>,
  string,
  { rejectValue: AppError }
>(
  'mistake/markAsMastered',
  async (attemptId: string, { rejectWithValue, dispatch, getState, signal }) => {
    try {
      const response = await mistakeService.markAsMastered(attemptId, signal);
      // 标记成功后刷新列表
      const state = getState() as { mistake: MistakeState };
      const refresh = dispatch(fetchMistakes(state.mistake.queryParams));
      signal.addEventListener('abort', () => refresh.abort(), { once: true });
      return response;
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '标记已掌握失败'));
    }
  }
);

/**
 * 删除错题
 */
export const deleteMistake = createAsyncThunk<
  string,
  string,
  { rejectValue: AppError }
>(
  'mistake/deleteMistake',
  async (attemptId: string, { rejectWithValue, dispatch, getState, signal }) => {
    try {
      await mistakeService.deleteMistake(attemptId, signal);
      // 删除成功后刷新列表
      const state = getState() as { mistake: MistakeState };
      const refresh = dispatch(fetchMistakes(state.mistake.queryParams));
      signal.addEventListener('abort', () => refresh.abort(), { once: true });
      return attemptId;
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '删除错题失败'));
    }
  }
);

/**
 * 获取复习题目
 */
export const fetchReviewExercise = createAsyncThunk<
  Awaited<ReturnType<typeof mistakeService.fetchReviewExercise>>,
  { focusConcept?: string; focusErrorType?: string },
  { rejectValue: AppError }
>(
  'mistake/fetchReviewExercise',
  async (
    params: { focusConcept?: string; focusErrorType?: string } = {},
    { rejectWithValue, signal }
  ) => {
    try {
      const response = await mistakeService.fetchReviewExercise(params, signal);
      return response;
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '获取复习题目失败'));
    }
  }
);

// ========== Slice ==========

const mistakeSlice = createSlice({
  name: 'mistake',
  initialState,
  reducers: {
    // 使用工厂函数创建通用加载状态 reducers
    ...createLoadingReducers<MistakeState>(),

    // 设置查询参数
    setQueryParams(state, action: PayloadAction<Partial<MistakeQueryParams>>) {
      state.queryParams = {
        ...state.queryParams,
        ...action.payload,
      };
    },

    // 重置查询参数
    resetQueryParams(state) {
      state.queryParams = initialState.queryParams;
    },

    // 清除选中的错题详情
    clearSelectedMistake(state) {
      state.selectedMistake = null;
      state.detailLoading = 'idle';
    },

    // 清除错误
    clearError(state) {
      state.error = null;
      state.requestError = null;
    },

    setRequestError(state, action: PayloadAction<AppError | null>) {
      state.requestError = action.payload;
      state.error = action.payload?.message ?? null;
    },
  },
  extraReducers: (builder) => {
    // 获取错题列表
    builder
      .addCase(fetchMistakes.pending, (state, action) => {
        state.loadingState = 'loading';
        state.error = null;
        state.requestError = null;
        state.queryParams = {
          ...state.queryParams,
          ...action.meta.arg,
        };
      })
      .addCase(fetchMistakes.fulfilled, (state, action) => {
        state.loadingState = 'success';
        state.requestError = null;
        state.mistakes = action.payload.items;
        state.pagination = action.payload.pagination;
        state.listStatistics = action.payload.statistics;
      })
      .addCase(fetchMistakes.rejected, (state, action) => {
        if (action.meta.aborted) {
          state.loadingState = 'idle';
          state.requestError = null;
          state.error = null;
          return;
        }
        state.loadingState = 'error';
        state.requestError = action.payload ?? toAppError(action.error, '获取错题列表失败');
        state.error = state.requestError.message;
      });

    // 获取错题统计
    builder
      .addCase(fetchStatistics.pending, (state) => {
        state.statisticsLoading = 'loading';
        state.requestError = null;
      })
      .addCase(fetchStatistics.fulfilled, (state, action) => {
        state.statisticsLoading = 'success';
        state.statistics = action.payload;
        state.requestError = null;
      })
      .addCase(fetchStatistics.rejected, (state, action) => {
        if (action.meta.aborted) {
          state.statisticsLoading = 'idle';
          state.requestError = null;
          state.error = null;
          return;
        }
        state.statisticsLoading = 'error';
        state.requestError = action.payload ?? toAppError(action.error, '获取错题统计失败');
        state.error = state.requestError.message;
      });

    // 获取错题详情
    builder
      .addCase(fetchMistakeDetail.pending, (state) => {
        state.detailLoading = 'loading';
        state.error = null;
        state.requestError = null;
      })
      .addCase(fetchMistakeDetail.fulfilled, (state, action) => {
        state.detailLoading = 'success';
        state.selectedMistake = action.payload;
        state.requestError = null;
      })
      .addCase(fetchMistakeDetail.rejected, (state, action) => {
        if (action.meta.aborted) {
          state.detailLoading = 'idle';
          state.requestError = null;
          state.error = null;
          return;
        }
        state.detailLoading = 'error';
        state.requestError = action.payload ?? toAppError(action.error, '获取错题详情失败');
        state.error = state.requestError.message;
      });

    // 标记已掌握
    builder
      .addCase(markAsMastered.pending, (state) => {
        state.loadingState = 'loading';
        state.requestError = null;
      })
      .addCase(markAsMastered.fulfilled, (state) => {
        state.loadingState = 'success';
        state.requestError = null;
      })
      .addCase(markAsMastered.rejected, (state, action) => {
        if (action.meta.aborted) {
          state.loadingState = 'idle';
          state.requestError = null;
          state.error = null;
          return;
        }
        state.loadingState = 'error';
        state.requestError = action.payload ?? toAppError(action.error, '标记已掌握失败');
        state.error = state.requestError.message;
      });

    // 删除错题
    builder
      .addCase(deleteMistake.pending, (state) => {
        state.loadingState = 'loading';
        state.requestError = null;
      })
      .addCase(deleteMistake.fulfilled, (state) => {
        state.loadingState = 'success';
        state.requestError = null;
      })
      .addCase(deleteMistake.rejected, (state, action) => {
        if (action.meta.aborted) {
          state.loadingState = 'idle';
          state.requestError = null;
          state.error = null;
          return;
        }
        state.loadingState = 'error';
        state.requestError = action.payload ?? toAppError(action.error, '删除错题失败');
        state.error = state.requestError.message;
      });
  },
});

// ========== Actions ==========

export const {
  setQueryParams,
  resetQueryParams,
  clearSelectedMistake,
  clearError,
  setLoadingState,
  setError,
  setRequestError,
} = mistakeSlice.actions;

// ========== Selectors ==========

export const selectMistakes = (state: { mistake: MistakeState }) =>
  state.mistake.mistakes;

export const selectPagination = (state: { mistake: MistakeState }) =>
  state.mistake.pagination;

export const selectListStatistics = (state: { mistake: MistakeState }) =>
  state.mistake.listStatistics;

export const selectStatistics = (state: { mistake: MistakeState }) =>
  state.mistake.statistics;

export const selectSelectedMistake = (state: { mistake: MistakeState }) =>
  state.mistake.selectedMistake;

export const selectQueryParams = (state: { mistake: MistakeState }) =>
  state.mistake.queryParams;

export const selectLoadingState = (state: { mistake: MistakeState }) =>
  state.mistake.loadingState;

export const selectDetailLoading = (state: { mistake: MistakeState }) =>
  state.mistake.detailLoading;

export const selectStatisticsLoading = (state: { mistake: MistakeState }) =>
  state.mistake.statisticsLoading;

export const selectError = (state: { mistake: MistakeState }) =>
  state.mistake.error;

export const selectRequestError = (state: { mistake: MistakeState }) =>
  state.mistake.requestError;

// ========== Reducer ==========

export default mistakeSlice.reducer;
