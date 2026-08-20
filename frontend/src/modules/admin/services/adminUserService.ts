/**
 * 管理员用户管理 API 服务
 *
 * 提供用户账户管理的 API 调用
 */

import { apiClient } from '@/libs/http/apiClient';
import { logger } from '@/libs/utils/logger';
import type {
  UserAccountStats,
  UserCreateRequest,
  UserCreateResponse,
  UserDeleteResponse,
  UserImportResponse,
  UserListQuery,
  UserListResponse,
  UserStatus,
  UserStatusUpdateResponse,
  UserUpdateRequest,
  UserUpdateResponse,
} from '@/modules/admin/types/adminUsers';

// 创建用户管理专用日志记录器
const adminUserLogger = logger.createContextLogger('AdminUser');

// API 基础路径
const BASE_PATH = '/admin/users';

/**
 * 管理员用户管理 API 服务
 */
export const adminUserService = {
  /**
   * 获取账户统计数据
   */
  async getAccountStats(signal?: AbortSignal): Promise<UserAccountStats> {
    try {
      const response = await apiClient.get<UserAccountStats>(`${BASE_PATH}/stats`, { signal });
      adminUserLogger.debug('获取账户统计成功', response.data);
      return response.data;
    } catch (error) {
      if (!signal?.aborted) adminUserLogger.error('获取账户统计失败', error);
      throw error;
    }
  },

  /**
   * 获取用户列表
   */
  async listUsers(query: UserListQuery = {}, signal?: AbortSignal): Promise<UserListResponse> {
    try {
      const params: Record<string, unknown> = {};

      if (query.page) params.page = query.page;
      if (query.page_size) params.page_size = query.page_size;
      if (query.search) params.search = query.search;
      if (query.role && query.role !== 'all') params.role = query.role;
      if (query.status && query.status !== 'all') params.status = query.status;

      const response = await apiClient.get<UserListResponse>(BASE_PATH, { params, signal });
      adminUserLogger.debug('获取用户列表成功', {
        total: response.data.total,
        page: response.data.page,
      });
      return response.data;
    } catch (error) {
      if (!signal?.aborted) adminUserLogger.error('获取用户列表失败', error);
      throw error;
    }
  },

  /**
   * 更新用户状态
   */
  async updateUserStatus(
    userId: string,
    status: UserStatus
  ): Promise<UserStatusUpdateResponse> {
    try {
      const response = await apiClient.patch<UserStatusUpdateResponse>(
        `${BASE_PATH}/${userId}/status`,
        { status }
      );
      adminUserLogger.info('更新用户状态成功', { userId, status });
      return response.data;
    } catch (error) {
      adminUserLogger.error('更新用户状态失败', { userId, status, error });
      throw error;
    }
  },

  /**
   * 删除用户
   */
  async deleteUser(userId: string): Promise<UserDeleteResponse> {
    try {
      const response = await apiClient.delete<UserDeleteResponse>(
        `${BASE_PATH}/${userId}`
      );
      adminUserLogger.info('删除用户成功', { userId });
      return response.data;
    } catch (error) {
      adminUserLogger.error('删除用户失败', { userId, error });
      throw error;
    }
  },

  /**
   * 创建用户
   */
  async createUser(data: UserCreateRequest): Promise<UserCreateResponse> {
    try {
      const response = await apiClient.post<UserCreateResponse>(BASE_PATH, data);
      adminUserLogger.info('创建用户成功', { username: data.username });
      return response.data;
    } catch (error) {
      adminUserLogger.error('创建用户失败', { username: data.username, error });
      throw error;
    }
  },

  /**
   * 更新用户信息
   */
  async updateUser(userId: string, data: UserUpdateRequest): Promise<UserUpdateResponse> {
    try {
      const response = await apiClient.put<UserUpdateResponse>(
        `${BASE_PATH}/${userId}`,
        data
      );
      adminUserLogger.info('更新用户成功', { userId });
      return response.data;
    } catch (error) {
      adminUserLogger.error('更新用户失败', { userId, error });
      throw error;
    }
  },

  /**
   * 导出用户列表
   */
  async exportUsers(query: UserListQuery = {}): Promise<Blob> {
    try {
      const params: Record<string, unknown> = {};
      if (query.search) params.search = query.search;
      if (query.role && query.role !== 'all') params.role = query.role;
      if (query.status && query.status !== 'all') params.status = query.status;

      const response = await apiClient.get(`${BASE_PATH}/export`, {
        params,
        responseType: 'blob',
      });
      adminUserLogger.info('导出用户成功');
      return response.data as Blob;
    } catch (error) {
      adminUserLogger.error('导出用户失败', error);
      throw error;
    }
  },

  /**
   * 导入用户
   */
  async importUsers(file: File): Promise<UserImportResponse> {
    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await apiClient.post<UserImportResponse>(
        `${BASE_PATH}/import`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
        }
      );
      adminUserLogger.info('导入用户完成', {
        total: response.data.total,
        created: response.data.created,
      });
      return response.data;
    } catch (error) {
      adminUserLogger.error('导入用户失败', error);
      throw error;
    }
  },
};

export default adminUserService;
