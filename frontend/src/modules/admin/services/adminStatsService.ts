/**
 * 管理员统计 API 服务
 *
 * 提供管理员控制台统计数据的 API 调用
 */

import { apiClient } from '@/libs/http/apiClient';
import { logger } from '@/libs/utils/logger';
import type {
  OverviewStats,
  UserGrowthResponse,
  RecentActivitiesResponse,
  ResetTrafficMetricsResponse,
  SystemStatusResponse,
  UserGrowthPeriod,
} from '@/modules/admin/types/adminStats';

// 创建统计专用日志记录器
const statsLogger = logger.createContextLogger('AdminStats');

// API 基础路径
const BASE_PATH = '/admin/stats';

/**
 * 管理员统计 API 服务
 */
export const adminStatsService = {
  /**
   * 获取概览统计数据
   */
  async getOverview(signal?: AbortSignal): Promise<OverviewStats> {
    try {
      const response = await apiClient.get<OverviewStats>(`${BASE_PATH}/overview`, { signal });
      statsLogger.debug('获取概览统计成功', {
        total_users: response.data.total_users,
      });
      return response.data;
    } catch (error) {
      if (!signal?.aborted) statsLogger.error('获取概览统计失败', error);
      throw error;
    }
  },

  /**
   * 获取用户增长趋势数据
   * @param period 统计周期 (7d/30d/90d)
   */
  async getUserGrowth(period: UserGrowthPeriod = '30d', signal?: AbortSignal): Promise<UserGrowthResponse> {
    try {
      const response = await apiClient.get<UserGrowthResponse>(
        `${BASE_PATH}/user-growth`,
        { params: { period }, signal }
      );
      statsLogger.debug('获取用户增长数据成功', {
        period,
        dataPoints: response.data.data.length,
      });
      return response.data;
    } catch (error) {
      if (!signal?.aborted) {
        statsLogger.error('获取用户增长数据失败', { period, error });
      }
      throw error;
    }
  },

  /**
   * 获取最近活动列表
   * @param limit 返回数量限制
   */
  async getRecentActivities(limit: number = 10, signal?: AbortSignal): Promise<RecentActivitiesResponse> {
    try {
      const response = await apiClient.get<RecentActivitiesResponse>(
        `${BASE_PATH}/recent-activities`,
        { params: { limit }, signal }
      );
      statsLogger.debug('获取最近活动成功', {
        count: response.data.items.length,
      });
      return response.data;
    } catch (error) {
      if (!signal?.aborted) statsLogger.error('获取最近活动失败', { limit, error });
      throw error;
    }
  },

  /**
   * 获取系统状态
   */
  async getSystemStatus(signal?: AbortSignal): Promise<SystemStatusResponse> {
    try {
      const response = await apiClient.get<SystemStatusResponse>(
        `${BASE_PATH}/system-status`,
        { signal }
      );
      statsLogger.debug('获取系统状态成功', {
        servicesCount: response.data.services.length,
        alertsCount: response.data.alerts.length,
      });
      return response.data;
    } catch (error) {
      if (!signal?.aborted) statsLogger.error('获取系统状态失败', error);
      throw error;
    }
  },

  /**
   * 开启新的运维流量统计窗口
   */
  async resetTrafficMetrics(): Promise<ResetTrafficMetricsResponse> {
    try {
      const response = await apiClient.post<ResetTrafficMetricsResponse>(
        `${BASE_PATH}/system-status/reset`
      );
      statsLogger.info('重置运维流量指标成功', { resetAt: response.data.reset_at });
      return response.data;
    } catch (error) {
      statsLogger.error('重置运维流量指标失败', error);
      throw error;
    }
  },
};

export default adminStatsService;
