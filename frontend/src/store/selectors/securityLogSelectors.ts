/**
 * 安全日志 Selectors
 *
 * 简单字段访问使用普通函数，无需 createSelector
 */

import type { RootState } from '@/store';

// ========== 字段 Selectors ==========

export const selectSecurityLogGroups = (state: RootState) => state.securityLog.groups;

export const selectSecurityLogTotal = (state: RootState) => state.securityLog.total;

export const selectSecurityLogStats = (state: RootState) => state.securityLog.stats;

export const selectSecurityLogLoading = (state: RootState) => state.securityLog.loading;

export const selectSecurityLogDeleteLoading = (state: RootState) => state.securityLog.deleteLoading;

export const selectSecurityLogExportLoading = (state: RootState) => state.securityLog.exportLoading;

export const selectSecurityLogSelectedIds = (state: RootState) => state.securityLog.selectedIds;

export const selectSecurityLogQueryParams = (state: RootState) => state.securityLog.queryParams;

export const selectSecurityLogError = (state: RootState) => state.securityLog.error;
