import React, { useEffect, useCallback, useMemo, useReducer } from 'react';
import { AdminLayout } from '@/modules/admin/components/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Badge } from '../../components/ui/Badge';
import { VirtualTable, type VirtualTableColumn } from '../../components/ui/VirtualTable';
import { RequestErrorNotice } from '@/components/feedback';
import { useToast } from '@/components/ui/Toast';
import {
  Search,
  Filter,
  UserPlus,
  Edit,
  Trash2,
  Lock,
  Unlock,
  Download,
  Upload,
  Loader2,
} from 'lucide-react';
import { adminUserService } from '@/modules/admin/services/adminUserService';
import { UserFormModal } from '@/modules/admin/components/UserFormModal';
import { ImportUsersModal } from '@/modules/admin/components/ImportUsersModal';
import { downloadBlob } from '@/libs/utils/download';
import type {
  UserItem,
  UserListQuery,
  UserRole,
  UserStatus,
} from '@/modules/admin/types/adminUsers';
import { accountManagementReducer, initialState } from './accountManagementReducer';
import {
  getAdminErrorToast,
  isAdminRequestCancelled,
  toAdminAppError,
} from '@/modules/admin/utils/errorFeedback';

export const AccountManagementPage: React.FC = () => {
  const { toast } = useToast();
  // 使用 useReducer 管理所有状态
  const [state, dispatch] = useReducer(accountManagementReducer, initialState);

  // 加载统计数据
  const loadStats = useCallback(async (signal?: AbortSignal) => {
    dispatch({ type: 'SET_STATS_LOADING', payload: true });
    dispatch({ type: 'SET_STATS_ERROR', payload: null });
    try {
      const data = await adminUserService.getAccountStats(signal);
      if (signal?.aborted) return;
      dispatch({ type: 'SET_STATS', payload: data });
    } catch (error) {
      if (signal?.aborted || isAdminRequestCancelled(error)) return;
      dispatch({ type: 'SET_STATS_ERROR', payload: toAdminAppError(error, '加载统计数据失败') });
    } finally {
      if (!signal?.aborted) dispatch({ type: 'SET_STATS_LOADING', payload: false });
    }
  }, []);

  // 加载用户列表
  const loadUsers = useCallback(async (signal?: AbortSignal) => {
    dispatch({ type: 'SET_USERS_LOADING', payload: true });
    dispatch({ type: 'SET_USERS_ERROR', payload: null });
    try {
      const query: UserListQuery = {
        page: state.pagination.currentPage,
        page_size: state.pagination.pageSize,
        search: state.filters.searchTerm || undefined,
        role: state.filters.roleFilter,
        status: state.filters.statusFilter,
      };
      const data = await adminUserService.listUsers(query, signal);
      if (signal?.aborted) return;
      dispatch({
        type: 'SET_USERS',
        payload: {
          users: data.items,
          total: data.total,
          totalPages: data.total_pages,
        },
      });
    } catch (error) {
      if (signal?.aborted || isAdminRequestCancelled(error)) return;
      dispatch({ type: 'SET_USERS_ERROR', payload: toAdminAppError(error, '加载用户列表失败') });
    } finally {
      if (!signal?.aborted) dispatch({ type: 'SET_USERS_LOADING', payload: false });
    }
  }, [state.pagination.currentPage, state.pagination.pageSize, state.filters.searchTerm, state.filters.roleFilter, state.filters.statusFilter]);

  // 初始加载
  useEffect(() => {
    const controller = new AbortController();
    void loadStats(controller.signal);
    return () => controller.abort();
  }, [loadStats]);

  // 加载用户列表（带防抖）
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void loadUsers(controller.signal);
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [loadUsers]);

  // 处理状态更新（锁定/解锁）
  const handleStatusToggle = useCallback(async (user: UserItem) => {
    const newStatus: UserStatus = user.status === 'active' ? 'suspended' : 'active';
    dispatch({ type: 'SET_ACTION_LOADING', payload: user.id });
    try {
      const response = await adminUserService.updateUserStatus(user.id, newStatus);
      if (response.email_notification) {
        toast({ type: 'success', title: '账户状态已更新', description: response.message });
      }
      // 刷新数据
      await Promise.all([loadStats(), loadUsers()]);
    } catch (error) {
      const feedback = getAdminErrorToast(error, '更新用户状态失败');
      if (feedback) toast(feedback);
    } finally {
      dispatch({ type: 'SET_ACTION_LOADING', payload: null });
    }
  }, [loadStats, loadUsers, toast]);

  // 处理删除
  const handleDelete = useCallback(async (user: UserItem) => {
    if (!confirm(`确定要删除用户 "${user.username}" 吗？此操作不可恢复。`)) {
      return;
    }
    dispatch({ type: 'SET_ACTION_LOADING', payload: user.id });
    try {
      await adminUserService.deleteUser(user.id);
      // 刷新数据
      await Promise.all([loadStats(), loadUsers()]);
    } catch (error) {
      const feedback = getAdminErrorToast(error, '删除用户失败');
      if (feedback) toast(feedback);
    } finally {
      dispatch({ type: 'SET_ACTION_LOADING', payload: null });
    }
  }, [loadStats, loadUsers, toast]);

  // 处理导出
  const handleExport = async () => {
    dispatch({ type: 'SET_EXPORT_LOADING', payload: true });
    try {
      const blob = await adminUserService.exportUsers({
        search: state.filters.searchTerm || undefined,
        role: state.filters.roleFilter,
        status: state.filters.statusFilter,
      });
      downloadBlob(blob, `users_export_${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (error) {
      const feedback = getAdminErrorToast(error, '导出用户失败', '导出失败');
      if (feedback) toast(feedback);
    } finally {
      dispatch({ type: 'SET_EXPORT_LOADING', payload: false });
    }
  };

  // 处理添加用户成功
  const handleAddUserSuccess = () => {
    loadStats();
    loadUsers();
  };

  // 处理编辑用户
  const handleEditUser = useCallback((user: UserItem) => {
    dispatch({ type: 'SET_EDITING_USER', payload: user });
  }, []);

  // 处理编辑成功
  const handleEditUserSuccess = () => {
    loadStats();
    loadUsers();
    dispatch({ type: 'SET_EDITING_USER', payload: null });
  };

  // 处理导入成功
  const handleImportSuccess = () => {
    loadStats();
    loadUsers();
  };

  // 生成分页按钮
  const renderPagination = () => {
    const pages: (number | string)[] = [];
    const maxVisiblePages = 5;
    const { currentPage, totalPages } = state.pagination;

    if (totalPages <= maxVisiblePages) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      if (currentPage <= 3) {
        pages.push(1, 2, 3, '...', totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1, '...', totalPages - 2, totalPages - 1, totalPages);
      } else {
        pages.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages);
      }
    }

    return pages.map((page, index) => (
      <Button
        key={index}
        variant={page === currentPage ? 'primary' : 'outline'}
        size="sm"
        disabled={page === '...'}
        onClick={() => typeof page === 'number' && dispatch({ type: 'SET_CURRENT_PAGE', payload: page })}
      >
        {page}
      </Button>
    ));
  };

  // 格式化日期
  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // 虚拟化表格列定义 - 使用 useMemo 缓存
  const tableColumns: VirtualTableColumn<UserItem>[] = useMemo(() => [
    {
      key: 'username',
      header: '用户名',
      width: '15%',
      render: (user) => (
        <span className="font-medium text-surface-900 dark:text-surface-100">
          {user.username}
        </span>
      ),
    },
    {
      key: 'display_name',
      header: '姓名',
      width: '12%',
      render: (user) => (
        <span className="text-surface-700 dark:text-surface-300">
          {user.display_name || '-'}
        </span>
      ),
    },
    {
      key: 'email',
      header: '邮箱',
      width: '20%',
      render: (user) => (
        <span className="text-surface-600 dark:text-surface-400">
          {user.email}
        </span>
      ),
    },
    {
      key: 'role',
      header: '角色',
      width: '10%',
      align: 'center',
      render: (user) => <RoleBadge role={user.role} />,
    },
    {
      key: 'status',
      header: '状态',
      width: '10%',
      align: 'center',
      render: (user) => <StatusBadge status={user.status} />,
    },
    {
      key: 'created_at',
      header: '创建时间',
      width: '15%',
      render: (user) => (
        <span className="text-surface-600 dark:text-surface-400 text-sm">
          {formatDate(user.created_at)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      width: '18%',
      align: 'right',
      render: (user) => (
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => handleEditUser(user)}
            title="编辑用户"
          >
            <Edit className="w-4 h-4" />
          </Button>
          {user.role !== 'admin' && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => handleStatusToggle(user)}
                disabled={state.loading.action === user.id}
                title={user.status === 'active' ? '停用账户' : '启用账户'}
              >
                {state.loading.action === user.id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : user.status === 'active' ? (
                  <Lock className="w-4 h-4" />
                ) : (
                  <Unlock className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-red-600 dark:text-red-400"
                onClick={() => handleDelete(user)}
                disabled={state.loading.action === user.id}
                title="删除用户"
              >
                {state.loading.action === user.id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
              </Button>
            </>
          )}
        </div>
      ),
    },
  ], [state.loading.action, handleEditUser, handleStatusToggle, handleDelete]);

  return (
    <AdminLayout>
      <div className="container mx-auto max-w-7xl">
        {/* 页面标题 */}
        <div className="flex justify-between items-center mb-10">
          <div>
            <h1 className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-2">账户管理</h1>
            <p className="text-surface-500 dark:text-surface-400">管理系统中的所有用户账户</p>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={handleExport} disabled={state.loading.export}>
              {state.loading.export ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Download className="w-4 h-4 mr-2" />
              )}
              导出
            </Button>
            <Button variant="outline" onClick={() => dispatch({ type: 'OPEN_IMPORT_MODAL' })}>
              <Upload className="w-4 h-4 mr-2" />
              导入
            </Button>
            <Button onClick={() => dispatch({ type: 'OPEN_ADD_USER_MODAL' })}>
              <UserPlus className="w-4 h-4 mr-2" />
              添加账户
            </Button>
          </div>
        </div>

        {state.errors.stats ? (
          <RequestErrorNotice
            error={state.errors.stats}
            onRetry={() => void loadStats()}
            onRefresh={() => void loadStats()}
            className="mb-6"
          />
        ) : null}

        {/* 统计卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card>
            <CardContent className="pt-6">
              {state.loading.stats ? (
                <div className="flex items-center justify-center h-12">
                  <Loader2 className="w-6 h-6 animate-spin text-surface-400" />
                </div>
              ) : state.errors.stats ? (
                <div className="text-sm text-surface-500 dark:text-surface-400">暂不可用</div>
              ) : (
                <>
                  <div className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                    {state.data.stats?.total.toLocaleString() ?? 0}
                  </div>
                  <div className="text-sm text-surface-500 dark:text-surface-400 mt-1">总账户数</div>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              {state.loading.stats ? (
                <div className="flex items-center justify-center h-12">
                  <Loader2 className="w-6 h-6 animate-spin text-surface-400" />
                </div>
              ) : state.errors.stats ? (
                <div className="text-sm text-surface-500 dark:text-surface-400">暂不可用</div>
              ) : (
                <>
                  <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                    {state.data.stats?.active.toLocaleString() ?? 0}
                  </div>
                  <div className="text-sm text-surface-500 dark:text-surface-400 mt-1">活跃账户</div>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              {state.loading.stats ? (
                <div className="flex items-center justify-center h-12">
                  <Loader2 className="w-6 h-6 animate-spin text-surface-400" />
                </div>
              ) : state.errors.stats ? (
                <div className="text-sm text-surface-500 dark:text-surface-400">暂不可用</div>
              ) : (
                <>
                  <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                    {state.data.stats?.suspended.toLocaleString() ?? 0}
                  </div>
                  <div className="text-sm text-surface-500 dark:text-surface-400 mt-1">已停用</div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* 搜索和筛选 */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-surface-400" />
                <Input
                  placeholder="搜索用户名、邮箱或姓名..."
                  value={state.filters.searchTerm}
                  onChange={(e) => dispatch({ type: 'SET_SEARCH_TERM', payload: e.target.value })}
                  className="pl-10"
                />
              </div>
              <div className="flex gap-3">
                <Select
                  value={state.filters.roleFilter}
                  onChange={(value) => dispatch({ type: 'SET_ROLE_FILTER', payload: value as UserRole | 'all' })}
                  className="w-40"
                  options={[
                    { value: 'all', label: '所有角色' },
                    { value: 'student', label: '学生' },
                    { value: 'teacher', label: '教师' },
                    { value: 'admin', label: '管理员' },
                  ]}
                />
                <Select
                  value={state.filters.statusFilter}
                  onChange={(value) => dispatch({ type: 'SET_STATUS_FILTER', payload: value as UserStatus | 'all' })}
                  className="w-40"
                  options={[
                    { value: 'all', label: '所有状态' },
                    { value: 'active', label: '活跃' },
                    { value: 'suspended', label: '已停用' },
                  ]}
                />
                <Button variant="outline">
                  <Filter className="w-4 h-4 mr-2" />
                  高级筛选
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 账户列表 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">账户列表</CardTitle>
          </CardHeader>
          <CardContent>
            {state.loading.users ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-surface-400" />
                <span className="ml-3 text-surface-500">加载中...</span>
              </div>
            ) : state.errors.users ? (
              <RequestErrorNotice
                error={state.errors.users}
                onRetry={() => void loadUsers()}
                onRefresh={() => void loadUsers()}
              />
            ) : state.data.users.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <p className="text-surface-500 dark:text-surface-400">暂无用户数据</p>
              </div>
            ) : (
              <VirtualTable
                data={state.data.users}
                columns={tableColumns}
                rowHeight={64}
                getRowKey={(user) => user.id}
                emptyMessage="暂无用户数据"
              />
            )}

            {/* 分页 */}
            {!state.loading.users && !state.errors.users && state.data.users.length > 0 && (
              <div className="flex items-center justify-between mt-6 pt-6 border-t border-surface-200 dark:border-surface-700">
                <div className="text-sm text-surface-500 dark:text-surface-400">
                  显示 {(state.pagination.currentPage - 1) * state.pagination.pageSize + 1}-
                  {Math.min(state.pagination.currentPage * state.pagination.pageSize, state.data.totalUsers)} 条，共 {state.data.totalUsers.toLocaleString()} 条记录
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state.pagination.currentPage === 1}
                    onClick={() => dispatch({ type: 'SET_CURRENT_PAGE', payload: state.pagination.currentPage - 1 })}
                  >
                    上一页
                  </Button>
                  {renderPagination()}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state.pagination.currentPage === state.pagination.totalPages}
                    onClick={() => dispatch({ type: 'SET_CURRENT_PAGE', payload: state.pagination.currentPage + 1 })}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 模态框 */}
      <UserFormModal
        isOpen={state.modals.addUser}
        onClose={() => dispatch({ type: 'CLOSE_ADD_USER_MODAL' })}
        onSuccess={handleAddUserSuccess}
        mode="add"
      />
      <UserFormModal
        isOpen={state.modals.editingUser !== null}
        onClose={() => dispatch({ type: 'SET_EDITING_USER', payload: null })}
        onSuccess={handleEditUserSuccess}
        mode="edit"
        user={state.modals.editingUser}
      />
      <ImportUsersModal
        isOpen={state.modals.import}
        onClose={() => dispatch({ type: 'CLOSE_IMPORT_MODAL' })}
        onSuccess={handleImportSuccess}
      />
    </AdminLayout>
  );
};

// 角色徽章组件
const RoleBadge = ({ role }: { role: string }) => {
  const roleConfig: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'destructive' }> = {
    student: { label: '学生', variant: 'default' },
    teacher: { label: '教师', variant: 'success' },
    admin: { label: '管理员', variant: 'destructive' },
  };

  const config = roleConfig[role] || { label: role, variant: 'default' };

  return <Badge variant={config.variant}>{config.label}</Badge>;
};

// 状态徽章组件
const StatusBadge = ({ status }: { status: string }) => {
  const statusConfig: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'destructive' }> = {
    active: { label: '活跃', variant: 'success' },
    suspended: { label: '已停用', variant: 'destructive' },
  };

  const config = statusConfig[status] || { label: status, variant: 'default' };

  return <Badge variant={config.variant}>{config.label}</Badge>;
};
