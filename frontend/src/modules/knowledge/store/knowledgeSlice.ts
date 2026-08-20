import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import type {
  KnowledgeNode,
  KnowledgeEdge,
  KnowledgeGraphStatistics,
  KnowledgeGraphFilters,
} from '@/modules/knowledge/types/knowledge';
import { knowledgeService } from '@/modules/knowledge/services/knowledgeService';
import { createLoadingReducers, type WithLoadingState } from '@/store/utils/sliceFactory';
import { toAppError, type AppError } from '@/libs/http/appError';
import type { KnowledgeGraphData } from '@/modules/knowledge/types/knowledge';

/**
 * 知识图谱状态
 */
export interface KnowledgeState extends WithLoadingState {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  statistics: KnowledgeGraphStatistics | null;
  filters: KnowledgeGraphFilters;
  selectedNodeId: string | null;
  requestError: AppError | null;
  graphRequestId: string | null;
}

const initialState: KnowledgeState = {
  nodes: [],
  edges: [],
  statistics: null,
  filters: {},
  selectedNodeId: null,
  requestError: null,
  graphRequestId: null,
  loadingState: 'idle',
  error: null,
};

/**
 * 异步获取知识图谱数据
 */
export const fetchKnowledgeGraph = createAsyncThunk<
  KnowledgeGraphData,
  KnowledgeGraphFilters | undefined,
  { rejectValue: AppError }
>(
  'knowledge/fetchKnowledgeGraph',
  async (filters, { rejectWithValue, signal }) => {
    try {
      return await knowledgeService.getKnowledgeGraph(filters, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return rejectWithValue(toAppError(error, '获取知识图谱数据失败'));
    }
  }
);

const knowledgeSlice = createSlice({
  name: 'knowledge',
  initialState,
  reducers: {
    // 使用工厂函数创建通用加载状态 reducers (DRY 原则)
    ...createLoadingReducers<KnowledgeState>(),

    // 设置筛选条件
    setFilters(state, action: PayloadAction<KnowledgeGraphFilters>) {
      state.filters = action.payload;
    },

    // 更新单个筛选条件
    updateFilter<K extends keyof KnowledgeGraphFilters>(
      state: KnowledgeState,
      action: PayloadAction<{ key: K; value: KnowledgeGraphFilters[K] }>
    ) {
      const { key, value } = action.payload;
      if (value === undefined || value === '') {
        delete state.filters[key];
      } else {
        state.filters[key] = value;
      }
    },

    // 清除筛选条件
    clearFilters(state) {
      state.filters = {};
    },

    // 选中节点
    selectNode(state, action: PayloadAction<string | null>) {
      state.selectedNodeId = action.payload;
    },

    // 清除数据
    clearKnowledgeGraph(state) {
      state.nodes = [];
      state.edges = [];
      state.statistics = null;
      state.selectedNodeId = null;
      state.loadingState = 'idle';
      state.error = null;
      state.requestError = null;
      state.graphRequestId = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // 获取知识图谱数据 - pending
      .addCase(fetchKnowledgeGraph.pending, (state, action) => {
        state.loadingState = 'loading';
        state.error = null;
        state.requestError = null;
        state.graphRequestId = action.meta.requestId;
      })
      // 获取知识图谱数据 - fulfilled
      .addCase(fetchKnowledgeGraph.fulfilled, (state, action) => {
        if (state.graphRequestId !== action.meta.requestId) return;
        state.loadingState = 'success';
        state.nodes = action.payload.nodes;
        state.edges = action.payload.edges;
        state.statistics = action.payload.statistics;
        state.error = null;
        state.requestError = null;
        state.graphRequestId = null;
      })
      // 获取知识图谱数据 - rejected
      .addCase(fetchKnowledgeGraph.rejected, (state, action) => {
        if (state.graphRequestId !== action.meta.requestId) return;
        state.graphRequestId = null;
        if (action.meta.aborted || action.payload?.kind === 'cancelled') {
          state.loadingState = 'idle';
          state.error = null;
          state.requestError = null;
          return;
        }
        state.loadingState = 'error';
        state.requestError = action.payload ?? toAppError(action.error, '获取知识图谱数据失败');
        state.error = state.requestError.message;
      });
  },
});

export const {
  setLoadingState,
  setError,
  clearError,
  setFilters,
  updateFilter,
  clearFilters,
  selectNode,
  clearKnowledgeGraph,
} = knowledgeSlice.actions;

export default knowledgeSlice.reducer;
