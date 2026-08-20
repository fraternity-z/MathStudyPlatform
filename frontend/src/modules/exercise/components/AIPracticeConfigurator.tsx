import type { FC } from 'react';
import { AlertCircle, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Select, type SelectOption } from '@/components/ui/Select';
import type { GenerateQuestionType } from '@/modules/exercise/services/exerciseService';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/appError';

const difficultyOptions: SelectOption[] = [
  { value: '0.15', label: '简单' },
  { value: '0.5', label: '中等' },
  { value: '0.85', label: '困难' },
];

const questionTypeOptions: SelectOption[] = [
  { value: 'multiple_choice', label: '选择题' },
  { value: 'short_answer', label: '填空题' },
];

export interface AIPracticeConfiguratorProps {
  knowledgeOptions: SelectOption[];
  selectedConceptId: string;
  difficulty: number;
  questionType: GenerateQuestionType;
  isLoadingKnowledge: boolean;
  isGenerating: boolean;
  isSubmitting: boolean;
  error: AppError | string | null;
  hasQuestion: boolean;
  onConceptChange: (conceptId: string) => void;
  onDifficultyChange: (difficulty: number) => void;
  onQuestionTypeChange: (questionType: GenerateQuestionType) => void;
  onGenerate: () => void | Promise<void>;
  onRetryKnowledge?: () => void | Promise<void>;
}

export const AIPracticeConfigurator: FC<AIPracticeConfiguratorProps> = ({
  knowledgeOptions,
  selectedConceptId,
  difficulty,
  questionType,
  isLoadingKnowledge,
  isGenerating,
  isSubmitting,
  error,
  hasQuestion,
  onConceptChange,
  onDifficultyChange,
  onQuestionTypeChange,
  onGenerate,
  onRetryKnowledge,
}) => {
  const hasKnowledgeOptions = knowledgeOptions.length > 0;
  const isPending = isLoadingKnowledge || isGenerating;
  const errorMessage = typeof error === 'string' ? error : error?.message;
  const canRetryKnowledge = Boolean(error) && !hasKnowledgeOptions && !isLoadingKnowledge;
  const isDisabled =
    isPending ||
    isSubmitting ||
    (canRetryKnowledge ? !onRetryKnowledge : !hasKnowledgeOptions || !selectedConceptId);

  return (
    <Card className="border-primary-200 dark:border-primary-800">
      <CardHeader className="border-b border-surface-100 p-5 dark:border-surface-800">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sparkles className="h-5 w-5 text-primary-500" aria-hidden="true" />
          AI 自主练习
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto] sm:items-end">
        <div className="min-w-0 space-y-1.5">
          <label
            htmlFor="ai-practice-concept"
            className="text-sm font-medium text-surface-700 dark:text-surface-300"
          >
            知识点
          </label>
          <Select
            id="ai-practice-concept"
            options={knowledgeOptions}
            placeholder={isLoadingKnowledge ? '正在加载知识点...' : '请选择知识点'}
            value={selectedConceptId}
            onChange={onConceptChange}
            disabled={isLoadingKnowledge || !hasKnowledgeOptions}
            aria-describedby={error ? 'ai-practice-error' : undefined}
          />
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="ai-practice-question-type"
            className="text-sm font-medium text-surface-700 dark:text-surface-300"
          >
            题型
          </label>
          <Select
            id="ai-practice-question-type"
            options={questionTypeOptions}
            value={questionType}
            onChange={(value) => onQuestionTypeChange(value as GenerateQuestionType)}
            disabled={isLoadingKnowledge || isGenerating}
          />
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="ai-practice-difficulty"
            className="text-sm font-medium text-surface-700 dark:text-surface-300"
          >
            难度
          </label>
          <Select
            id="ai-practice-difficulty"
            options={difficultyOptions}
            value={String(difficulty)}
            onChange={(value) => onDifficultyChange(Number(value))}
            disabled={isLoadingKnowledge || isGenerating}
          />
        </div>

        <Button
          type="button"
          onClick={canRetryKnowledge ? onRetryKnowledge : onGenerate}
          isLoading={isPending}
          disabled={isDisabled}
          className="w-full whitespace-nowrap sm:w-auto"
        >
          {!isPending &&
            (canRetryKnowledge || hasQuestion ? (
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />
            ))}
          {canRetryKnowledge
            ? '重试加载'
            : isLoadingKnowledge
              ? '加载知识点'
              : hasQuestion
                ? '重新生成'
                : '生成题目'}
        </Button>

        {error ? (
          typeof error === 'string' ? (
          <div
            id="ai-practice-error"
            role="alert"
            className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 sm:col-span-4"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
          ) : (
            <RequestErrorNotice
              error={error}
              onRetry={canRetryKnowledge ? onRetryKnowledge : undefined}
              onRefresh={error.kind === 'conflict' ? onRetryKnowledge : undefined}
              className="sm:col-span-4"
            />
          )
        ) : null}
      </CardContent>
    </Card>
  );
};
