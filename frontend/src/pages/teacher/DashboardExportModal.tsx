/**
 * 教学概览报告导出模态框
 *
 * 支持 CSV / Markdown 两种格式
 * 可选择导出的数据区域
 */

import React, { useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Download, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import {
  exportDashboardReport,
  type DashboardExportFormat,
  type DashboardExportSections,
} from '../../libs/export/dashboardExporter';
import { logger } from '../../libs/utils/logger';
import { useToast } from '@/components/ui/Toast';
import { toAppErrorFeedback } from '@/libs/http/apiClient';
import type { DashboardStats, TeacherAnalyticsData } from '@/modules/teacher/types/teacher';

const log = logger.createContextLogger('DashboardExportModal');

interface DashboardExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  stats: DashboardStats;
  analytics: TeacherAnalyticsData;
  timeRangeLabel: string;
}

const formatOptions: Array<{
  value: DashboardExportFormat;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    value: 'csv',
    label: 'CSV',
    description: '表格数据，可用 Excel 打开',
    icon: <FileSpreadsheet className="h-5 w-5" />,
  },
  {
    value: 'markdown',
    label: 'Markdown',
    description: '格式化文档，适合分享',
    icon: <FileText className="h-5 w-5" />,
  },
];

const sectionOptions: Array<{
  key: keyof DashboardExportSections;
  label: string;
}> = [
  { key: 'overview', label: '统计概览（6 项核心指标）' },
  { key: 'knowledgePoints', label: '知识点掌握度分析' },
  { key: 'topStudents', label: '成绩排行榜' },
  { key: 'weeklyActivity', label: '本周学习活跃度' },
];

export const DashboardExportModal: React.FC<DashboardExportModalProps> = ({
  isOpen,
  onClose,
  stats,
  analytics,
  timeRangeLabel,
}) => {
  const { toast } = useToast();
  const [format, setFormat] = useState<DashboardExportFormat>('csv');
  const [sections, setSections] = useState<DashboardExportSections>({
    overview: true,
    knowledgePoints: true,
    topStudents: true,
    weeklyActivity: true,
  });
  const [exporting, setExporting] = useState(false);

  const toggleSection = (key: keyof DashboardExportSections) => {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const hasAnySection = Object.values(sections).some(Boolean);

  const handleExport = () => {
    setExporting(true);
    try {
      exportDashboardReport(stats, analytics, {
        format,
        sections,
        timeRangeLabel,
      });
      log.info('教学报告导出完成', { format, sections });
      onClose();
    } catch (err) {
      log.error('教学报告导出失败', err);
      const feedback = toAppErrorFeedback(err, '导出失败，请稍后重试');
      if (feedback) toast(feedback);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="导出教学报告">
      <div className="space-y-5 relative z-10">
        {/* 格式选择 */}
        <div>
          <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
            导出格式
          </label>
          <div className="grid grid-cols-2 gap-2">
            {formatOptions.map((opt) => (
              <button
                key={opt.value}
                className={`flex flex-col items-center gap-1 p-3 rounded-lg border text-sm transition-colors ${
                  format === opt.value
                    ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                    : 'border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600'
                }`}
                onClick={() => setFormat(opt.value)}
              >
                {opt.icon}
                <span className="font-medium">{opt.label}</span>
                <span className="text-xs text-surface-500">{opt.description}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 内容选项 */}
        <div>
          <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
            导出内容
          </label>
          <div className="space-y-2">
            {sectionOptions.map((opt) => (
              <label key={opt.key} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sections[opt.key]}
                  onChange={() => toggleSection(opt.key)}
                  className="rounded text-primary-500"
                />
                <span className="text-sm">{opt.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* 导出按钮 */}
        <div className="flex justify-end pt-2">
          <Button onClick={handleExport} disabled={exporting || !hasAnySection}>
            {exporting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            导出报告
          </Button>
        </div>
      </div>
    </Modal>
  );
};
