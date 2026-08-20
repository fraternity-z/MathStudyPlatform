/**
 * 资源 API 服务
 *
 * 提供资源中心的 API 调用
 */

import { apiClient } from '@/libs/http/apiClient';
import { logger } from '@/libs/utils/logger';
import type {
  Resource,
  ResourceFilter,
  ResourceListResponse,
  ResourceStats,
  ResourceCreateRequest,
  ResourceUpdateRequest,
  FavoriteToggleResponse,
} from '@/modules/resource/types/resource';

// 创建资源专用日志记录器
const resourceLogger = logger.createContextLogger('Resource');

// API 基础路径
const BASE_PATH = '/resources';

/**
 * 资源 API 服务
 */
export const resourceService = {
  /**
   * 获取资源列表
   */
  async getResources(filter?: ResourceFilter, signal?: AbortSignal): Promise<ResourceListResponse> {
    try {
      const response = await apiClient.get<ResourceListResponse>(BASE_PATH, {
        params: filter,
        signal,
      });
      resourceLogger.debug('获取资源列表成功', {
        total: response.data.total,
        page: response.data.page,
      });
      return response.data;
    } catch (error) {
      resourceLogger.error('获取资源列表失败', error);
      throw error;
    }
  },

  /**
   * 获取资源统计
   */
  async getStats(signal?: AbortSignal): Promise<ResourceStats> {
    try {
      const response = await apiClient.get<ResourceStats>(`${BASE_PATH}/stats`, { signal });
      resourceLogger.debug('获取资源统计成功', response.data);
      return response.data;
    } catch (error) {
      resourceLogger.error('获取资源统计失败', error);
      throw error;
    }
  },

  /**
   * 获取收藏列表
   */
  async getFavorites(page: number = 1, pageSize: number = 20): Promise<ResourceListResponse> {
    try {
      const response = await apiClient.get<ResourceListResponse>(`${BASE_PATH}/favorites`, {
        params: { page, page_size: pageSize },
      });
      resourceLogger.debug('获取收藏列表成功', {
        total: response.data.total,
      });
      return response.data;
    } catch (error) {
      resourceLogger.error('获取收藏列表失败', error);
      throw error;
    }
  },

  /**
   * 获取单个资源详情
   */
  async getResourceById(id: string): Promise<Resource> {
    try {
      const response = await apiClient.get<Resource>(`${BASE_PATH}/${id}`);
      resourceLogger.debug('获取资源详情成功', { id });
      return response.data;
    } catch (error) {
      resourceLogger.error('获取资源详情失败', { id, error });
      throw error;
    }
  },

  /**
   * 创建资源
   */
  async createResource(data: ResourceCreateRequest, signal?: AbortSignal): Promise<Resource> {
    try {
      const response = await apiClient.post<Resource>(BASE_PATH, data, { signal });
      resourceLogger.info('创建资源成功', { id: response.data.id, title: data.title });
      return response.data;
    } catch (error) {
      resourceLogger.error('创建资源失败', { title: data.title, error });
      throw error;
    }
  },

  /**
   * 更新资源
   */
  async updateResource(id: string, data: ResourceUpdateRequest, signal?: AbortSignal): Promise<Resource> {
    try {
      const response = await apiClient.put<Resource>(`${BASE_PATH}/${id}`, data, { signal });
      resourceLogger.info('更新资源成功', { id });
      return response.data;
    } catch (error) {
      resourceLogger.error('更新资源失败', { id, error });
      throw error;
    }
  },

  /**
   * 删除资源
   */
  async deleteResource(id: string, signal?: AbortSignal): Promise<void> {
    try {
      await apiClient.delete(`${BASE_PATH}/${id}`, { signal });
      resourceLogger.info('删除资源成功', { id });
    } catch (error) {
      resourceLogger.error('删除资源失败', { id, error });
      throw error;
    }
  },

  /**
   * 切换收藏状态
   */
  async toggleFavorite(id: string, signal?: AbortSignal): Promise<FavoriteToggleResponse> {
    try {
      const response = await apiClient.post<FavoriteToggleResponse>(
        `${BASE_PATH}/${id}/favorite`,
        undefined,
        { signal }
      );
      resourceLogger.debug('切换收藏状态成功', {
        id,
        is_favorite: response.data.is_favorite,
      });
      return response.data;
    } catch (error) {
      resourceLogger.error('切换收藏状态失败', { id, error });
      throw error;
    }
  },
};

export default resourceService;
