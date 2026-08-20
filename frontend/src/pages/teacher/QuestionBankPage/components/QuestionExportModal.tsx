/**
 * 题目导出模态框
 *
 * 支持 JSON / Markdown / TXT 三种格式导出
 * 全部在前端本地生成，不依赖后端
 */

import React, { useState } from 'react';
import { Modal } from '../../../../components/ui/Modal';
import { Button } from '../../../../components/ui/Button';
import { Download, FileJson, FileText, Loader2 } from 'lucide-react';
import { exportQuestions } from '../../../../libs/export/questionExporter';
import { questionService } from '@/modules/question/services/questionService';
import { logger } from '../../../../libs/utils/logger';
import { useToast } from '@/components/ui/Toast';
import { toAppError } from '@/libs/http/apiClient';
import type { Question, QuestionListParams } from '@/modules/question/types/question';
import type { ExportFormat, ExportOptions } from '@/modules/question/types/questionImport';

const log = logger.createContextLogger('QuestionExportModal');

interface QuestionExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 当前已加载的题目列表 */
  questions: Question[];
  /** 当前选中的题目 ID */
  selectedIds: string[];
  /** 当前筛选参数（用于导出全部筛选结果） */
  filterParams: QuestionListParams;
  /** 题目总数 */
  total: number;
}

const formatOptions: Array<{
  value: ExportFormat;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    value: 'json',
    label: 'JSON',
    description: '结构化数据，可重新导入',
    icon: <FileJson className="h-5 w-5" />,
  },
  {
    value: 'markdown',
    label: 'Markdown',
    description: '适合打印和分享，保留公式',
    icon: <FileText className="h-5 w-5" />,
  },
  {
    value: 'txt',
    label: '纯文本',
    description: '简单文本格式',
    icon: <FileText className="h-5 w-5" />,
  },
];

export const QuestionExportModal: React.FC<QuestionExportModalProps> = ({
  isOpen,
  onClose,
  questions,
  selectedIds,
  filterParams,
  total,
}) => {
  const { toast } = useToast();
  const [format, setFormat] = useState<ExportFormat>('json');
  const [includeAnswers, setIncludeAnswers] = useState(true);
  const [includeHints, setIncludeHints] = useState(false);
  const [includeSolutionSteps, setIncludeSolutionSteps] = useState(false);
  const [exportRange, setExportRange] = useState<'selected' | 'filtered'>(
    selectedIds.length > 0 ? 'selected' : 'filtered',
  );
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);

    try {
      let questionsToExport: Question[];

      if (exportRange === 'selected' && selectedIds.length > 0) {
        questionsToExport = questions.filter((q) => selectedIds.includes(q.id));
      } else {
        // 导出全部筛选结果 - 如果当前页数据不够，需要从后端获取全部
        if (questions.length < total) {
          const response = await questionService.listQuestions({
            ...filterParams,
            page: 1,
            pageSize: Math.min(total, 1000), // 最多导出 1000 道
          });
          questionsToExport = response.items;
        } else {
          questionsToExport = questions;
        }
      }

      const options: ExportOptions = {
        format,
        includeAnswers,
        includeHints,
        includeSolutionSteps,
      };

      exportQuestions(questionsToExport, options);
      log.info('导出完成', { count: questionsToExport.length, format });
      onClose();
    } catch (err) {
      log.error('导出失败', err);
      const appError = toAppError(err, '导出失败，请稍后重试');
      if (appError.kind !== 'cancelled' && appError.kind !== 'rate_limited') {
        toast({
          type: 'error',
          title: appError.message,
          description: appError.requestId ? `请求编号：${appError.requestId}` : undefined,
        });
      }
    } finally {
      setExporting(false);
    }
  };

  const exportCount =
    exportRange === 'selected' && selectedIds.length > 0
      ? selectedIds.length
      : total;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="导出题目">
      <div className="space-y-5 relative z-10">
        {/* 导出范围 */}
        <div>
          <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
            导出范围
          </label>
          <div className="flex gap-3">
            {selectedIds.length > 0 && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="exportRange"
                  checked={exportRange === 'selected'}
                  onChange={() => setExportRange('selected')}
                  className="text-primary-500"
                />
                <span className="text-sm">选中的题目 ({selectedIds.length} 道)</span>
              </label>
            )}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="exportRange"
                checked={exportRange === 'filtered'}
                onChange={() => setExportRange('filtered')}
                className="text-primary-500"
              />
              <span className="text-sm">当前筛选结果 ({total} 道)</span>
            </label>
          </div>
        </div>

        {/* 格式选择 */}
        <div>
          <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
            导出格式
          </label>
          <div className="grid grid-cols-3 gap-2">
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
            包含内容
          </label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeAnswers}
                onChange={(e) => setIncludeAnswers(e.target.checked)}
                className="rounded text-primary-500"
              />
              <span className="text-sm">答案</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeHints}
                onChange={(e) => setIncludeHints(e.target.checked)}
                className="rounded text-primary-500"
              />
              <span className="text-sm">提示</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeSolutionSteps}
                onChange={(e) => setIncludeSolutionSteps(e.target.checked)}
                className="rounded text-primary-500"
              />
              <span className="text-sm">解题步骤</span>
            </label>
          </div>
        </div>

        {/* 导出按钮 */}
        <div className="flex justify-end pt-2">
          <Button onClick={handleExport} disabled={exporting || exportCount === 0}>
            {exporting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            导出 {exportCount} 道题目
          </Button>
        </div>
      </div>
    </Modal>
  );
};
