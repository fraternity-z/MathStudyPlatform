import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  Edit3,
  Loader2,
  Plus,
  Send,
  Star,
  Upload,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { RequestErrorNotice } from '@/components/feedback';
import { Button } from '@/components/ui/Button';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { toAppError, type AppError } from '@/libs/http/apiClient';
import { MathText } from '@/libs/math/MathText';
import { questionService } from '@/modules/question/services/questionService';
import type { Question, QuestionCreateData } from '@/modules/question/types/question';
import type { ImportResult } from '@/modules/question/types/questionImport';
import { QuestionImportModal } from '@/pages/teacher/QuestionBankPage/components/QuestionImportModal';

interface PersonalizedQuestionPoolProps {
  classId: string;
}

const questionPageSize = 50;

function difficultyLabel(value: number): string {
  if (value < 0.34) return '简单';
  if (value < 0.67) return '中等';
  return '困难';
}

function questionTypeLabel(value: Question['type']): string {
  if (value === 'multiple_choice') return '选择题';
  if (value === 'proof') return '证明题';
  return '简答题';
}

export function PersonalizedQuestionPool({ classId }: PersonalizedQuestionPoolProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [questionGroups, setQuestionGroups] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [updatingIds, setUpdatingIds] = useState<string[]>([]);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const questionRequestRef = useRef(0);
  const returnPath = `/teacher/class/${encodeURIComponent(classId)}?tab=daily-question`;

  const loadQuestions = useCallback(async (signal?: AbortSignal) => {
    const requestID = questionRequestRef.current + 1;
    questionRequestRef.current = requestID;
    setIsLoading(true);
    setError(null);
    try {
      const [result, groups] = await Promise.all([
        questionService.listQuestions({
          page: currentPage,
          pageSize: questionPageSize,
          group: selectedGroup || undefined,
          status: 'active',
          sortBy: 'created_at',
          sortOrder: 'desc',
        }),
        questionService.getGroups(),
      ]);
      if (!signal?.aborted && questionRequestRef.current === requestID) {
        setQuestions(result.items);
        setQuestionGroups(groups);
        setTotal(result.total);
      }
    } catch (loadError) {
      if (!signal?.aborted && questionRequestRef.current === requestID) {
        setQuestions([]);
        setTotal(0);
        setError(toAppError(loadError, '个性化题库加载失败'));
      }
    } finally {
      if (!signal?.aborted && questionRequestRef.current === requestID) setIsLoading(false);
    }
  }, [currentPage, selectedGroup]);

  const formatRequestError = useCallback((error: unknown, fallback: string): string => {
    const appError = toAppError(error, fallback);
    return [
      appError.message,
      appError.retryAfter !== undefined && appError.retryAfter > 0
        ? `可在 ${appError.retryAfter} 秒后重试`
        : '',
      appError.requestId ? `请求编号：${appError.requestId}` : '',
    ].filter(Boolean).join('；');
  }, []);

  const notifyRequestError = useCallback((error: unknown, fallback: string) => {
    const appError = toAppError(error, fallback);
    if (appError.kind === 'cancelled' || appError.kind === 'rate_limited') return;
    const details = [
      appError.retryAfter !== undefined && appError.retryAfter > 0
        ? `可在 ${appError.retryAfter} 秒后重试`
        : '',
      appError.requestId ? `请求编号：${appError.requestId}` : '',
    ].filter(Boolean);
    toast({
      type: 'error',
      title: appError.message,
      description: details.length > 0 ? details.join('；') : undefined,
    });
  }, [toast]);

  useEffect(() => {
    const controller = new AbortController();
    void loadQuestions(controller.signal);
    return () => controller.abort();
  }, [loadQuestions]);

  useEffect(() => {
    const contentId = searchParams.get('daily_question_content_id')?.trim();
    if (!contentId || isLoading) return;
    let cancelled = false;

    const publishCreatedQuestion = async () => {
      try {
        const created = await questionService.getQuestion(contentId);
        const published = created.status === 'published'
          ? created
          : await questionService.updateQuestion(contentId, { status: 'published' });
        if (cancelled) return;
        if (!selectedGroup || published.title === selectedGroup) {
          setQuestions((current) => [
            published,
            ...current.filter((question) => question.id !== published.id),
          ]);
        }
        if (published.title) {
          setQuestionGroups((current) => current.includes(published.title)
            ? current
            : [...current, published.title].sort((left, right) => left.localeCompare(right, 'zh-CN')));
        }
        toast({ type: 'success', title: '新建题目已发布到个性化题库' });
      } catch (publishError) {
        if (!cancelled) {
          notifyRequestError(publishError, '新建题目发布失败');
        }
      } finally {
        if (!cancelled) {
          const nextParams = new URLSearchParams(searchParams);
          nextParams.delete('daily_question_content_id');
          setSearchParams(nextParams, { replace: true });
        }
      }
    };

    void publishCreatedQuestion();
    return () => {
      cancelled = true;
    };
  }, [isLoading, notifyRequestError, searchParams, selectedGroup, setSearchParams, toast]);

  const updateQuestion = async (questionId: string, operation: () => Promise<void>) => {
    setUpdatingIds((current) => current.includes(questionId) ? current : [...current, questionId]);
    try {
      await operation();
      await loadQuestions();
    } finally {
      setUpdatingIds((current) => current.filter((id) => id !== questionId));
    }
  };

  const publishQuestion = async (question: Question) => {
    try {
      await updateQuestion(question.id, async () => {
        await questionService.updateQuestion(question.id, { status: 'published' });
      });
      toast({ type: 'success', title: '题目已发布到个性化题库' });
    } catch (publishError) {
      notifyRequestError(publishError, '题目发布失败');
    }
  };

  const toggleCandidate = async (question: Question) => {
    try {
      await updateQuestion(question.id, async () => {
        await questionService.setDailyCandidate(question.id, !question.isDailyCandidate);
      });
      toast({
        type: 'success',
        title: question.isDailyCandidate ? '已取消每日候选' : '已设为每日候选',
      });
    } catch (updateError) {
      notifyRequestError(updateError, '候选状态更新失败');
    }
  };

  const importQuestions = async (items: QuestionCreateData[]): Promise<ImportResult> => {
    const createdIds: string[] = [];
    const errors: string[] = [];
    for (const [index, item] of items.entries()) {
      try {
        const created = await questionService.createQuestion(item);
        createdIds.push(created.id);
      } catch (createError) {
        errors.push(`第 ${index + 1} 题：${formatRequestError(createError, '导入失败')}`);
      }
    }

    let publishedCount = 0;
    if (createdIds.length > 0) {
      try {
        const result = await questionService.batchPublish(createdIds);
        publishedCount = result.success;
        errors.push(...result.errors);
      } catch (publishError) {
        errors.push(formatRequestError(publishError, '导入题目已保存为草稿，但发布失败'));
      }
    }

    return {
      success: publishedCount,
      failed: items.length - publishedCount,
      errors,
    };
  };

  const publishedCount = questions.filter((question) => question.status === 'published').length;
  const candidateCount = questions.filter((question) => question.isDailyCandidate).length;
  const totalPages = Math.ceil(total / questionPageSize);

  return (
    <section className="space-y-5 border-y border-surface-200 py-5 dark:border-surface-700">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-surface-700 dark:text-surface-300">
            <BookOpen className="h-4 w-4 text-primary-500" aria-hidden="true" />
            个性化题库
          </h3>
          <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
            每日候选题优先，其次从已发布题库按学生知识点匹配；题目不按固定顺序分配。
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline">本页已发布 {publishedCount}</Badge>
          <Badge variant="outline">本页每日候选 {candidateCount}</Badge>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => navigate(
              `/teacher/question/new?return_to=${encodeURIComponent(returnPath)}`,
            )}
          >
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            新建题目
          </Button>
          <Button variant="outline" onClick={() => setIsImportModalOpen(true)}>
            <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
            导入题目
          </Button>
          <Button variant="ghost" onClick={() => navigate('/teacher/question-bank')}>
            <BookOpen className="mr-2 h-4 w-4" aria-hidden="true" />
            完整题库
          </Button>
        </div>
        <div className="w-full sm:w-48">
          <label
            htmlFor="daily-question-personalized-group"
            className="mb-1.5 block text-xs font-medium text-surface-600 dark:text-surface-400"
          >
            题目分组
          </label>
          <Select
            id="daily-question-personalized-group"
            value={selectedGroup}
            options={[
              { value: '', label: '全部分组' },
              ...questionGroups.map((group) => ({ value: group, label: group })),
            ]}
            onChange={(group) => {
              setSelectedGroup(group);
              setCurrentPage(1);
            }}
          />
        </div>
      </div>

      {error ? (
        <RequestErrorNotice
          error={error}
          onRetry={() => void loadQuestions()}
          onRefresh={() => void loadQuestions()}
        />
      ) : null}

      {isLoading ? (
        <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-surface-500 dark:text-surface-400">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          正在读取题库
        </div>
      ) : questions.length > 0 ? (
        <div className="max-h-96 divide-y divide-surface-200 overflow-y-auto overscroll-contain rounded-md border border-surface-200 dark:divide-surface-700 dark:border-surface-700">
          {questions.map((question) => {
            const isUpdating = updatingIds.includes(question.id);
            return (
              <div
                key={question.id}
                className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="line-clamp-3 text-sm font-medium text-surface-900 dark:text-surface-100">
                    <MathText>{question.body}</MathText>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="max-w-full truncate">
                      {question.title || '未分组'}
                    </Badge>
                    <Badge variant="secondary">{questionTypeLabel(question.type)}</Badge>
                    <Badge variant="outline">{difficultyLabel(question.difficulty)}</Badge>
                    <Badge variant={question.status === 'published' ? 'success' : 'warning'}>
                      {question.status === 'published' ? '已发布' : '草稿'}
                    </Badge>
                    {question.isDailyCandidate ? <Badge variant="warning">每日候选</Badge> : null}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-1">
                  {question.status !== 'published' ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      title="发布到题库"
                      aria-label={`发布 ${question.title || '题目'}`}
                      disabled={isUpdating}
                      onClick={() => void publishQuestion(question)}
                    >
                      <Send className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      title={question.isDailyCandidate ? '取消每日候选' : '设为每日候选'}
                      aria-label={question.isDailyCandidate ? '取消每日候选' : '设为每日候选'}
                      aria-pressed={question.isDailyCandidate}
                      disabled={isUpdating}
                      className={question.isDailyCandidate ? 'text-amber-500' : 'text-surface-400'}
                      onClick={() => void toggleCandidate(question)}
                    >
                      <Star
                        className={`h-4 w-4 ${question.isDailyCandidate ? 'fill-current' : ''}`}
                        aria-hidden="true"
                      />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    title="编辑题目"
                    aria-label={`编辑 ${question.title || '题目'}`}
                    onClick={() => navigate(
                      `/teacher/question/${encodeURIComponent(question.id)}/edit?return_to=${encodeURIComponent(returnPath)}`,
                    )}
                  >
                    <Edit3 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-surface-300 px-4 py-5 text-sm text-surface-500 dark:border-surface-700 dark:text-surface-400">
          {selectedGroup ? '该分组暂无可用题目。' : '题库中暂无可用题目。'}
        </div>
      )}

      {totalPages > 1 ? (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={setCurrentPage}
          className="justify-center"
        />
      ) : null}

      <QuestionImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        importActionLabel="导入并发布到题库"
        completionActionLabel="返回个性化题库"
        onImportQuestions={importQuestions}
        onImportComplete={() => void loadQuestions()}
      />
    </section>
  );
}
