import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MainLayout } from '../../components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Progress } from '../../components/ui/Progress';
import { Input } from '../../components/ui/Input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/Tabs';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '../../components/ui/Table';
import {
  ArrowLeft,
  Users,
  AlertTriangle,
  Search,
  BookOpen,
  Target,
  Clock,
  Trash2
} from 'lucide-react';
import { classService } from '@/modules/classroom/services/classService';
import { teacherService } from '@/modules/teacher/services/teacherService';
import type { ClassInfo, ClassStudent } from '@/modules/classroom/types/classroom';
import type { ClassAnalyticsData } from '@/modules/teacher/types/teacher';
import { TeacherDailyQuestionPanel } from '@/modules/daily-question/components/TeacherDailyQuestionPanel';
import { toAppError, type AppError } from '@/libs/http/apiClient';

const classDetailTabs = new Set(['students', 'mastery', 'errors', 'daily-question']);

function normalizeClassDetailTab(value: string | null): string {
  return value && classDetailTabs.has(value) ? value : 'students';
}

export const ClassDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState('');
  const requestedTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(normalizeClassDetailTab(requestedTab));
  const [classInfo, setClassInfo] = useState<ClassInfo | null>(null);
  const [students, setStudents] = useState<ClassStudent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [requestError, setRequestError] = useState<AppError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [isDisbandOpen, setIsDisbandOpen] = useState(false);
  const [isDisbanding, setIsDisbanding] = useState(false);
  const [classAnalytics, setClassAnalytics] = useState<ClassAnalyticsData | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const loadClassDetail = async () => {
      if (!id) return;
      setIsLoading(true);
      setRequestError(null);
      const [detailResponse, analyticsResponse] = await Promise.allSettled([
        classService.getTeacherClassDetail(id, controller.signal),
        teacherService.getClassAnalytics(id, controller.signal),
      ]);
      if (!active || controller.signal.aborted) return;

      if (detailResponse.status === 'fulfilled') {
        setClassInfo(detailResponse.value.class_info);
        setStudents(detailResponse.value.students);
      } else {
        setClassInfo(null);
        setStudents([]);
      }
      if (analyticsResponse.status === 'fulfilled') {
        setClassAnalytics(analyticsResponse.value);
      } else {
        setClassAnalytics(null);
      }
      const failed = detailResponse.status === 'rejected'
        ? detailResponse.reason
        : analyticsResponse.status === 'rejected'
          ? analyticsResponse.reason
          : null;
      if (failed) setRequestError(toAppError(failed, '班级信息加载失败，请稍后重试'));
      setIsLoading(false);
    };
    void loadClassDetail();
    return () => {
      active = false;
      controller.abort();
    };
  }, [id, reloadKey]);

  useEffect(() => {
    const nextTab = normalizeClassDetailTab(requestedTab);
    setActiveTab((current) => current === nextTab ? current : nextTab);
  }, [requestedTab]);

  const handleTabChange = (value: string) => {
    setActiveTab(value);
    const nextParams = new URLSearchParams(searchParams);
    if (value === 'students') {
      nextParams.delete('tab');
    } else {
      nextParams.set('tab', value);
    }
    setSearchParams(nextParams, { replace: true });
  };

  const filteredStudents = students.filter((student) =>
    (student.display_name || student.username)
      .toLowerCase()
      .includes(searchTerm.toLowerCase())
  );

  const teacherRow = classInfo?.teacher_name
    ? {
        id: classInfo.teacher_id,
        username: classInfo.teacher_name,
        email: classInfo.teacher_email || '',
        display_name: classInfo.teacher_name,
      }
    : null;
  const hasStudentRows = filteredStudents.length > 0;
  const hasAnyRows = Boolean(teacherRow) || hasStudentRows;

  const notifyRequestError = (error: unknown, fallback: string) => {
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
  };

  const handleRemoveStudent = async (studentId: string) => {
    if (!id) return;
    try {
      await classService.removeStudent(id, studentId);
      setStudents((prev) => prev.filter((student) => student.id !== studentId));
    } catch (error) {
      notifyRequestError(error, '移除学生失败，请稍后重试');
    }
  };

  const handleDisbandClass = async () => {
    if (!id) return;
    setIsDisbanding(true);
    setRequestError(null);
    try {
      await classService.disbandClass(id);
      setIsDisbandOpen(false);
      navigate('/teacher/classes');
    } catch (error) {
      notifyRequestError(error, '解散班级失败，请稍后重试');
    } finally {
      setIsDisbanding(false);
    }
  };

  const totalStudents = students.length;
  const averageMastery = classAnalytics?.stats.average_mastery ?? 0;
  const averageScore = classAnalytics?.stats.average_score ?? 0;
  const weeklyStudyHours = classAnalytics?.stats.weekly_study_hours ?? 0;

  return (
    <MainLayout>
      <div className="container mx-auto px-6 py-8 max-w-7xl">
        {/* 页面标题 */}
        <div className="mb-8">
          <Button variant="ghost" className="mb-4" onClick={() => window.history.back()}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            返回工作台
          </Button>
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-2">
                {classInfo?.name ?? '班级详情'}
              </h1>
              {classInfo?.description && (
                <p className="text-sm text-surface-600 dark:text-surface-400 mb-2">
                  {classInfo.description}
                </p>
              )}
              <p className="text-surface-500 dark:text-surface-400">
                班级号 {classInfo?.code ?? '--'} · 共 {totalStudents} 名学生
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="icon"
                aria-label="解散班级"
                onClick={() => setIsDisbandOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {requestError ? (
          <RequestErrorNotice
            error={requestError}
            onRetry={() => setReloadKey((key) => key + 1)}
            onRefresh={() => setReloadKey((key) => key + 1)}
            className="mb-6"
          />
        ) : null}

        {/* 统计卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                  <Users className="h-6 w-6 text-primary-600 dark:text-primary-400" />
                </div>
                <div>
                  <div className="text-3xl font-bold text-surface-900 dark:text-surface-100">
                    {totalStudents}/{totalStudents}
                  </div>
                  <div className="text-sm text-surface-500 dark:text-surface-400">活跃学生</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                  <Target className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <div className="text-3xl font-bold text-surface-900 dark:text-surface-100">
                    {(averageMastery * 100).toFixed(0)}%
                  </div>
                  <div className="text-sm text-surface-500 dark:text-surface-400">平均掌握度</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-secondary-100 dark:bg-secondary-900/30 flex items-center justify-center">
                  <BookOpen className="h-6 w-6 text-secondary-600 dark:text-secondary-400" />
                </div>
                <div>
                  <div className="text-3xl font-bold text-surface-900 dark:text-surface-100">
                    {averageScore}
                  </div>
                  <div className="text-sm text-surface-500 dark:text-surface-400">平均分</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                  <Clock className="h-6 w-6 text-orange-600 dark:text-orange-400" />
                </div>
                <div>
                  <div className="text-3xl font-bold text-surface-900 dark:text-surface-100">
                    {weeklyStudyHours}h
                  </div>
                  <div className="text-sm text-surface-500 dark:text-surface-400">周均学习</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 主内容区 */}
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <Tabs defaultValue="students" value={activeTab} onValueChange={handleTabChange}>
                <CardHeader>
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                    <TabsList className="h-auto flex-wrap justify-start">
                      <TabsTrigger value="students">学生列表</TabsTrigger>
                      <TabsTrigger value="mastery">知识点掌握</TabsTrigger>
                      <TabsTrigger value="errors">高频错题</TabsTrigger>
                      <TabsTrigger value="daily-question">每日一题</TabsTrigger>
                    </TabsList>
                    {activeTab === 'students' && (
                      <div className="relative w-full sm:w-64">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400" />
                        <Input
                          placeholder="搜索学生..."
                          value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                          className="pl-10"
                        />
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <TabsContent value="students" className="mt-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>学生</TableHead>
                        <TableHead>邮箱</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {isLoading ? (
                        <TableRow>
                          <TableCell colSpan={3} className="text-surface-500">
                            正在加载学生数据...
                          </TableCell>
                        </TableRow>
                      ) : !hasAnyRows ? (
                        <TableRow>
                          <TableCell colSpan={3} className="text-surface-500">
                            暂无学生
                          </TableCell>
                        </TableRow>
                      ) : (
                        <>
                          {teacherRow && (
                            <TableRow key={teacherRow.id}>
                              <TableCell className="font-medium">
                                {teacherRow.display_name || teacherRow.username}
                                <Badge variant="outline" className="ml-2">
                                  教师
                                </Badge>
                              </TableCell>
                              <TableCell>{teacherRow.email || '—'}</TableCell>
                              <TableCell className="text-right text-surface-500">
                                —
                              </TableCell>
                            </TableRow>
                          )}
                          {filteredStudents.map((student) => (
                            <TableRow key={student.id}>
                              <TableCell className="font-medium">
                                {student.display_name || student.username}
                              </TableCell>
                              <TableCell>{student.email}</TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleRemoveStudent(student.id)}
                                >
                                  移除
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </>
                      )}
                    </TableBody>
                  </Table>
                </TabsContent>

                  <TabsContent value="mastery" className="mt-0">
                  <div className="space-y-4">
                    {(classAnalytics?.topic_mastery ?? []).length > 0 ? (
                      classAnalytics!.topic_mastery.map((topic, index) => (
                        <div key={index} className="p-4 rounded-lg border border-surface-200 dark:border-surface-700">
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-medium text-surface-900 dark:text-surface-100">
                              {topic.topic}
                            </span>
                            <span className="text-sm text-surface-500 dark:text-surface-400">
                              {topic.student_count} 名学生已学习
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <Progress
                              value={topic.mastery * 100}
                              variant={
                                topic.mastery >= 0.8
                                  ? 'success'
                                  : topic.mastery >= 0.6
                                  ? 'default'
                                  : topic.mastery >= 0.4
                                  ? 'warning'
                                  : 'destructive'
                              }
                              className="flex-1"
                            />
                            <span className="text-sm font-medium w-12 text-right">
                              {(topic.mastery * 100).toFixed(0)}%
                            </span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-center text-surface-400 py-8">暂无知识点数据</p>
                    )}
                  </div>
                </TabsContent>

                  <TabsContent value="errors" className="mt-0">
                  <div className="space-y-3">
                    {(classAnalytics?.common_errors ?? []).length > 0 ? (
                      classAnalytics!.common_errors.map((error) => (
                        <div
                          key={error.id}
                          className="p-4 rounded-lg border border-surface-200 dark:border-surface-700"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="font-medium text-surface-900 dark:text-surface-100">
                                {error.content}
                              </p>
                              <Badge variant="outline" className="mt-2">
                                {error.topic}
                              </Badge>
                            </div>
                            <div className="text-right">
                              <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                                {error.count}
                              </div>
                              <div className="text-xs text-surface-500">人次出错</div>
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-center text-surface-400 py-8">暂无错题数据</p>
                    )}
                  </div>
                </TabsContent>

                  <TabsContent value="daily-question" className="mt-0">
                    {id ? <TeacherDailyQuestionPanel classId={id} /> : null}
                  </TabsContent>
                </CardContent>
              </Tabs>
            </Card>
          </div>

          {/* 右侧边栏 */}
          <div className="space-y-6">
            {/* 学情预警 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-orange-500" />
                  学情预警
                </CardTitle>
                <CardDescription>需要关注的学生</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(classAnalytics?.alerts ?? []).length > 0 ? (
                  classAnalytics!.alerts.map((alert) => (
                    <div
                      key={alert.id}
                      className={`p-3 rounded-lg border ${
                        alert.severity === 'high'
                          ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20'
                          : 'border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/20'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium text-surface-900 dark:text-surface-100">
                          {alert.student_name}
                        </span>
                        <Badge variant={alert.severity === 'high' ? 'destructive' : 'warning'}>
                          {alert.severity === 'high' ? '高风险' : '中风险'}
                        </Badge>
                      </div>
                      <p className="text-sm text-surface-600 dark:text-surface-400">{alert.message}</p>
                    </div>
                  ))
                ) : (
                  <p className="text-center text-surface-400 py-4">暂无预警</p>
                )}
              </CardContent>
            </Card>

            {/* 班级排名 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">成绩排行</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {(classAnalytics?.student_rankings ?? []).length > 0 ? (
                    classAnalytics!.student_rankings.map((student, index) => (
                      <div key={student.student_id} className="flex items-center gap-3">
                        <div
                          className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                            index === 0
                              ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
                              : index === 1
                              ? 'bg-surface-200 text-surface-700 dark:bg-surface-700 dark:text-surface-300'
                              : index === 2
                              ? 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300'
                              : 'bg-surface-100 text-surface-500 dark:bg-surface-800 dark:text-surface-400'
                          }`}
                        >
                          {index + 1}
                        </div>
                        <span className="flex-1 text-surface-900 dark:text-surface-100">
                          {student.name}
                        </span>
                        <span className="font-bold text-surface-700 dark:text-surface-300">
                          {student.avg_score}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-center text-surface-400 py-4">暂无排名数据</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
      <Modal
        isOpen={isDisbandOpen}
        onClose={() => setIsDisbandOpen(false)}
        title="解散班级"
      >
        <div className="space-y-4">
          <p className="text-sm text-surface-600 dark:text-surface-400">
            是否确认解散班级？解散后班级将被删除，学生将失去班级关联。
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsDisbandOpen(false)}>
              取消
            </Button>
            <Button onClick={handleDisbandClass} disabled={isDisbanding}>
              {isDisbanding ? '处理中...' : '确认解散'}
            </Button>
          </div>
        </div>
      </Modal>
    </MainLayout>
  );
};
