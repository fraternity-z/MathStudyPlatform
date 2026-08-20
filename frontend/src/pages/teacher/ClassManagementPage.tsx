import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { MainLayout } from '../../components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { classService } from '@/modules/classroom/services/classService';
import type { ClassInfo } from '@/modules/classroom/types/classroom';
import { Plus, ChevronRight, Copy, Check } from 'lucide-react';
import { useToast } from '../../components/ui/Toast';
import { classCreationSchema, type ClassCreationFormData } from './schemas';
import { toAppError, type AppError } from '@/libs/http/apiClient';

export const ClassManagementPage: React.FC = () => {
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const navigate = useNavigate();
  const { toast } = useToast();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<ClassCreationFormData>({
    resolver: zodResolver(classCreationSchema),
    defaultValues: {
      name: '',
      description: '',
    },
  });

  const handleCloseCreate = () => {
    setIsCreateOpen(false);
    reset();
    clearErrors();
  };

  const handleCopyCode = async (e: React.MouseEvent, classId: string, code: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(classId);
      toast({ type: 'success', title: '班级号已复制', duration: 2000 });
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast({ type: 'error', title: '复制失败，请手动复制' });
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const loadClasses = async () => {
      try {
        const response = await classService.listTeacherClasses(controller.signal);
        if (controller.signal.aborted) return;
        setClasses(response.items);
        setLoadError(null);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(toAppError(error, '班级列表加载失败，请稍后重试'));
      }
    };
    void loadClasses();
    return () => controller.abort();
  }, [reloadKey]);

  const handleCreateClass = async (data: ClassCreationFormData) => {
    setIsSubmitting(true);
    clearErrors('root');
    try {
      const response = await classService.createClass({
        name: data.name.trim(),
        description: data.description?.trim() || undefined,
      });
      setClasses((prev) => [response.class_info, ...prev]);
      reset();
      setIsCreateOpen(false);
    } catch (error) {
      const appError = toAppError(error, '创建班级失败，请稍后重试');
      setError('root', {
        type: 'manual',
        message: appError.message,
      });
      if (appError.kind !== 'cancelled' && appError.kind !== 'rate_limited'
        && (appError.requestId || appError.retryAfter !== undefined)) {
        toast({
          type: 'error',
          title: appError.message,
          description: [
            appError.retryAfter !== undefined && appError.retryAfter > 0
              ? `可在 ${appError.retryAfter} 秒后重试`
              : '',
            appError.requestId ? `请求编号：${appError.requestId}` : '',
          ].filter(Boolean).join('；'),
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ErrorBoundary>
      <MainLayout>
        <div className="container mx-auto px-6 py-8 max-w-7xl">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100 mb-1">
              班级管理
            </h1>
            <p className="text-surface-500 dark:text-surface-400">
              统一管理班级与班级学生
            </p>
          </div>
          <Button onClick={() => setIsCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            创建班级
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>班级列表</CardTitle>
          </CardHeader>
          <CardContent>
            {loadError && (
              <RequestErrorNotice
                error={loadError}
                onRetry={() => setReloadKey((key) => key + 1)}
                onRefresh={() => setReloadKey((key) => key + 1)}
                className="mb-4"
              />
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-surface-500 dark:text-surface-400 border-b border-surface-100 dark:border-surface-700">
                  <tr>
                    <th className="py-3 font-medium">班级</th>
                    <th className="py-3 font-medium">班级号</th>
                    <th className="py-3 font-medium">学生人数</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-100 dark:divide-surface-700">
                  {classes.length === 0 ? (
                    <tr>
                      <td className="py-6 text-surface-500 dark:text-surface-400" colSpan={3}>
                        还没有创建班级
                      </td>
                    </tr>
                  ) : (
                    classes.map((row) => (
                      <tr
                        key={row.id}
                        className="hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors cursor-pointer"
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(`/teacher/class/${row.id}`)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            navigate(`/teacher/class/${row.id}`);
                          }
                        }}
                      >
                        <td className="py-5">
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div className="font-medium text-surface-900 dark:text-surface-100">
                                {row.name}
                              </div>
                              {row.description && (
                                <div className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                                  {row.description}
                                </div>
                              )}
                            </div>
                            <ChevronRight className="w-4 h-4 text-surface-400 mt-1" />
                          </div>
                        </td>
                        <td className="py-5">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{row.code}</Badge>
                            <button
                              type="button"
                              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-surface-400 hover:text-primary-600 hover:bg-surface-100 dark:hover:text-primary-400 dark:hover:bg-surface-700 transition-colors"
                              title="复制班级号"
                              onClick={(e) => handleCopyCode(e, row.id, row.code)}
                            >
                              {copiedId === row.id ? (
                                <Check className="w-3.5 h-3.5 text-emerald-500" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                        <td className="py-5">
                          <span className="inline-flex items-center rounded-full bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300 px-3 py-1 text-xs font-medium">
                            {row.student_count ?? 0} 人
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
        </div>

      <Modal
        isOpen={isCreateOpen}
        onClose={handleCloseCreate}
        title="创建班级"
      >
          <form className="space-y-4" onSubmit={handleSubmit(handleCreateClass)}>
            <div className="space-y-2">
              <Input placeholder="请输入班级名称" {...register('name')} />
              {errors.name?.message && (
                <p className="text-sm text-red-500">{errors.name.message}</p>
              )}
            </div>
            <Input placeholder="班级描述（可选）" {...register('description')} />
            {errors.root?.message && (
              <p className="text-sm text-red-500">{errors.root.message}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={handleCloseCreate}>
                取消
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? '创建中...' : '创建班级'}
              </Button>
            </div>
          </form>
        </Modal>
      </MainLayout>
    </ErrorBoundary>
  );
};
