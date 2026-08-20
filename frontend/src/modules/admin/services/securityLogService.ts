/**
 * 安全日志 API 服务
 *
 * 提供安全日志的查询、删除、导出和归档功能
 */

import { apiClient } from '@/libs/http/apiClient';
import { base64ToBlob, downloadBlob } from '@/libs/utils/download';
import { logger } from '@/libs/utils/logger';
import type {
  SecurityLogListResponse,
  SecurityLogStatsResponse,
  SecurityLogExportResponse,
  SecurityLogDeleteResponse,
  SecurityLogArchiveResponse,
  SecurityLogQueryParams,
  SecurityLogDeleteRequest,
  SecurityLogExportRequest,
  SecurityLogArchiveRequest,
} from '@/modules/admin/types/securityLog';

// 创建安全日志专用日志记录器
const securityLogger = logger.createContextLogger('SecurityLog');

// API 基础路径
const BASE_PATH = '/admin/security-logs';

/**
 * 安全日志 API 服务
 */
export const securityLogService = {
  /**
   * 获取安全日志列表
   */
  async getLogs(params?: SecurityLogQueryParams, signal?: AbortSignal): Promise<SecurityLogListResponse> {
    try {
      const response = await apiClient.get<SecurityLogListResponse>(BASE_PATH, {
        params: {
          event_types: params?.event_types,
          severities: params?.severities,
          start_date: params?.start_date,
          end_date: params?.end_date,
          include_archived: params?.include_archived,
          page: params?.page,
          page_size: params?.page_size,
        },
        signal,
      });
      securityLogger.debug('获取安全日志成功', {
        total: response.data.total,
        groups: response.data.groups.length,
      });
      return response.data;
    } catch (error) {
      if (!signal?.aborted) securityLogger.error('获取安全日志失败', error);
      throw error;
    }
  },

  /**
   * 获取安全日志统计
   */
  async getStats(signal?: AbortSignal): Promise<SecurityLogStatsResponse> {
    try {
      const response = await apiClient.get<SecurityLogStatsResponse>(`${BASE_PATH}/stats`, { signal });
      securityLogger.debug('获取安全日志统计成功', response.data);
      return response.data;
    } catch (error) {
      if (!signal?.aborted) securityLogger.error('获取安全日志统计失败', error);
      throw error;
    }
  },

  /**
   * 删除安全日志
   */
  async deleteLogs(request: SecurityLogDeleteRequest): Promise<SecurityLogDeleteResponse> {
    try {
      const response = await apiClient.delete<SecurityLogDeleteResponse>(BASE_PATH, {
        data: request,
      });
      securityLogger.info('删除安全日志成功', {
        deleted_count: response.data.deleted_count,
      });
      return response.data;
    } catch (error) {
      securityLogger.error('删除安全日志失败', error);
      throw error;
    }
  },

  /**
   * 导出安全日志
   */
  async exportLogs(request: SecurityLogExportRequest): Promise<SecurityLogExportResponse> {
    try {
      const response = await apiClient.post<SecurityLogExportResponse>(
        `${BASE_PATH}/export`,
        request
      );
      securityLogger.info('导出安全日志成功', {
        filename: response.data.filename,
        record_count: response.data.record_count,
      });
      return response.data;
    } catch (error) {
      securityLogger.error('导出安全日志失败', error);
      throw error;
    }
  },

  /**
   * 归档安全日志
   */
  async archiveLogs(request: SecurityLogArchiveRequest): Promise<SecurityLogArchiveResponse> {
    try {
      const response = await apiClient.post<SecurityLogArchiveResponse>(
        `${BASE_PATH}/archive`,
        request
      );
      securityLogger.info('归档安全日志成功', {
        archived_count: response.data.archived_count,
      });
      return response.data;
    } catch (error) {
      securityLogger.error('归档安全日志失败', error);
      throw error;
    }
  },

  /**
   * 手动生成每日报告
   */
  async generateDailyReport(): Promise<{ generated: boolean; report_id?: string; message?: string }> {
    try {
      const response = await apiClient.post<{ generated: boolean; report_id?: string; message?: string }>(
        `${BASE_PATH}/generate-daily-report`
      );
      securityLogger.info('生成每日报告', response.data);
      return response.data;
    } catch (error) {
      securityLogger.error('生成每日报告失败', error);
      throw error;
    }
  },

  /**
   * 下载导出的文件
   * 将 Base64 内容转换为文件并触发下载
   */
  downloadExportedFile(exportResponse: SecurityLogExportResponse): void {
    const { filename, content, content_type } = exportResponse;

    const blob = base64ToBlob(content, content_type);
    const safeFilename = downloadBlob(blob, filename, 'security_logs_export');

    securityLogger.debug('文件下载已触发', { filename: safeFilename });
  },
};

export default securityLogService;
