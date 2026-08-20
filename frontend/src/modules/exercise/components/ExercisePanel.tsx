import React, { useCallback, useState } from 'react';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Lightbulb,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { EmptyExerciseState } from './EmptyExerciseState';
import { AnswerImageInput } from './AnswerImageInput';
import { ExerciseMathContent } from './ExerciseMathContent';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/appError';
import type {
  ExerciseSolution,
  Question,
  SubmitResult,
} from '@/modules/exercise/services/exerciseService';
import type {
  ExerciseAnswerSubmission,
  ExerciseErrorSource,
  ExerciseErrorType,
  SubmitPhase,
} from '../hooks/exerciseViewModel';

const questionTypeLabels: Record<Question['type'], string> = {
  multiple_choice: '选择题',
  short_answer: '简答题',
  proof: '证明题',
};
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const renderMathContent = (
  value: string,
  options: { className?: string; block?: boolean } = {},
) => (
  <ExerciseMathContent
    value={value}
    className={options.className}
    block={options.block}
  />
);

export interface ExercisePanelProps {
  currentQuestion: Question | null;
  isLoading: boolean;
  isSubmitting: boolean;
  submitPhase: SubmitPhase;
  submitResult: SubmitResult | null;
  solution: ExerciseSolution | null;
  isLoadingSolution: boolean;
  solutionError: AppError | null;
  error: AppError | null;
  errorType: ExerciseErrorType | null;
  errorSource?: ExerciseErrorSource | null;
  onNextQuestion: () => void | Promise<void>;
  submitAnswer: (submission: ExerciseAnswerSubmission) => Promise<void>;
  onLoadSolution: () => void | Promise<void>;
  nextButtonLabel?: string;
  resetKey?: string | number;
}

const ExercisePanelContent: React.FC<ExercisePanelProps> = ({
  currentQuestion,
  isLoading,
  isSubmitting,
  submitPhase,
  submitResult,
  solution,
  isLoadingSolution,
  solutionError,
  error,
  errorType,
  errorSource,
  onNextQuestion,
  submitAnswer,
  onLoadSolution,
  nextButtonLabel = '下一题',
}) => {
  const [answer, setAnswer] = useState('');
  const [answerImage, setAnswerImage] = useState<File | null>(null);
  const [submittedWithImage, setSubmittedWithImage] = useState(false);
  const [lastSubmission, setLastSubmission] = useState<{
    answerText: string;
    answerImage: File | null;
  } | null>(null);

  // 提交答案
  const handleSubmit = useCallback(async () => {
    const normalizedAnswer = answer.trim();
    if (!normalizedAnswer && !answerImage) return;

    const isImageOnly = !normalizedAnswer && Boolean(answerImage);
    setSubmittedWithImage(isImageOnly);
    setLastSubmission({
      answerText: normalizedAnswer,
      answerImage: normalizedAnswer ? null : answerImage,
    });
    await submitAnswer(
      normalizedAnswer
        ? { answerText: normalizedAnswer }
        : { answerImage }
    );
  }, [answer, answerImage, submitAnswer]);

  // 下一题
  const handleNext = useCallback(async () => {
    await onNextQuestion();
  }, [onNextQuestion]);

  const handleLoadSolution = useCallback(async () => {
    await onLoadSolution();
  }, [onLoadSolution]);

  const handleRetryError = useCallback(async () => {
    if (errorSource !== 'submission' || !lastSubmission) {
      await onNextQuestion();
      return;
    }

    setSubmittedWithImage(
      !lastSubmission.answerText && Boolean(lastSubmission.answerImage),
    );
    await submitAnswer(
      lastSubmission.answerText
        ? { answerText: lastSubmission.answerText }
        : { answerImage: lastSubmission.answerImage },
    );
  }, [errorSource, lastSubmission, onNextQuestion, submitAnswer]);

  // ========== 渲染 ==========

  if (isLoading && !currentQuestion) {
    return (
      <div className="flex justify-center p-10">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
      </div>
    );
  }

  // 使用新的空状态组件处理错误
  if (!currentQuestion && errorType) {
    return (
      <EmptyExerciseState
        errorType={errorType}
        requestError={error}
        errorMessage={error?.message}
        onRetry={
          errorType === 'network_error' ||
          errorType === 'generation_unavailable' ||
          errorType === 'unknown'
            ? onNextQuestion
            : undefined
        }
      />
    );
  }

  if (!currentQuestion) {
    return <div className="p-4 text-center text-surface-500">暂无可用题目</div>;
  }

  const isBusy = isSubmitting || isLoading;
  const isIndeterminate = Boolean(
    submitResult &&
      (submitResult.recorded === false || submitResult.gradingStatus === 'indeterminate')
  );
  const hasRecordedResult = Boolean(submitResult && !isIndeterminate);
  const hasVerifiedSolution = Boolean(
    solution && solution.source !== 'unavailable' && solution.steps.length > 0
  );
  const solutionUnavailableMessage = solution && !hasVerifiedSolution
    ? solution.failure?.message || '暂无法提供经过验证的解题步骤'
    : null;
  const isNonRetryableIndeterminate = Boolean(
    isIndeterminate && submitResult?.evaluation?.retryable === false
  );
  const exerciseChanged = errorType === 'exercise_changed';
  const normalizedAnswer = answer.trim();
  const hasChangedSinceLastSubmission = Boolean(
    !lastSubmission ||
      (normalizedAnswer
        ? lastSubmission.answerText !== normalizedAnswer
        : lastSubmission.answerText !== '' || lastSubmission.answerImage !== answerImage)
  );
  const canSubmit = Boolean(
    (normalizedAnswer || (currentQuestion.type !== 'multiple_choice' && answerImage)) &&
      (!isNonRetryableIndeterminate || hasChangedSinceLastSubmission)
  );
  const submitButtonLabel = isBusy
    ? submitPhase === 'uploading'
      ? '上传中'
      : submittedWithImage
        ? '识别中'
        : '判定中'
    : exerciseChanged
      ? '重新加载题目'
      : isNonRetryableIndeterminate
        ? hasChangedSinceLastSubmission
          ? '提交修改后的答案'
          : '请修改答案后提交'
      : isIndeterminate || error
        ? '重试提交'
        : '提交答案';
  const knowledgePointLabels = new Map(
    currentQuestion.knowledgePoints.map((conceptId, index) => [
      conceptId,
      (() => {
        const name = currentQuestion.knowledgePointNames[index]?.trim();
        return name && !uuidPattern.test(name) ? name : '当前知识点';
      })(),
    ]),
  );

  return (
    <div className="min-w-0 max-w-full space-y-6 animate-fade-in">
      {/* 题目卡片 */}
      <Card className="border-primary-100 dark:border-primary-900 shadow-md overflow-hidden">
        <CardHeader className="bg-primary-50/50 dark:bg-primary-950/50 border-b border-primary-100 dark:border-primary-900">
          <CardTitle className="text-lg text-primary-900 dark:text-primary-100 flex justify-between items-center">
            <span>{currentQuestion.title || '练习题'}</span>
            <div className="flex items-center gap-2">
              <span className="text-xs font-normal text-surface-500 dark:text-surface-400">
                难度 {Math.round(currentQuestion.difficulty * 100)}%
              </span>
              <span className="rounded-full bg-primary-100 px-2 py-1 text-xs font-normal text-primary-600 dark:bg-primary-900 dark:text-primary-400">
                {questionTypeLabels[currentQuestion.type]}
              </span>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          {/* 题目内容 */}
          <div className="text-lg text-surface-800 dark:text-surface-200 mb-6 leading-relaxed">
            {renderMathContent(currentQuestion.content, { block: true })}
          </div>

          {/* 答案输入区 */}
          <div className="space-y-4">
            {currentQuestion.type === 'multiple_choice' &&
            (currentQuestion.options?.length ?? 0) > 0 ? (
              <fieldset disabled={isBusy || hasRecordedResult}>
                <legend className="sr-only">选择答案</legend>
                <div role="radiogroup" aria-label="答案选项" className="grid gap-3">
                  {(currentQuestion.options ?? []).map((option, index) => {
                    const optionId = `exercise-${currentQuestion.id}-option-${index}`;
                    const isSelected = answer === option;
                    return (
                      <label
                        key={optionId}
                        htmlFor={optionId}
                        className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-md border px-4 py-3 transition-colors ${
                          isSelected
                            ? 'border-primary-500 bg-primary-50 text-primary-900 dark:bg-primary-950/40 dark:text-primary-100'
                            : 'border-surface-200 bg-white text-surface-800 hover:border-primary-300 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-200'
                        }`}
                      >
                        <input
                          id={optionId}
                          type="radio"
                          name={`exercise-${currentQuestion.id}-answer`}
                          value={option}
                          checked={isSelected}
                          onChange={(event) => setAnswer(event.target.value)}
                          className="h-4 w-4 shrink-0 accent-primary-600"
                        />
                        <span className="w-5 shrink-0 text-sm font-semibold text-surface-500">
                          {String.fromCharCode(65 + index)}.
                        </span>
                        {renderMathContent(option, { className: 'min-w-0' })}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ) : (
              <div className="space-y-3">
                <Input
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder="输入答案（支持 LaTeX 格式，如 \frac{x^3}{3} + C）"
                  className="text-lg"
                  disabled={isBusy || hasRecordedResult}
                />
                {currentQuestion.type !== 'multiple_choice' ? (
                  <AnswerImageInput
                    file={answerImage}
                    disabled={isBusy || hasRecordedResult}
                    onChange={setAnswerImage}
                  />
                ) : null}
              </div>
            )}
          </div>
        </CardContent>
        <CardFooter className="bg-surface-50 dark:bg-surface-800 p-4 flex justify-between items-center">
          {!hasRecordedResult ? (
            <Button
              onClick={exerciseChanged ? handleNext : handleSubmit}
              isLoading={isBusy}
              disabled={(!exerciseChanged && !canSubmit) || isBusy}
              className="w-full sm:w-auto"
            >
              {submitButtonLabel}
            </Button>
          ) : (
            <Button
              onClick={handleNext}
              variant="secondary"
              isLoading={isLoading}
              disabled={isLoading}
            >
              {nextButtonLabel}
            </Button>
          )}
        </CardFooter>
      </Card>

      {/* 反馈卡片 */}
      {submitResult ? (
        <Card
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={`min-w-0 max-w-full overflow-hidden animate-slide-up border-l-4 ${
            isIndeterminate
              ? 'border-l-amber-500 bg-amber-50 dark:bg-amber-950/30'
              : submitResult.isCorrect
              ? 'border-l-green-500 bg-green-50 dark:bg-green-950/30'
              : 'border-l-red-500 bg-red-50 dark:bg-red-950/30'
          }`}
        >
          <CardContent className="min-w-0 space-y-3 overflow-hidden p-4 [overflow-wrap:anywhere]">
            <h4
              className={`flex items-center gap-2 font-bold text-lg ${
                isIndeterminate
                  ? 'text-amber-800 dark:text-amber-400'
                  : submitResult.isCorrect
                  ? 'text-green-800 dark:text-green-400'
                  : 'text-red-800 dark:text-red-400'
              }`}
            >
              {isIndeterminate ? (
                <AlertCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
              ) : submitResult.isCorrect ? (
                <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
              ) : (
                <XCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
              )}
              <span>
                {isIndeterminate
                  ? '暂无法自动判定'
                  : submitResult.isCorrect
                    ? '回答正确'
                    : '回答错误'}
              </span>
            </h4>

            {/* 反馈文本 */}
            <div className="text-surface-700 dark:text-surface-300">
              {renderMathContent(
                isIndeterminate
                  ? submitResult.evaluation?.reason || submitResult.feedback
                  : submitResult.feedback
              )}
            </div>

            {(submitResult.evaluation?.evidence.length ?? 0) > 0 ? (
              <div className="border-t border-surface-200 pt-3 dark:border-surface-700">
                <p className="mb-1 text-sm font-medium text-surface-600 dark:text-surface-300">
                  判定依据：
                </p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-surface-600 dark:text-surface-400">
                  {submitResult.evaluation?.evidence.map((item, index) => (
                    <li key={`${item.kind}-${index}`}>
                      {renderMathContent(item.summary)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {submittedWithImage && submitResult.studentAnswerLatex ? (
              <div className="rounded-md bg-white/60 p-3 dark:bg-surface-900/50">
                <span className="text-sm font-medium text-surface-500">图片识别结果：</span>
                {renderMathContent(submitResult.studentAnswerLatex, { block: true })}
              </div>
            ) : null}

            {/* 正确答案 */}
            {!isIndeterminate && !submitResult.isCorrect && submitResult.correctAnswerLatex && (
              <div className="mt-2 p-3 bg-white/50 dark:bg-surface-900/50 rounded-lg">
                <span className="text-sm font-medium text-surface-500">正确答案：</span>
                {renderMathContent(submitResult.correctAnswerLatex, { block: true })}
              </div>
            )}

            {/* 诊断详情 */}
            {!isIndeterminate && submitResult.diagnosis && (
              <div className="mt-2 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-400 mb-1">
                  错误类型：{submitResult.diagnosis.errorType || '未知'}
                  {submitResult.diagnosis.severity && (
                    <span className="ml-2 text-xs opacity-75">
                      ({submitResult.diagnosis.severity})
                    </span>
                  )}
                </p>
                {submitResult.diagnosis.suggestion && (
                  <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300">
                    <Lightbulb className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{submitResult.diagnosis.suggestion}</span>
                  </p>
                )}
              </div>
            )}

            {/* 掌握度变化 */}
            {!isIndeterminate && submitResult.masteryUpdate && Object.keys(submitResult.masteryUpdate).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(submitResult.masteryUpdate).map(([concept, mastery]) => (
                  <span
                    key={concept}
                    className="text-xs px-2 py-1 rounded-full bg-primary-100 dark:bg-primary-900 text-primary-700 dark:text-primary-300"
                  >
                    {knowledgePointLabels.get(concept) || '当前知识点'}: {Math.round(mastery * 100)}%
                  </span>
                ))}
              </div>
            )}

            {hasRecordedResult ? (
              <div className="border-t border-surface-200 pt-3 dark:border-surface-700">
                {hasVerifiedSolution && solution ? (
                  <div className="space-y-3">
                    <h5 className="flex items-center gap-2 font-semibold text-surface-800 dark:text-surface-200">
                      <BookOpen className="h-4 w-4" aria-hidden="true" />
                      解题解析
                    </h5>
                    <ol className="list-decimal space-y-2 pl-5 text-sm text-surface-700 dark:text-surface-300">
                      {solution.steps.map((step, index) => (
                        <li key={`${index}-${step}`}>{renderMathContent(step)}</li>
                      ))}
                    </ol>
                    {solution.answer ? (
                      <div className="rounded-md bg-white/60 p-3 dark:bg-surface-900/50">
                        <span className="text-sm font-medium text-surface-500">标准答案：</span>
                        {renderMathContent(solution.answer, { block: true })}
                      </div>
                    ) : null}
                  </div>
                ) : solutionUnavailableMessage ? (
                  <div className="space-y-2">
                    <p className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>{solutionUnavailableMessage}</span>
                    </p>
                    {solution?.verification?.reason ? (
                      <p className="text-sm text-surface-600 dark:text-surface-400">
                        {solution.verification.reason}
                      </p>
                    ) : null}
                    {(solution?.verification?.evidence.length ?? 0) > 0 ? (
                      <ul className="list-disc space-y-1 pl-5 text-sm text-surface-600 dark:text-surface-400">
                        {solution?.verification?.evidence.map((item, index) => (
                          <li key={`${item.kind}-${index}`}>{renderMathContent(item.summary)}</li>
                        ))}
                      </ul>
                    ) : null}
                    {solution?.failure?.retryable ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleLoadSolution}
                        isLoading={isLoadingSolution}
                      >
                        {!isLoadingSolution ? (
                          <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
                        ) : null}
                        重试解析
                      </Button>
                    ) : null}
                  </div>
                ) : solutionError ? (
                  <div className="space-y-2">
                    <RequestErrorNotice
                      error={solutionError}
                      onRetry={solutionError.retryable ? handleLoadSolution : undefined}
                    />
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleLoadSolution}
                    isLoading={isLoadingSolution}
                  >
                    {!isLoadingSolution ? (
                      <BookOpen className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    ) : null}
                    {isLoadingSolution ? '正在获取解析' : '查看解析'}
                  </Button>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* 错误提示 */}
      {error ? (
        <RequestErrorNotice
          error={error}
          onRetry={error.retryable ? handleRetryError : undefined}
          onRefresh={error.kind === 'conflict' ? onNextQuestion : undefined}
        />
      ) : null}
    </div>
  );
};

export const ExercisePanel: React.FC<ExercisePanelProps> = (props) => (
  <ExercisePanelContent
    key={`${props.currentQuestion?.id ?? 'no-question'}:${props.resetKey ?? 'default'}`}
    {...props}
  />
);
