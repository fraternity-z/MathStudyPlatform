/**
 * 安全日志弹窗组件
 *
 * 展示安全日志列表，支持筛选、删除和导出功能
 */

import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Shield } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/store';
import {
  fetchSecurityLogs,
  fetchSecurityLogStats,
  deleteSecurityLogs,
  exportSecurityLogs,
  setQueryParams,
  resetQueryParams,
} from '@/modules/admin/store/securityLogSlice';
import {
  selectSecurityLogGroups,
  selectSecurityLogTotal,
  selectSecurityLogStats,
  selectSecurityLogLoading,
  selectSecurityLogDeleteLoading,
  selectSecurityLogExportLoading,
  selectSecurityLogSelectedIds,
  selectSecurityLogQueryParams,
  selectSecurityLogError,
} from '@/store/selectors/securityLogSelectors';
import { SecurityLogToolbar } from './SecurityLogToolbar';
import { SecurityLogFilters } from './SecurityLogFilters';
import { SecurityLogList } from './SecurityLogList';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { RequestErrorNotice } from '@/components/feedback';

interface SecurityLogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SecurityLogModal: React.FC<SecurityLogModalProps> = ({ isOpen, onClose }) => {
  const dispatch = useAppDispatch();
  const groups = useAppSelector(selectSecurityLogGroups);
  const total = useAppSelector(selectSecurityLogTotal);
  const stats = useAppSelector(selectSecurityLogStats);
  const loading = useAppSelector(selectSecurityLogLoading);
  const deleteLoading = useAppSelector(selectSecurityLogDeleteLoading);
  const exportLoading = useAppSelector(selectSecurityLogExportLoading);
  const selectedIds = useAppSelector(selectSecurityLogSelectedIds);
  const queryParams = useAppSelector(selectSecurityLogQueryParams);
  const error = useAppSelector(selectSecurityLogError);

  const [showFilters, setShowFilters] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [exportFormat, setExportFormat] = useState<'json' | 'csv'>('json');

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const expandedGroups = useMemo(
    () => new Set(groups.filter((group) => !collapsedGroups.has(group.date)).map((group) => group.date)),
    [collapsedGroups, groups]
  );

  // 打开弹窗时加载数据
  useEffect(() => {
    if (!isOpen) return;
    let requests: Array<{ abort: () => void }> = [];
    // The next task runs only for the active mount/open state under StrictMode.
    const timer = window.setTimeout(() => {
      requests = [
        dispatch(fetchSecurityLogs(undefined)),
        dispatch(fetchSecurityLogStats()),
      ];
    }, 0);
    return () => {
      window.clearTimeout(timer);
      requests.forEach((request) => request.abort());
    };
  }, [isOpen, dispatch]);

  // 刷新数据
  const handleRefresh = () => {
    dispatch(fetchSecurityLogs(undefined));
    dispatch(fetchSecurityLogStats());
  };

  // 切换日期组展开状态
  const toggleGroup = (date: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);

      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
      }

      return next;
    });
  };

  // 删除确认处理（选中删除 or 清空全部）
  const handleDeleteConfirm = () => {
    if (selectedIds.length > 0) {
      dispatch(deleteSecurityLogs({ log_ids: selectedIds }));
    } else {
      dispatch(deleteSecurityLogs({ delete_all: true }));
    }
    setShowDeleteConfirm(false);
  };

  // 导出日志
  const handleExport = () => {
    dispatch(exportSecurityLogs({ format: exportFormat }));
  };

  // 筛选：事件类型
  const handleEventTypeFilter = (eventType: import('@/modules/admin/types/securityLog').SecurityEventType) => {
    const currentTypes = queryParams.event_types || [];
    const newTypes = currentTypes.includes(eventType)
      ? currentTypes.filter((t) => t !== eventType)
      : [...currentTypes, eventType];
    dispatch(setQueryParams({ event_types: newTypes.length > 0 ? newTypes : undefined }));
    dispatch(fetchSecurityLogs(undefined));
  };

  // 筛选：严重程度
  const handleSeverityFilter = (severity: import('@/modules/admin/types/securityLog').SecuritySeverity) => {
    const currentSeverities = queryParams.severities || [];
    const newSeverities = currentSeverities.includes(severity)
      ? currentSeverities.filter((s) => s !== severity)
      : [...currentSeverities, severity];
    dispatch(setQueryParams({ severities: newSeverities.length > 0 ? newSeverities : undefined }));
    dispatch(fetchSecurityLogs(undefined));
  };

  // 重置筛选
  const handleResetFilters = () => {
    dispatch(resetQueryParams());
    dispatch(fetchSecurityLogs(undefined));
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        {/* 背景遮罩 */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/50"
          onClick={onClose}
        />

        {/* 弹窗内容 */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="relative w-full max-w-4xl max-h-[85vh] bg-white dark:bg-surface-800 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        >
          {/* 头部 */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-surface-200 dark:border-surface-700">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary-100 dark:bg-primary-900/30 rounded-lg">
                <Shield className="w-5 h-5 text-primary-600 dark:text-primary-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-100">
                  安全日志
                </h2>
                <p className="text-sm text-surface-500 dark:text-surface-400">
                  共 {total} 条记录
                  {stats && stats.error_count > 0 && (
                    <span className="ml-2 text-red-500">
                      ({stats.error_count} 条异常)
                    </span>
                  )}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-surface-100 dark:hover:bg-surface-700 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-surface-500" />
            </button>
          </div>

          {/* 工具栏 */}
          <SecurityLogToolbar
            showFilters={showFilters}
            loading={loading}
            exportLoading={exportLoading}
            total={total}
            selectedIds={selectedIds}
            exportFormat={exportFormat}
            onToggleFilters={() => setShowFilters(!showFilters)}
            onRefresh={handleRefresh}
            onShowDeleteConfirm={() => setShowDeleteConfirm(true)}
            onExportFormatChange={setExportFormat}
            onExport={handleExport}
          />

          {/* 筛选面板 */}
          <SecurityLogFilters
            show={showFilters}
            queryParams={queryParams}
            onEventTypeFilter={handleEventTypeFilter}
            onSeverityFilter={handleSeverityFilter}
            onResetFilters={handleResetFilters}
          />

          {/* 日志列表 */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {error ? (
              <RequestErrorNotice
                error={error}
                onRetry={handleRefresh}
                onRefresh={handleRefresh}
                className="mb-4"
              />
            ) : null}
            <SecurityLogList
              groups={groups}
              loading={loading}
              selectedIds={selectedIds}
              expandedGroups={expandedGroups}
              onToggleGroup={toggleGroup}
            />
          </div>

          {/* 统计信息底栏 */}
          {stats && (
            <div className="flex items-center justify-between px-6 py-3 border-t border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/50 text-sm">
              <div className="flex items-center gap-6">
                <span className="text-surface-600 dark:text-surface-400">
                  总计: <span className="font-medium text-surface-900 dark:text-surface-100">{stats.total_count}</span>
                </span>
                <span className="text-red-600">
                  异常: <span className="font-medium">{stats.error_count}</span>
                </span>
                <span className="text-orange-600">
                  警告: <span className="font-medium">{stats.warning_count}</span>
                </span>
                <span className="text-blue-600">
                  信息: <span className="font-medium">{stats.info_count}</span>
                </span>
              </div>
              {stats.last_daily_report_at && (
                <span className="text-surface-500">
                  最近报告: {new Date(stats.last_daily_report_at).toLocaleString('zh-CN')}
                </span>
              )}
            </div>
          )}

          {/* 删除确认弹窗 */}
          <DeleteConfirmDialog
            show={showDeleteConfirm}
            selectedCount={selectedIds.length}
            deleteLoading={deleteLoading}
            onCancel={() => setShowDeleteConfirm(false)}
            onConfirm={handleDeleteConfirm}
          />
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default SecurityLogModal;
