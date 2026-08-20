import React, { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { zhCN } from 'date-fns/locale';
import { MainLayout } from '../../components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { Button } from '../../components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { classService } from '@/modules/classroom/services/classService';
import type { ClassInfo } from '@/modules/classroom/types/classroom';
import { classCodeSchema, type ClassCodeFormData } from '../../libs/validation';
import { formatDateOrFallback } from '@/libs/utils/dateFormat';
import { normalizeSafeImageAttachmentUrl, normalizeSafeMailtoUrl } from '@/libs/utils/safeUrl';
import { Users, Search, LogOut, UserPlus, Calendar, UserCheck, Mail } from 'lucide-react';
import { isRequestCancelled, toAppError, type AppError } from '@/libs/http/appError';

function formatClassDate(value: string | null | undefined): string {
  return formatDateOrFallback(value, 'yyyy年MM月dd日', {
    locale: zhCN,
    fallback: '未知',
  });
}

export const MyClassPage: React.FC = () => {
  const [currentClass, setCurrentClass] = useState<ClassInfo | null>(null);
  const [lookupResult, setLookupResult] = useState<ClassInfo | null>(null);
  const [teacherName, setTeacherName] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [requestError, setRequestError] = useState<AppError | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [reloadVersion, setReloadVersion] = useState(0);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ClassCodeFormData>({
    resolver: zodResolver(classCodeSchema),
    defaultValues: { code: '' },
  });

  useEffect(() => {
    const controller = new AbortController();
    const loadMyClass = async () => {
      setPageLoading(true);
      setRequestError(null);
      try {
        const response = await classService.getMyClass(controller.signal);
        if (!controller.signal.aborted) setCurrentClass(response.class_info);
      } catch (loadError) {
        if (controller.signal.aborted || isRequestCancelled(loadError)) return;
        const appError = toAppError(loadError, '获取当前班级失败，请稍后重试');
        if (appError.kind === 'not_found') {
          setCurrentClass(null);
        } else {
          setRequestError(appError);
        }
      } finally {
        if (!controller.signal.aborted) setPageLoading(false);
      }
    };
    void loadMyClass();
    return () => controller.abort();
  }, [reloadVersion]);

  const handleLookupClass = async (data: ClassCodeFormData) => {
    setIsLoading(true);
    setMessage('');
    setRequestError(null);
    try {
      const response = await classService.lookupClass(data.code.trim());
      if (!response.found || !response.class_info) {
        setLookupResult(null);
        setTeacherName(null);
        setMessage('未找到对应班级');
      } else {
        setLookupResult(response.class_info);
        setTeacherName(response.teacher_name ?? null);
      }
    } catch (lookupError) {
      if (!isRequestCancelled(lookupError)) {
        setRequestError(toAppError(lookupError, '班级查询失败，请稍后重试'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleJoinClass = async () => {
    if (!lookupResult) return;
    setIsLoading(true);
    setMessage('');
    setRequestError(null);
    try {
      const response = await classService.joinClass({ code: lookupResult.code });
      setCurrentClass(response.class_info);
      setLookupResult(null);
      setTeacherName(null);
      reset();
      setMessage('已成功加入班级');
    } catch (joinError) {
      if (!isRequestCancelled(joinError)) {
        setRequestError(toAppError(joinError, '加入班级失败，请稍后重试'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleLeaveClass = async () => {
    setIsLoading(true);
    setMessage('');
    setRequestError(null);
    try {
      await classService.leaveClass();
      setCurrentClass(null);
      setMessage('已退出班级');
    } catch (leaveError) {
      if (!isRequestCancelled(leaveError)) {
        setRequestError(toAppError(leaveError, '退出班级失败，请稍后重试'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (pageLoading) {
    return (
      <ErrorBoundary>
        <MainLayout>
          <div className="container mx-auto px-4 py-8 max-w-3xl">
            <div className="animate-pulse space-y-4">
              <div className="h-8 bg-surface-200 dark:bg-surface-700 rounded w-1/3" />
              <div className="h-48 bg-surface-200 dark:bg-surface-700 rounded" />
            </div>
          </div>
        </MainLayout>
      </ErrorBoundary>
    );
  }

  const teacherAvatarUrl = normalizeSafeImageAttachmentUrl(currentClass?.teacher_avatar_url);
  const teacherMailtoUrl = normalizeSafeMailtoUrl(currentClass?.teacher_email);

  return (
    <ErrorBoundary>
      <MainLayout>
        <div className="container mx-auto px-4 py-8 max-w-3xl space-y-6">
          <div className="flex items-center gap-3">
            <Users className="w-7 h-7 text-primary-600 dark:text-primary-400" />
            <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100">
              我的班级
            </h1>
          </div>

          {requestError ? (
            <RequestErrorNotice
              error={requestError}
              onRetry={() => setReloadVersion((value) => value + 1)}
              onRefresh={() => setReloadVersion((value) => value + 1)}
              onDismiss={() => setRequestError(null)}
            />
          ) : null}

          {currentClass ? (
            <Card>
              <CardHeader>
                <CardTitle>当前班级</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* 班级基础信息 */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-lg font-semibold text-surface-900 dark:text-surface-100">
                      {currentClass.name}
                    </div>
                    <div className="text-sm text-surface-500 dark:text-surface-400">
                      班级号：{currentClass.code}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    onClick={handleLeaveClass}
                    disabled={isLoading}
                  >
                    <LogOut className="w-4 h-4 mr-2" />
                    退出班级
                  </Button>
                </div>

                {/* 教师信息区 */}
                {currentClass.teacher_name && (
                  <div className="border-t border-surface-200 dark:border-surface-700 pt-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-primary-100 dark:bg-primary-900 flex items-center justify-center text-primary-600 dark:text-primary-400 font-semibold">
                        {teacherAvatarUrl ? (
                          <img
                            src={teacherAvatarUrl}
                            alt={currentClass.teacher_name}
                            className="w-full h-full rounded-full object-cover"
                          />
                        ) : (
                          currentClass.teacher_name.charAt(0).toUpperCase()
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-surface-700 dark:text-surface-300">
                          任课教师
                        </div>
                        <div className="text-base font-semibold text-surface-900 dark:text-surface-100">
                          {currentClass.teacher_name}
                        </div>
                        {teacherMailtoUrl && (
                          <a
                            href={teacherMailtoUrl}
                            className="text-sm text-primary-600 dark:text-primary-400 hover:underline flex items-center gap-1 mt-1"
                          >
                            <Mail className="w-3 h-3" />
                            {currentClass.teacher_email}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* 班级统计区 */}
                <div className="border-t border-surface-200 dark:border-surface-700 pt-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {currentClass.student_count !== undefined && (
                      <div className="flex items-center gap-2">
                        <Users className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                        <div>
                          <div className="text-xs text-surface-500 dark:text-surface-400">
                            班级人数
                          </div>
                          <div className="text-lg font-semibold text-surface-900 dark:text-surface-100">
                            {currentClass.student_count} 人
                          </div>
                        </div>
                      </div>
                    )}
                    {currentClass.created_at && (
                      <div className="flex items-center gap-2">
                        <Calendar className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                        <div>
                          <div className="text-xs text-surface-500 dark:text-surface-400">
                            创建时间
                          </div>
                          <div className="text-sm font-medium text-surface-900 dark:text-surface-100">
                            {formatClassDate(currentClass.created_at)}
                          </div>
                        </div>
                      </div>
                    )}
                    {currentClass.joined_at && (
                      <div className="flex items-center gap-2">
                        <UserCheck className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                        <div>
                          <div className="text-xs text-surface-500 dark:text-surface-400">
                            加入时间
                          </div>
                          <div className="text-sm font-medium text-surface-900 dark:text-surface-100">
                            {formatClassDate(currentClass.joined_at)}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* 班级描述区 */}
                {currentClass.description && (
                  <div className="border-t border-surface-200 dark:border-surface-700 pt-4">
                    <div className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
                      班级描述
                    </div>
                    <div className="text-sm text-surface-600 dark:text-surface-400 leading-relaxed">
                      {currentClass.description}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>加入班级</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-surface-500 dark:text-surface-400">
                  输入教师提供的班级号，搜索并加入班级。
                </p>
                <form
                  className="flex flex-col sm:flex-row gap-2"
                  onSubmit={handleSubmit(handleLookupClass)}
                >
                  <Input
                    className="sm:min-w-0 sm:flex-1"
                    placeholder="输入班级号"
                    {...register('code')}
                  />
                  <Button
                    className="shrink-0 whitespace-nowrap"
                    variant="outline"
                    type="submit"
                    disabled={isLoading}
                  >
                    <Search className="w-4 h-4 mr-2" />
                    搜索
                  </Button>
                </form>
                {errors.code?.message && (
                  <p className="text-sm text-red-500">{errors.code.message}</p>
                )}
                {lookupResult && (
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-surface-200 dark:border-surface-700 p-4">
                    <div className="space-y-1">
                      <div className="font-medium text-surface-900 dark:text-surface-100">
                        {lookupResult.name}（{lookupResult.code}）
                      </div>
                      {teacherName && (
                        <div className="text-sm text-surface-500 dark:text-surface-400">
                          任课教师：{teacherName}
                        </div>
                      )}
                    </div>
                    <Button onClick={handleJoinClass} disabled={isLoading}>
                      <UserPlus className="w-4 h-4 mr-2" />
                      加入班级
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {message && (
            <p className="text-sm text-primary-600 dark:text-primary-400">
              {message}
            </p>
          )}
        </div>
      </MainLayout>
    </ErrorBoundary>
  );
};
