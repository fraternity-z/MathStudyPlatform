/**
 * 系统配置服务
 *
 * 提供系统配置相关的 API 调用
 */

import { apiClient } from '@/libs/http/apiClient';

/**
 * 注册配置
 */
export interface RegistrationSettings {
  allow_student: boolean;
  allow_teacher: boolean;
}

/**
 * 系统基本信息
 */
export interface GeneralSettings {
  system_name: string;
  system_description: string;
  system_version: string;
}

/**
 * 系统基本信息更新请求
 */
export interface GeneralSettingsUpdate {
  system_name: string;
  system_description: string;
}

export type StorageBackend = 'local' | 'qiniu' | 's3';

export interface QiniuStorageSettings {
  bucket_name: string;
  domain: string;
  private_bucket: boolean;
  url_expire_seconds: number;
  upload_url: string;
  access_key_configured: boolean;
  secret_key_configured: boolean;
  configured: boolean;
}

export interface S3StorageSettings {
  endpoint_url: string;
  bucket_name: string;
  region: string;
  public_url_base: string;
  private_bucket: boolean;
  url_expire_seconds: number;
  access_key_configured: boolean;
  secret_key_configured: boolean;
  configured: boolean;
}

export interface StorageSettings {
  backend: StorageBackend;
  source: 'unconfigured' | 'database';
  local: { configured: boolean };
  qiniu: QiniuStorageSettings;
  s3: S3StorageSettings;
}

export interface StorageSettingsUpdate {
  backend: StorageBackend;
  qiniu: {
    access_key?: string;
    secret_key?: string;
    bucket_name: string;
    domain: string;
    private_bucket: boolean;
    url_expire_seconds: number;
    upload_url: string;
  };
  s3: {
    endpoint_url: string;
    access_key?: string;
    secret_key?: string;
    bucket_name: string;
    region: string;
    public_url_base: string;
    private_bucket: boolean;
    url_expire_seconds: number;
  };
}

export interface StorageConnectionTestResponse {
  success: boolean;
  message: string;
  backend: StorageBackend;
  latency_ms: number;
}

// =============================================================================
// 数据库管理类型
// =============================================================================

/** 可导出的表信息 */
export interface ExportableTable {
  name: string;
  display_name: string;
}

/** 脱敏数据导出响应 */
export interface DataExportResponse {
  filename: string;
  content: string;
  exported_at: string;
  table_counts: Record<string, number>;
  total_records: number;
}

/** 单表导入结果 */
export interface TableImportResult {
  imported: number;
  skipped: number;
  failed: number;
}

/** 脱敏数据导入响应 */
export interface DataImportResponse {
  success: boolean;
  imported_at: string;
  table_results: Record<string, TableImportResult>;
  total_imported: number;
  total_skipped: number;
  total_failed: number;
  errors: string[];
}

/** 连接池状态 */
export interface ConnectionPoolStatus {
  pool_size: number;
  max_overflow: number;
  checked_out: number;
  checked_in: number;
  overflow: number;
  pool_timeout: number;
  pool_recycle: number;
  usage_percent: number;
}

/** 表统计 */
export interface TableStats {
  table_name: string;
  display_name: string;
  row_count: number;
  table_size: string;
  index_size: string;
  total_size: string;
}

/** 数据库概览 */
export interface DatabaseOverview {
  database_name: string;
  database_size: string;
  postgres_version: string;
  uptime: string;
  active_connections: number;
  max_connections: number;
}

/** 数据库监控响应 */
export interface DatabaseMonitorResponse {
  overview: DatabaseOverview;
  connection_pool: ConnectionPoolStatus;
  tables: TableStats[];
  health_status: 'healthy' | 'degraded' | 'unhealthy';
  checked_at: string;
}

/**
 * 系统配置服务
 */
export const systemSettingService = {
  /**
   * 获取注册配置（管理员接口）
   */
  async getRegistrationSettings(signal?: AbortSignal): Promise<RegistrationSettings> {
    const response = await apiClient.get<RegistrationSettings>(
      '/admin/settings/registration',
      { signal }
    );
    return response.data;
  },

  /**
   * 更新注册配置（管理员接口）
   */
  async updateRegistrationSettings(
    settings: RegistrationSettings
  ): Promise<RegistrationSettings> {
    const response = await apiClient.put<RegistrationSettings>(
      '/admin/settings/registration',
      settings
    );
    return response.data;
  },

  /**
   * 获取注册状态（公开接口）
   */
  async getRegistrationStatus(): Promise<RegistrationSettings> {
    const response = await apiClient.get<RegistrationSettings>(
      '/auth/registration-status'
    );
    return response.data;
  },

  /**
   * 获取系统基本信息（管理员接口）
   */
  async getGeneralSettings(signal?: AbortSignal): Promise<GeneralSettings> {
    const response = await apiClient.get<GeneralSettings>(
      '/admin/settings/general',
      { signal }
    );
    return response.data;
  },

  /**
   * 更新系统基本信息（管理员接口）
   */
  async updateGeneralSettings(
    settings: GeneralSettingsUpdate
  ): Promise<GeneralSettings> {
    const response = await apiClient.put<GeneralSettings>(
      '/admin/settings/general',
      settings
    );
    return response.data;
  },

  /** 获取当前生效的对象存储配置。 */
  async getStorageSettings(signal?: AbortSignal): Promise<StorageSettings> {
    const response = await apiClient.get<StorageSettings>('/admin/settings/storage', { signal });
    return response.data;
  },

  /** 保存配置；后端探测成功后立即切换运行时存储。 */
  async updateStorageSettings(settings: StorageSettingsUpdate): Promise<StorageSettings> {
    const response = await apiClient.put<StorageSettings>('/admin/settings/storage', settings, {
      timeout: 25_000,
    });
    return response.data;
  },

  /** 使用当前草稿执行真实写入探测，不保存配置。 */
  async testStorageConnection(settings: StorageSettingsUpdate): Promise<StorageConnectionTestResponse> {
    const response = await apiClient.post<StorageConnectionTestResponse>(
      '/admin/settings/storage/test',
      settings,
      { timeout: 25_000 }
    );
    return response.data;
  },

  // ===========================================================================
  // 数据库管理
  // ===========================================================================

  /**
   * 获取可导出的表列表（管理员接口）
   */
  async getExportableTables(signal?: AbortSignal): Promise<{ tables: ExportableTable[] }> {
    const response = await apiClient.get<{ tables: ExportableTable[] }>(
      '/admin/settings/database/exportable-tables',
      { signal }
    );
    return response.data;
  },

  /**
   * 导出脱敏交换数据（管理员接口）
   */
  async exportData(tables: string[]): Promise<DataExportResponse> {
    const response = await apiClient.post<DataExportResponse>(
      '/admin/settings/database/export',
      { tables }
    );
    return response.data;
  },

  /**
   * 导入脱敏交换数据（管理员接口）
   */
  async importData(file: File): Promise<DataImportResponse> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await apiClient.post<DataImportResponse>(
      '/admin/settings/database/import',
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000 }
    );
    return response.data;
  },

  /**
   * 获取数据库监控数据（管理员接口）
   */
  async getDatabaseMonitor(signal?: AbortSignal): Promise<DatabaseMonitorResponse> {
    const response = await apiClient.get<DatabaseMonitorResponse>(
      '/admin/settings/database/monitor',
      { signal }
    );
    return response.data;
  },
};

export default systemSettingService;
