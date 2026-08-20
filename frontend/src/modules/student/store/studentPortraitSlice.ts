/**
 * 学生画像 Redux Slice
 *
 * 管理学生画像的状态
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { toAppError, type AppError } from '@/libs/http/apiClient';
import { logout } from '@/modules/auth/store/authSlice';
import { studentPortraitService } from '@/modules/student/services/studentPortraitService';
import type { PortraitRangeType, StudentPortrait } from '@/modules/student/types/studentPortrait';

// =============================================================================
// 状态类型
// =============================================================================

interface StudentPortraitState {
  portrait: StudentPortrait | null;
  loadingState: 'idle' | 'loading' | 'success' | 'error';
  generating: boolean;
  clearing: boolean;
  error: AppError | null;
  fetchRequestId: string | null;
  generateRequestId: string | null;
  clearRequestId: string | null;
}

// =============================================================================
// 初始状态
// =============================================================================

const initialState: StudentPortraitState = {
  portrait: null,
  loadingState: 'idle',
  generating: false,
  clearing: false,
  error: null,
  fetchRequestId: null,
  generateRequestId: null,
  clearRequestId: null,
};

// =============================================================================
// 异步 Thunks
// =============================================================================

type PortraitThunkConfig = { rejectValue: AppError };

export const fetchPortrait = createAsyncThunk<
  StudentPortrait,
  void,
  PortraitThunkConfig
>(
  'studentPortrait/fetch',
  async (_, { rejectWithValue, signal }) => {
    try {
      return await studentPortraitService.getPortrait(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '获取画像失败'));
    }
  }
);

export const generatePortrait = createAsyncThunk<
  Awaited<ReturnType<typeof studentPortraitService.generatePortrait>>,
  PortraitRangeType,
  PortraitThunkConfig
>(
  'studentPortrait/generate',
  async (range, { rejectWithValue, signal }) => {
    try {
      return await studentPortraitService.generatePortrait(range, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '生成画像失败'));
    }
  }
);

export const clearPortrait = createAsyncThunk<
  Awaited<ReturnType<typeof studentPortraitService.clearPortrait>>,
  void,
  PortraitThunkConfig
>(
  'studentPortrait/clear',
  async (_, { rejectWithValue, signal }) => {
    try {
      return await studentPortraitService.clearPortrait(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '清除画像失败'));
    }
  }
);

// =============================================================================
// Slice
// =============================================================================

const studentPortraitSlice = createSlice({
  name: 'studentPortrait',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    // fetchPortrait
    builder
      .addCase(fetchPortrait.pending, (state, action) => {
        state.loadingState = 'loading';
        state.error = null;
        state.fetchRequestId = action.meta.requestId;
      })
      .addCase(fetchPortrait.fulfilled, (state, action) => {
        if (state.fetchRequestId !== action.meta.requestId) return;

        state.loadingState = 'success';
        state.portrait = action.payload;
        state.fetchRequestId = null;
      })
      .addCase(fetchPortrait.rejected, (state, action) => {
        if (state.fetchRequestId !== action.meta.requestId) return;

        state.loadingState = action.meta.aborted ? 'idle' : 'error';
        state.error = action.meta.aborted || !action.payload ? null : action.payload;
        state.fetchRequestId = null;
      });

    // generatePortrait
    builder
      .addCase(generatePortrait.pending, (state, action) => {
        state.generating = true;
        state.error = null;
        state.generateRequestId = action.meta.requestId;
      })
      .addCase(generatePortrait.fulfilled, (state, action) => {
        if (state.generateRequestId !== action.meta.requestId) return;

        state.generating = false;
        state.generateRequestId = null;
        if (state.portrait) {
          state.portrait.portrait_content = action.payload.portrait_content;
          state.portrait.portrait_generated_at =
            action.payload.portrait_generated_at;
          state.portrait.portrait_range = action.payload.portrait_range;
          state.portrait.portrait_snapshot_at = action.payload.portrait_snapshot_at;
          state.portrait.portrait_version = action.payload.portrait_version;
          state.portrait.has_content = true;
        }
      })
      .addCase(generatePortrait.rejected, (state, action) => {
        if (state.generateRequestId !== action.meta.requestId) return;

        state.generating = false;
        state.error = action.meta.aborted || !action.payload ? null : action.payload;
        state.generateRequestId = null;
      });

    // clearPortrait
    builder
      .addCase(clearPortrait.pending, (state, action) => {
        state.clearing = true;
        state.error = null;
        state.clearRequestId = action.meta.requestId;
      })
      .addCase(clearPortrait.fulfilled, (state, action) => {
        if (state.clearRequestId !== action.meta.requestId) return;

        state.clearing = false;
        state.clearRequestId = null;
        if (state.portrait) {
          state.portrait.portrait_content = null;
          state.portrait.portrait_generated_at = null;
          state.portrait.portrait_range = null;
          state.portrait.portrait_snapshot_at = null;
          state.portrait.portrait_version = 0;
          state.portrait.has_content = false;
        }
      })
      .addCase(clearPortrait.rejected, (state, action) => {
        if (state.clearRequestId !== action.meta.requestId) return;

        state.clearing = false;
        state.error = action.meta.aborted || !action.payload ? null : action.payload;
        state.clearRequestId = null;
      });

    // Authentication owns session lifecycle; this feature only clears its own user-scoped state.
    builder.addCase(logout, () => initialState);
  },
});

export default studentPortraitSlice.reducer;
