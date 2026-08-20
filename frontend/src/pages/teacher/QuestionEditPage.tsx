import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { MainLayout } from '../../components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { ArrowLeft, Save, Loader2, Plus, Trash2, Edit } from 'lucide-react';
import { questionService } from '@/modules/question/services/questionService';
import type { Question, QuestionCreateData, QuestionUpdateData } from '@/modules/question/types/question';
import { useToast } from '../../components/ui/Toast';
import { toAppError, type AppError } from '@/libs/http/apiClient';

// 表单验证 Schema
const questionSchema = z.object({
  title: z.string().min(1, '题目分组不能为空').max(500, '分组名最多500字符'),
  body: z.string().min(1, '题目内容不能为空'),
  type: z.string().min(1, '请选择题型'),
  difficulty: z.number().min(0).max(1),
  conceptIds: z.array(z.string()),
  tags: z.array(z.string()),
  answer: z.string().min(1, '标准答案不能为空'),
  answerType: z.string(),
  hints: z.array(z.string()),
  solutionSteps: z.array(z.string()),
  options: z.array(z.string()).optional(),
  estimatedTimeSeconds: z.number().min(0),
});

type QuestionFormData = z.infer<typeof questionSchema>;

const difficultyOptions = [
  { value: '0.15', label: '简单' },
  { value: '0.5', label: '中等' },
  { value: '0.85', label: '困难' },
];

const typeOptions = [
  { value: 'short_answer', label: '简答题' },
  { value: 'multiple_choice', label: '选择题' },
  { value: 'proof', label: '证明题' },
];

function getSafeTeacherReturnPath(value: string | null): string | null {
  if (!value || !value.startsWith('/teacher/') || value.startsWith('//')) return null;
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith('/teacher/')) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function appendCreatedQuestion(returnPath: string, questionId: string): string {
  const parsed = new URL(returnPath, window.location.origin);
  parsed.searchParams.set('daily_question_content_id', questionId);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export const QuestionEditPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isNew = !id || id === 'new';
  const isViewMode = searchParams.get('mode') === 'view';
  const returnPath = getSafeTeacherReturnPath(searchParams.get('return_to'));
  const exitPath = returnPath ?? '/teacher/question-bank';
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [, setQuestion] = useState<Question | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [groupsError, setGroupsError] = useState<AppError | null>(null);
  const [groupsReloadKey, setGroupsReloadKey] = useState(0);
  const loadRequestRef = useRef(0);

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = useForm<QuestionFormData>({
    resolver: zodResolver(questionSchema),
    defaultValues: {
      title: '',
      body: '',
      type: 'short_answer',
      difficulty: 0.5,
      conceptIds: [],
      tags: [],
      answer: '',
      answerType: 'expression',
      hints: [''],
      solutionSteps: [''],
      estimatedTimeSeconds: 300,
    },
  });

  const watchedType = watch('type');
  const watchedHints = watch('hints');
  const watchedSolutionSteps = watch('solutionSteps');
  const watchedOptions = watch('options');

  // 加载题目数据（编辑模式）
  const loadQuestion = useCallback(async (questionId: string) => {
    const requestID = loadRequestRef.current + 1;
    loadRequestRef.current = requestID;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await questionService.getQuestion(questionId);
      if (loadRequestRef.current !== requestID) return;
      setQuestion(data);

      // 填充表单
      reset({
        title: data.title,
        body: data.body,
        type: data.type,
        difficulty: data.difficulty,
        conceptIds: data.conceptIds,
        tags: data.tags,
        answer: data.meta.answer,
        answerType: data.meta.answerType,
        hints: data.meta.hints.length > 0 ? data.meta.hints : [''],
        solutionSteps: data.meta.solutionSteps.length > 0 ? data.meta.solutionSteps : [''],
        options: data.meta.options,
        estimatedTimeSeconds: data.meta.estimatedTimeSeconds,
      });
    } catch (error: unknown) {
      if (loadRequestRef.current === requestID) {
        setLoadError(toAppError(error, '加载题目失败'));
      }
    } finally {
      if (loadRequestRef.current === requestID) setLoading(false);
    }
  }, [reset]);

  useEffect(() => {
    if (!isNew && id) {
      void loadQuestion(id);
    }
    return () => { loadRequestRef.current += 1; };
  }, [id, isNew, loadQuestion]);

  // 加载分组列表
  useEffect(() => {
    let active = true;
    setGroupsError(null);
    questionService.getGroups().then((nextGroups) => {
      if (active) setGroups(nextGroups);
    }).catch((error: unknown) => {
      if (active) setGroupsError(toAppError(error, '题目分组加载失败'));
    });
    return () => { active = false; };
  }, [groupsReloadKey]);

  const notifyRequestError = useCallback((requestError: unknown, fallback: string) => {
    const appError = toAppError(requestError, fallback);
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

  const onSubmit = async (data: QuestionFormData) => {
    setSaving(true);
    try {
      // 过滤空的提示和步骤
      const filteredHints = data.hints.filter((h) => h.trim() !== '');
      const filteredSteps = data.solutionSteps.filter((s) => s.trim() !== '');

      const payload: QuestionCreateData | QuestionUpdateData = {
        title: data.title,
        body: data.body,
        type: data.type,
        difficulty: data.difficulty,
        conceptIds: data.conceptIds,
        tags: data.tags,
        answer: data.answer,
        answerType: data.answerType,
        hints: filteredHints,
        solutionSteps: filteredSteps,
        options: data.type === 'multiple_choice' ? data.options : undefined,
        estimatedTimeSeconds: data.estimatedTimeSeconds,
      };

      let createdQuestionId: string | null = null;
      if (isNew) {
        const created = await questionService.createQuestion(payload as QuestionCreateData);
        createdQuestionId = created.id;
        toast({ type: 'success', title: '题目创建成功' });
      } else {
        await questionService.updateQuestion(id!, payload);
        toast({ type: 'success', title: '题目更新成功' });
      }

      navigate(
        returnPath && createdQuestionId
          ? appendCreatedQuestion(returnPath, createdQuestionId)
          : exitPath,
      );
    } catch (error: unknown) {
      notifyRequestError(error, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const addHint = () => {
    setValue('hints', [...watchedHints, '']);
  };

  const removeHint = (index: number) => {
    setValue(
      'hints',
      watchedHints.filter((_, i) => i !== index)
    );
  };

  const updateHint = (index: number, value: string) => {
    const newHints = [...watchedHints];
    newHints[index] = value;
    setValue('hints', newHints);
  };

  const addSolutionStep = () => {
    setValue('solutionSteps', [...watchedSolutionSteps, '']);
  };

  const removeSolutionStep = (index: number) => {
    setValue(
      'solutionSteps',
      watchedSolutionSteps.filter((_, i) => i !== index)
    );
  };

  const updateSolutionStep = (index: number, value: string) => {
    const newSteps = [...watchedSolutionSteps];
    newSteps[index] = value;
    setValue('solutionSteps', newSteps);
  };

  const addOption = () => {
    setValue('options', [...(watchedOptions || []), '']);
  };

  const removeOption = (index: number) => {
    setValue(
      'options',
      (watchedOptions || []).filter((_, i) => i !== index)
    );
  };

  const updateOption = (index: number, value: string) => {
    const newOptions = [...(watchedOptions || [])];
    newOptions[index] = value;
    setValue('options', newOptions);
  };

  if (loading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
        </div>
      </MainLayout>
    );
  }

  if (loadError) {
    return (
      <MainLayout>
        <div className="container mx-auto max-w-2xl px-6 py-20">
          <RequestErrorNotice
            error={loadError}
            onRetry={id ? () => void loadQuestion(id) : undefined}
            onRefresh={id ? () => void loadQuestion(id) : undefined}
          />
          <Button variant="outline" className="mt-4" onClick={() => navigate(exitPath)}>
            返回题库
          </Button>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="container mx-auto px-6 py-8 max-w-5xl">
        {/* 页面标题 */}
        <div className="mb-8">
          <Button
            variant="ghost"
            className="mb-4"
            onClick={() => navigate(exitPath)}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            {returnPath ? '返回每日一题' : '返回题库'}
          </Button>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-2">
                {isNew ? '新建题目' : isViewMode ? '查看题目' : '编辑题目'}
              </h1>
              <p className="text-surface-500 dark:text-surface-400">
                {isNew ? '创建新的数学题目' : isViewMode ? `查看题目详情 #${id}` : `编辑题目 #${id}`}
              </p>
            </div>
            {isViewMode && (
              <Button onClick={() => navigate(`/teacher/question/${id}/edit`)}>
                <Edit className="h-4 w-4 mr-2" />
                编辑题目
              </Button>
            )}
          </div>
        </div>

        {groupsError ? (
          <RequestErrorNotice
            error={groupsError}
            onRetry={() => setGroupsReloadKey((key) => key + 1)}
            onRefresh={() => setGroupsReloadKey((key) => key + 1)}
            onDismiss={() => setGroupsError(null)}
            className="mb-6"
          />
        ) : null}

        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* 主编辑区 */}
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>题目信息</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* 题目分组 */}
                  <div>
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
                      题目分组 <span className="text-red-500">*</span>
                    </label>
                    <Input {...register('title')} placeholder="选择或输入分组名（如：极限与连续）" list="group-options" disabled={isViewMode} />
                    <datalist id="group-options">
                      {groups.map((g) => (
                        <option key={g} value={g} />
                      ))}
                    </datalist>
                    {errors.title && (
                      <p className="text-xs text-red-500 mt-1">{errors.title.message}</p>
                    )}
                    <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
                      保存时将根据分组名自动匹配关联知识点
                    </p>
                  </div>

                  {/* 题目内容 */}
                  <div>
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
                      题目内容 <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      {...register('body')}
                      placeholder="输入题目内容，支持 LaTeX 公式（用 $ 包裹）"
                      disabled={isViewMode}
                      className="w-full h-32 px-3 py-2 rounded-md border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    {errors.body && (
                      <p className="text-xs text-red-500 mt-1">{errors.body.message}</p>
                    )}
                    <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                      支持 LaTeX 数学公式，例如：$\int_0^1 x^2 dx$
                    </p>
                  </div>

                  {/* 选择题选项 */}
                  {watchedType === 'multiple_choice' && (
                    <div>
                      <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
                        选项
                      </label>
                      <div className="space-y-2">
                        {(watchedOptions || []).map((option, index) => (
                          <div key={index} className="flex items-center gap-2">
                            <span className="text-sm font-medium w-6">
                              {String.fromCharCode(65 + index)}.
                            </span>
                            <Input
                              value={option}
                              onChange={(e) => updateOption(index, e.target.value)}
                              placeholder={`选项 ${String.fromCharCode(65 + index)}`}
                              className="flex-1"
                              disabled={isViewMode}
                            />
                            {!isViewMode && (watchedOptions || []).length > 2 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeOption(index)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                      {!isViewMode && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={addOption}
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          添加选项
                        </Button>
                      )}
                    </div>
                  )}

                  {/* 标准答案 */}
                  <div>
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
                      标准答案 <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      {...register('answer')}
                      placeholder="输入标准答案（支持 LaTeX）"
                      disabled={isViewMode}
                      className="w-full h-24 px-3 py-2 rounded-md border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    {errors.answer && (
                      <p className="text-xs text-red-500 mt-1">{errors.answer.message}</p>
                    )}
                  </div>

                  {/* 解题步骤 */}
                  <div>
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
                      解题步骤
                    </label>
                    <div className="space-y-2">
                      {watchedSolutionSteps.map((step, index) => (
                        <div key={index} className="flex items-start gap-2">
                          <span className="text-sm font-medium w-6 mt-2">{index + 1}.</span>
                          <textarea
                            value={step}
                            onChange={(e) => updateSolutionStep(index, e.target.value)}
                            placeholder={`步骤 ${index + 1}`}
                            disabled={isViewMode}
                            className="flex-1 h-20 px-3 py-2 rounded-md border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          {!isViewMode && watchedSolutionSteps.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeSolutionStep(index)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                    {!isViewMode && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={addSolutionStep}
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        添加步骤
                      </Button>
                    )}
                  </div>

                  {/* 提示 */}
                  <div>
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
                      提示（苏格拉底式引导）
                    </label>
                    <div className="space-y-2">
                      {watchedHints.map((hint, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <Input
                            value={hint}
                            onChange={(e) => updateHint(index, e.target.value)}
                            placeholder={`提示 ${index + 1}`}
                            className="flex-1"
                            disabled={isViewMode}
                          />
                          {!isViewMode && watchedHints.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeHint(index)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                    {!isViewMode && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={addHint}
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        添加提示
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* 侧边栏设置 */}
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>题目设置</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* 题型 */}
                  <div>
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
                      题型
                    </label>
                    <Select
                      value={watch('type')}
                      onChange={(value) => setValue('type', value)}
                      options={typeOptions}
                      disabled={isViewMode}
                    />
                  </div>

                  {/* 难度 */}
                  <div>
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
                      难度
                    </label>
                    <Select
                      value={String(watch('difficulty'))}
                      onChange={(value) => setValue('difficulty', parseFloat(value))}
                      options={difficultyOptions}
                      disabled={isViewMode}
                    />
                  </div>

                  {/* 预计时间 */}
                  <div>
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2 block">
                      预计时间（秒）
                    </label>
                    <Input
                      type="number"
                      {...register('estimatedTimeSeconds', { valueAsNumber: true })}
                      placeholder="300"
                      disabled={isViewMode}
                    />
                  </div>

                  {/* 保存按钮 */}
                  {!isViewMode && (
                    <Button type="submit" className="w-full" disabled={saving}>
                      {saving ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          保存中...
                        </>
                      ) : (
                        <>
                          <Save className="h-4 w-4 mr-2" />
                          保存题目
                        </>
                      )}
                    </Button>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </form>
      </div>
    </MainLayout>
  );
};
