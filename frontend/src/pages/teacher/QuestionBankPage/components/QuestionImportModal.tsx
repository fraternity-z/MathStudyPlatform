/**
 * 题目导入模态框
 *
 * 步骤式 UI：上传 → 解析中 → 预览编辑 → 导入中 → 完成
 */

import React, { useState, useCallback, useRef } from 'react';
import { Modal } from '../../../../components/ui/Modal';
import { RequestErrorNotice } from '@/components/feedback';
import { Button } from '../../../../components/ui/Button';
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle,
  AlertCircle,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import { parseDocxFile } from '../../../../libs/parsers/docxParser';
import { parseTxtFile } from '../../../../libs/parsers/txtParser';
import { parseQuestions, aiResultToParsedQuestion } from '../../../../libs/parsers/questionParser';
import {
  buildAiParseTexts,
  limitParsedQuestions,
  selectAiParseQuestions,
} from '../utils/importBoundaries';
import { questionService } from '@/modules/question/services/questionService';
import { logger } from '../../../../libs/utils/logger';
import { ImportPreviewTable } from './ImportPreviewTable';
import type { ParsedQuestion, ImportStep, ImportResult } from '@/modules/question/types/questionImport';
import type { QuestionCreateData } from '@/modules/question/types/question';
import { toAppError, type AppError } from '@/libs/http/apiClient';
import {
  SUPPORTED_IMPORT_EXTENSIONS,
  MAX_IMPORT_FILE_SIZE,
  MAX_BATCH_IMPORT_SIZE,
} from '@/modules/question/types/questionImport';

const log = logger.createContextLogger('QuestionImportModal');

interface QuestionImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete: () => void;
  maxSelected?: number;
  importActionLabel?: string;
  completionActionLabel?: string;
  onImportQuestions?: (questions: QuestionCreateData[]) => Promise<ImportResult>;
}

export const QuestionImportModal: React.FC<QuestionImportModalProps> = ({
  isOpen,
  onClose,
  onImportComplete,
  maxSelected,
  importActionLabel = '导入选中题目',
  completionActionLabel = '查看题库',
  onImportQuestions,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectionLimit = maxSelected == null
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(maxSelected));

  // 状态
  const [step, setStep] = useState<ImportStep>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [parsedQuestions, setParsedQuestions] = useState<ParsedQuestion[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [aiParsingIds, setAiParsingIds] = useState<Set<string>>(new Set());
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<AppError | null>(null);
  const [fileWarnings, setFileWarnings] = useState<string[]>([]);

  // 重置状态
  const resetState = () => {
    setStep('upload');
    setFile(null);
    setParsedQuestions([]);
    setSelectedIds(new Set());
    setAiParsingIds(new Set());
    setImportResult(null);
    setError(null);
    setRequestError(null);
    setFileWarnings([]);
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  // ==================== 文件选择和解析 ====================

  const validateFile = (f: File): string | null => {
    const ext = '.' + f.name.split('.').pop()?.toLowerCase();
    if (!SUPPORTED_IMPORT_EXTENSIONS.includes(ext as '.docx' | '.txt')) {
      return `不支持的文件格式 "${ext}"，仅支持 .docx 和 .txt`;
    }
    if (f.size > MAX_IMPORT_FILE_SIZE) {
      return `文件大小 ${(f.size / 1024 / 1024).toFixed(1)}MB 超过 10MB 限制`;
    }
    return null;
  };

  const handleFileSelect = useCallback(async (f: File) => {
    const validationError = validateFile(f);
    if (validationError) {
      setError(validationError);
      return;
    }

    setFile(f);
    setError(null);
    setRequestError(null);
    setStep('parsing');

    try {
      let text: string;
      const warnings: string[] = [];
      const ext = f.name.split('.').pop()?.toLowerCase();

      if (ext === 'docx') {
        const result = await parseDocxFile(f);
        text = result.text;
        warnings.push(...result.warnings);
      } else {
        const result = await parseTxtFile(f);
        text = result.text;
        warnings.push(...result.warnings);
      }

      // 解析题目
      const limited = limitParsedQuestions(parseQuestions(text));
      const questions = limited.questions;
      warnings.push(...limited.warnings);
      setFileWarnings(warnings);

      if (questions.length === 0) {
        setError('未能从文件中识别到任何题目，请检查文件格式或尝试使用 AI 辅助识别');
        setStep('upload');
        return;
      }

      log.info('题目解析完成', { count: questions.length });
      setParsedQuestions(questions);
      setSelectedIds(new Set(questions.slice(0, selectionLimit).map((q) => q.tempId)));
      setStep('preview');
    } catch (err) {
      const message = err instanceof Error ? err.message : '文件解析失败';
      log.error('文件解析失败', err);
      setError(message);
      setStep('upload');
    }
  }, [selectionLimit]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile) handleFileSelect(droppedFile);
    },
    [handleFileSelect],
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  // ==================== 预览操作 ====================

  const handleToggleSelect = (id: string) => {
    if (!selectedIds.has(id) && selectionLimit === 1) {
      setSelectedIds(new Set([id]));
      setError(null);
      return;
    }
    if (!selectedIds.has(id) && selectedIds.size >= selectionLimit) {
      setError(`本次最多选择 ${selectionLimit} 道题目`);
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setError(null);
  };

  const handleToggleSelectAll = () => {
    const selectableCount = Math.min(parsedQuestions.length, selectionLimit);
    if (selectedIds.size === selectableCount) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(parsedQuestions.slice(0, selectableCount).map((q) => q.tempId)));
    }
    setError(null);
  };

  const handleUpdateQuestion = (id: string, updates: Partial<ParsedQuestion>) => {
    setParsedQuestions((prev) =>
      prev.map((q) => (q.tempId === id ? { ...q, ...updates } : q)),
    );
  };

  const handleDeleteQuestion = (id: string) => {
    setParsedQuestions((prev) => prev.filter((q) => q.tempId !== id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // ==================== AI 识别 ====================

  const handleAiParse = async (ids: string[]) => {
    const selected = selectAiParseQuestions(parsedQuestions, ids);
    const questionsToAiParse = selected.questions;
    if (questionsToAiParse.length === 0) return;

    if (selected.warnings.length > 0) {
      setFileWarnings((prev) => {
        const next = prev.filter((warning) => !selected.warnings.includes(warning));
        return [...next, ...selected.warnings];
      });
    }

    const parsingIds = questionsToAiParse.map((q) => q.tempId);
    setAiParsingIds(new Set(parsingIds));

    try {
      const rawTexts = buildAiParseTexts(questionsToAiParse);

      const response = await questionService.aiParseQuestions(rawTexts);

      // 用 AI 结果替换对应的题目
      setParsedQuestions((prev) => {
        const updated = [...prev];
        for (let i = 0; i < parsingIds.length && i < response.questions.length; i++) {
          const idx = updated.findIndex((q) => q.tempId === parsingIds[i]);
          if (idx !== -1) {
            const aiResult = aiResultToParsedQuestion(
              response.questions[i],
              updated[idx].rawText,
            );
            aiResult.tempId = updated[idx].tempId; // 保持原 ID
            updated[idx] = aiResult;
          }
        }
        return updated;
      });

      log.info('AI 识别完成', { count: response.questions.length });
    } catch (err) {
      log.error('AI 识别失败', err);
      setRequestError(toAppError(err, 'AI 识别失败，请稍后重试。本地解析结果已保留。'));
    } finally {
      setAiParsingIds(new Set());
    }
  };

  // ==================== 执行导入 ====================

  const handleImport = async () => {
    const selectedQuestions = parsedQuestions.filter((q) => selectedIds.has(q.tempId));
    if (selectedQuestions.length === 0) return;

    setStep('importing');
    setError(null);
    setRequestError(null);

    try {
      // 转换为 QuestionCreateData 格式
      const createDataList: QuestionCreateData[] = selectedQuestions.map((q) => ({
        title: q.title || '未命名题目',
        body: q.body,
        type: q.type === 'unknown' ? 'short_answer' : q.type,
        difficulty: q.difficulty,
        conceptIds: [],
        tags: q.tags,
        answer: q.answer || '待补充',
        answerType: q.answerType,
        hints: q.hints,
        solutionSteps: q.solutionSteps,
        options: q.options,
        estimatedTimeSeconds: 300,
      }));

      let totalSuccess = 0;
      let totalFailed = 0;
      const allErrors: string[] = [];

      if (onImportQuestions) {
        const result = await onImportQuestions(createDataList);
        totalSuccess = result.success;
        totalFailed = result.failed;
        allErrors.push(...result.errors);
      } else {
        // 分批导入（每批最多 MAX_BATCH_IMPORT_SIZE）
        for (let i = 0; i < createDataList.length; i += MAX_BATCH_IMPORT_SIZE) {
          const batch = createDataList.slice(i, i + MAX_BATCH_IMPORT_SIZE);
          const result = await questionService.batchImport(batch);
          totalSuccess += result.success;
          totalFailed += result.failed;
          allErrors.push(...result.errors);
        }
      }

      setImportResult({
        success: totalSuccess,
        failed: totalFailed,
        errors: allErrors,
      });
      setStep('done');
      log.info('导入完成', { success: totalSuccess, failed: totalFailed });
    } catch (err) {
      log.error('导入失败', err);
      setRequestError(toAppError(err, '导入失败，请稍后重试'));
      setStep('preview');
    }
  };

  // ==================== 渲染各步骤 ====================

  const renderUploadStep = () => (
    <div className="space-y-4">
      {/* 拖拽上传区域 */}
      <div
        className="border-2 border-dashed border-surface-300 dark:border-surface-600 rounded-xl p-8 text-center cursor-pointer hover:border-primary-400 dark:hover:border-primary-500 transition-colors"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="h-10 w-10 mx-auto mb-3 text-surface-400" />
        <p className="text-surface-700 dark:text-surface-300 font-medium">
          拖拽文件到此处，或点击选择文件
        </p>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
          支持 .docx、.txt 格式，最大 10MB
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".docx,.txt"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFileSelect(f);
          }}
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg text-red-600 dark:text-red-400 text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* 格式说明 */}
      <div className="bg-surface-50 dark:bg-surface-800 rounded-lg p-4 text-sm text-surface-600 dark:text-surface-400">
        <p className="font-medium mb-2">支持的题目格式：</p>
        <ul className="list-disc list-inside space-y-1">
          <li>编号格式：1. / 1、/ (1) / 第一题</li>
          <li>答案标记：答案：/ 解：/ Answer:</li>
          <li>数学公式：$...$ 或 $$...$$（LaTeX 格式）</li>
          <li>选择题选项：A. / B. / C. / D.</li>
        </ul>
      </div>
    </div>
  );

  const renderParsingStep = () => (
    <div className="flex flex-col items-center justify-center py-12">
      <Loader2 className="h-10 w-10 animate-spin text-primary-500 mb-4" />
      <p className="text-surface-700 dark:text-surface-300 font-medium">
        正在解析文件...
      </p>
      {file && (
        <p className="text-sm text-surface-500 mt-1">
          <FileText className="h-4 w-4 inline mr-1" />
          {file.name} ({(file.size / 1024).toFixed(1)} KB)
        </p>
      )}
    </div>
  );

  const renderPreviewStep = () => (
    <div className="space-y-4">
      {/* 文件信息和警告 */}
      {fileWarnings.length > 0 && (
        <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg text-yellow-700 dark:text-yellow-400 text-sm space-y-1">
          {fileWarnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg text-red-600 dark:text-red-400 text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* 预览表格 */}
      <ImportPreviewTable
        questions={parsedQuestions}
        selectedIds={selectedIds}
        aiParsingIds={aiParsingIds}
        allowSelectAll={selectionLimit > 1}
        onToggleSelect={handleToggleSelect}
        onToggleSelectAll={handleToggleSelectAll}
        onUpdateQuestion={handleUpdateQuestion}
        onDeleteQuestion={handleDeleteQuestion}
        onAiParse={handleAiParse}
      />

      {/* 操作按钮 */}
      <div className="flex items-center justify-between pt-2">
        <Button variant="outline" onClick={() => { resetState(); }}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          重新选择文件
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-sm text-surface-500">
            已选择 {selectedIds.size} / {parsedQuestions.length} 道题目
            {Number.isFinite(selectionLimit) ? `，本次最多 ${selectionLimit} 道` : ''}
          </span>
          <Button
            onClick={handleImport}
            disabled={selectedIds.size === 0 || aiParsingIds.size > 0}
          >
            <ArrowRight className="h-4 w-4 mr-1" />
            {importActionLabel}
          </Button>
        </div>
      </div>
    </div>
  );

  const renderImportingStep = () => (
    <div className="flex flex-col items-center justify-center py-12">
      <Loader2 className="h-10 w-10 animate-spin text-primary-500 mb-4" />
      <p className="text-surface-700 dark:text-surface-300 font-medium">
        正在导入题目...
      </p>
      <p className="text-sm text-surface-500 mt-1">
        共 {selectedIds.size} 道题目，请稍候
      </p>
    </div>
  );

  const renderDoneStep = () => (
    <div className="flex flex-col items-center justify-center py-8 space-y-4">
      <CheckCircle className="h-12 w-12 text-green-500" />
      <div className="text-center">
        <p className="text-lg font-medium text-surface-900 dark:text-surface-100">
          导入完成
        </p>
        {importResult && (
          <div className="mt-2 space-y-1 text-sm">
            <p className="text-green-600">成功导入 {importResult.success} 道题目</p>
            {importResult.failed > 0 && (
              <p className="text-red-600">失败 {importResult.failed} 道</p>
            )}
            {importResult.errors.length > 0 && (
              <div className="mt-2 max-h-32 overflow-y-auto text-left bg-red-50 dark:bg-red-900/20 rounded-lg p-2">
                {importResult.errors.slice(0, 5).map((err, i) => (
                  <p key={i} className="text-xs text-red-600 dark:text-red-400">{err}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <Button
        onClick={() => {
          handleClose();
          onImportComplete();
        }}
      >
        {completionActionLabel}
      </Button>
    </div>
  );

  // ==================== 主渲染 ====================

  const stepTitles: Record<ImportStep, string> = {
    upload: '导入题目 - 选择文件',
    parsing: '导入题目 - 解析中',
    preview: '导入题目 - 预览和编辑',
    importing: '导入题目 - 导入中',
    done: '导入题目 - 完成',
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={stepTitles[step]}
      className={step === 'preview' ? 'max-w-4xl' : 'max-w-lg'}
    >
      <div className="relative z-10">
        {requestError ? (
          <RequestErrorNotice
            error={requestError}
            onDismiss={() => setRequestError(null)}
            className="mb-4"
          />
        ) : null}
        {step === 'upload' && renderUploadStep()}
        {step === 'parsing' && renderParsingStep()}
        {step === 'preview' && renderPreviewStep()}
        {step === 'importing' && renderImportingStep()}
        {step === 'done' && renderDoneStep()}
      </div>
    </Modal>
  );
};
