import type { UserItem, UserAccountStats, UserRole, UserStatus } from '@/modules/admin/types/adminUsers';
import type { AppError } from '@/libs/http/apiClient';

/**
 * 账户管理页面状态类型
 */
export interface AccountManagementState {
  // 筛选状态
  filters: {
    searchTerm: string;
    roleFilter: UserRole | 'all';
    statusFilter: UserStatus | 'all';
  };

  // 分页状态
  pagination: {
    currentPage: number;
    pageSize: number;
    totalPages: number;
  };

  // 数据状态
  data: {
    stats: UserAccountStats | null;
    users: UserItem[];
    totalUsers: number;
  };

  // 加载状态
  loading: {
    stats: boolean;
    users: boolean;
    action: string | null;
    export: boolean;
  };

  // 错误状态
  errors: {
    stats: AppError | null;
    users: AppError | null;
  };

  // 模态框状态
  modals: {
    addUser: boolean;
    import: boolean;
    editingUser: UserItem | null;
  };
}

/**
 * 账户管理页面 Action 类型
 */
export type AccountManagementAction =
  // 筛��相关
  | { type: 'SET_SEARCH_TERM'; payload: string }
  | { type: 'SET_ROLE_FILTER'; payload: UserRole | 'all' }
  | { type: 'SET_STATUS_FILTER'; payload: UserStatus | 'all' }
  | { type: 'RESET_FILTERS' }

  // 分页相关
  | { type: 'SET_CURRENT_PAGE'; payload: number }
  | { type: 'SET_TOTAL_PAGES'; payload: number }

  // 数据相关
  | { type: 'SET_STATS'; payload: UserAccountStats }
  | { type: 'SET_USERS'; payload: { users: UserItem[]; total: number; totalPages: number } }

  // 加载状态相关
  | { type: 'SET_STATS_LOADING'; payload: boolean }
  | { type: 'SET_USERS_LOADING'; payload: boolean }
  | { type: 'SET_ACTION_LOADING'; payload: string | null }
  | { type: 'SET_EXPORT_LOADING'; payload: boolean }

  // 错误状态相关
  | { type: 'SET_STATS_ERROR'; payload: AppError | null }
  | { type: 'SET_USERS_ERROR'; payload: AppError | null }

  // 模态框相关
  | { type: 'OPEN_ADD_USER_MODAL' }
  | { type: 'CLOSE_ADD_USER_MODAL' }
  | { type: 'OPEN_IMPORT_MODAL' }
  | { type: 'CLOSE_IMPORT_MODAL' }
  | { type: 'SET_EDITING_USER'; payload: UserItem | null };

/**
 * 初始状态
 */
export const initialState: AccountManagementState = {
  filters: {
    searchTerm: '',
    roleFilter: 'all',
    statusFilter: 'all',
  },
  pagination: {
    currentPage: 1,
    pageSize: 10,
    totalPages: 1,
  },
  data: {
    stats: null,
    users: [],
    totalUsers: 0,
  },
  loading: {
    stats: true,
    users: true,
    action: null,
    export: false,
  },
  errors: {
    stats: null,
    users: null,
  },
  modals: {
    addUser: false,
    import: false,
    editingUser: null,
  },
};

/**
 * 账户管理页面 Reducer
 */
export const accountManagementReducer = (
  state: AccountManagementState,
  action: AccountManagementAction
): AccountManagementState => {
  switch (action.type) {
    // 筛选相关
    case 'SET_SEARCH_TERM':
      return {
        ...state,
        filters: { ...state.filters, searchTerm: action.payload },
        pagination: { ...state.pagination, currentPage: 1 }, // 重置到第一页
      };

    case 'SET_ROLE_FILTER':
      return {
        ...state,
        filters: { ...state.filters, roleFilter: action.payload },
        pagination: { ...state.pagination, currentPage: 1 },
      };

    case 'SET_STATUS_FILTER':
      return {
        ...state,
        filters: { ...state.filters, statusFilter: action.payload },
        pagination: { ...state.pagination, currentPage: 1 },
      };

    case 'RESET_FILTERS':
      return {
        ...state,
        filters: initialState.filters,
        pagination: { ...state.pagination, currentPage: 1 },
      };

    // 分页相关
    case 'SET_CURRENT_PAGE':
      return {
        ...state,
        pagination: { ...state.pagination, currentPage: action.payload },
      };

    case 'SET_TOTAL_PAGES':
      return {
        ...state,
        pagination: { ...state.pagination, totalPages: action.payload },
      };

    // 数据相关
    case 'SET_STATS':
      return {
        ...state,
        data: { ...state.data, stats: action.payload },
      };

    case 'SET_USERS':
      return {
        ...state,
        data: {
          ...state.data,
          users: action.payload.users,
          totalUsers: action.payload.total,
        },
        pagination: {
          ...state.pagination,
          totalPages: action.payload.totalPages,
        },
      };

    // 加载状态相关
    case 'SET_STATS_LOADING':
      return {
        ...state,
        loading: { ...state.loading, stats: action.payload },
      };

    case 'SET_USERS_LOADING':
      return {
        ...state,
        loading: { ...state.loading, users: action.payload },
      };

    case 'SET_ACTION_LOADING':
      return {
        ...state,
        loading: { ...state.loading, action: action.payload },
      };

    case 'SET_EXPORT_LOADING':
      return {
        ...state,
        loading: { ...state.loading, export: action.payload },
      };

    // 错误状态相关
    case 'SET_STATS_ERROR':
      return {
        ...state,
        errors: { ...state.errors, stats: action.payload },
      };

    case 'SET_USERS_ERROR':
      return {
        ...state,
        errors: { ...state.errors, users: action.payload },
      };

    // 模态框相关
    case 'OPEN_ADD_USER_MODAL':
      return {
        ...state,
        modals: { ...state.modals, addUser: true },
      };

    case 'CLOSE_ADD_USER_MODAL':
      return {
        ...state,
        modals: { ...state.modals, addUser: false },
      };

    case 'OPEN_IMPORT_MODAL':
      return {
        ...state,
        modals: { ...state.modals, import: true },
      };

    case 'CLOSE_IMPORT_MODAL':
      return {
        ...state,
        modals: { ...state.modals, import: false },
      };

    case 'SET_EDITING_USER':
      return {
        ...state,
        modals: { ...state.modals, editingUser: action.payload },
      };

    default:
      return state;
  }
};
