import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MainLayout } from '../../components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import {
  Users,
  Search,
  TrendingUp,
  TrendingDown,
  Eye,
} from 'lucide-react';
import { classService } from '@/modules/classroom/services/classService';
import { teacherService } from '@/modules/teacher/services/teacherService';
import type { ClassInfo } from '@/modules/classroom/types/classroom';
import type { StudentsStats, TeacherStudentListItem } from '@/modules/teacher/types/teacher';
import { toAppError, type AppError } from '@/libs/http/apiClient';

type StudentRow = TeacherStudentListItem;

const pageSize = 20;

export const StudentsPage: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedClassId, setSelectedClassId] = useState('all');
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [classesError, setClassesError] = useState<AppError | null>(null);
  const [statsError, setStatsError] = useState<AppError | null>(null);
  const [studentsError, setStudentsError] = useState<AppError | null>(null);
  const [stats, setStats] = useState<StudentsStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [classesReloadKey, setClassesReloadKey] = useState(0);
  const [statsReloadKey, setStatsReloadKey] = useState(0);
  const [studentsReloadKey, setStudentsReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const loadClasses = async () => {
      setClassesError(null);
      try {
        const response = await classService.listTeacherClasses(controller.signal);
        if (!controller.signal.aborted) setClasses(response.items);
      } catch (error) {
        if (!controller.signal.aborted) setClassesError(toAppError(error, '班级列表加载失败，请稍后重试'));
      }
    };
    void loadClasses();
    return () => controller.abort();
  }, [classesReloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    const loadStats = async () => {
      try {
        setStatsLoading(true);
        setStatsError(null);
        const data = await teacherService.getStudentsStats(controller.signal);
        if (!controller.signal.aborted) setStats(data);
      } catch (error) {
        if (!controller.signal.aborted) {
          setStatsError(toAppError(error, '学生统计数据加载失败，请稍后重试'));
        }
      } finally {
        if (!controller.signal.aborted) setStatsLoading(false);
      }
    };
    void loadStats();
    return () => controller.abort();
  }, [statsReloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    const loadStudents = async () => {
      setIsLoading(true);
      setStudentsError(null);
      try {
        const response = await teacherService.getStudents({
          page: currentPage,
          page_size: pageSize,
          class_id: selectedClassId === 'all' ? undefined : selectedClassId,
          search: searchTerm.trim() || undefined,
        }, controller.signal);
        if (controller.signal.aborted) return;
        setStudents(response.items);
        setPagination({ total: response.total, totalPages: response.total_pages });
      } catch (error) {
        if (controller.signal.aborted) return;
        setStudents([]);
        setPagination({ total: 0, totalPages: 0 });
        setStudentsError(toAppError(error, '学生列表加载失败，请稍后重试'));
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    };
    void loadStudents();
    return () => controller.abort();
  }, [currentPage, searchTerm, selectedClassId, studentsReloadKey]);

  return (
    <MainLayout>
      <div className="container mx-auto px-6 py-8 max-w-7xl">
        {/* 页面标题 */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100 mb-1">学生管理</h1>
            <p className="text-surface-500 dark:text-surface-400">管理和查看所有学生的学习情况</p>
          </div>
          <div className="flex gap-3">
            <Link to="/teacher/classes">
              <Button variant="outline" size="sm">
                查看班级管理
              </Button>
            </Link>

          </div>
        </div>

        {classesError ? (
          <RequestErrorNotice
            error={classesError}
            onRetry={() => setClassesReloadKey((key) => key + 1)}
            onRefresh={() => setClassesReloadKey((key) => key + 1)}
            className="mb-4"
          />
        ) : null}
        {statsError ? (
          <RequestErrorNotice
            error={statsError}
            onRetry={() => setStatsReloadKey((key) => key + 1)}
            onRefresh={() => setStatsReloadKey((key) => key + 1)}
            className="mb-6"
          />
        ) : null}

        {/* 统计卡片 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary-50 dark:bg-primary-900/30 rounded-lg">
                  <Users className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                    {statsLoading ? '...' : stats?.total_students || 0}
                  </div>
                  <div className="text-sm text-surface-500">总学生数</div>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-emerald-50 dark:bg-emerald-900/30 rounded-lg">
                  <TrendingUp className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                    {statsLoading ? '...' : stats?.avg_score || 0}
                  </div>
                  <div className="text-sm text-surface-500">平均成绩</div>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-secondary-50 dark:bg-secondary-900/30 rounded-lg">
                  <Users className="w-5 h-5 text-secondary-600 dark:text-secondary-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                    {statsLoading ? '...' : `${stats?.active_today || 0}%`}
                  </div>
                  <div className="text-sm text-surface-500">今日活跃率</div>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-50 dark:bg-amber-900/30 rounded-lg">
                  <TrendingDown className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                    {statsLoading ? '...' : stats?.need_attention || 0}
                  </div>
                  <div className="text-sm text-surface-500">需关注学生</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 筛选和搜索 */}
        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
                <Input
                  placeholder="搜索学生姓名..."
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="pl-9"
                />
              </div>
              <div className="flex gap-2">
                <select
                  value={selectedClassId}
                  onChange={(e) => {
                    setSelectedClassId(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="px-3 py-2 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value="all">全部班级</option>
                  {classes.map((cls) => (
                    <option key={cls.id} value={cls.id}>{cls.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 学生列表 */}
        <Card>
          <CardHeader>
            <CardTitle>学生列表 ({pagination.total})</CardTitle>
          </CardHeader>
          <CardContent>
            {studentsError ? (
              <RequestErrorNotice
                error={studentsError}
                onRetry={() => setStudentsReloadKey((key) => key + 1)}
                onRefresh={() => setStudentsReloadKey((key) => key + 1)}
                className="mb-4"
              />
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-200 dark:border-surface-700">
                    <th className="text-left py-3 px-4 font-medium text-surface-500 dark:text-surface-400">学生</th>
                    <th className="text-left py-3 px-4 font-medium text-surface-500 dark:text-surface-400">班级</th>
                    <th className="text-left py-3 px-4 font-medium text-surface-500 dark:text-surface-400">邮箱</th>
                    <th className="text-right py-3 px-4 font-medium text-surface-500 dark:text-surface-400">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-100 dark:divide-surface-800">
                  {isLoading ? (
                    <tr>
                      <td className="py-6 px-4 text-surface-500 dark:text-surface-400" colSpan={4}>
                        正在加载学生数据...
                      </td>
                    </tr>
                  ) : students.length === 0 ? (
                    <tr>
                      <td className="py-6 px-4 text-surface-500 dark:text-surface-400" colSpan={4}>
                        暂无学生
                      </td>
                    </tr>
                  ) : (
                    students.map((student) => (
                      <tr key={student.id} className="hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-colors">
                        <td className="py-4 px-4">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-linear-to-br from-primary-100 to-secondary-100 dark:from-primary-900 dark:to-secondary-900 flex items-center justify-center text-primary-700 dark:text-primary-300 font-medium text-sm">
                              {(student.display_name || student.username || '—')[0]}
                            </div>
                            <span className="font-medium text-surface-900 dark:text-surface-100">
                              {student.display_name || student.username || '未知学生'}
                            </span>
                          </div>
                        </td>
                        <td className="py-4 px-4 text-surface-600 dark:text-surface-400">{student.class_name}</td>
                        <td className="py-4 px-4 text-surface-600 dark:text-surface-400">{student.email}</td>
                        <td className="py-4 px-4">
                          <div className="flex justify-end gap-1">
                            <Link to={`/teacher/student/${student.id}`}>
                              <Button variant="ghost" size="icon" className="h-8 w-8" title="查看详情">
                                <Eye className="w-4 h-4" />
                              </Button>
                            </Link>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {!isLoading && pagination.totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-surface-100 dark:border-surface-800 px-4 py-3 text-sm">
                <span className="text-surface-500 dark:text-surface-400">
                  第 {currentPage} / {pagination.totalPages} 页
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  >
                    上一页
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage >= pagination.totalPages}
                    onClick={() => setCurrentPage((page) => Math.min(pagination.totalPages, page + 1))}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
};

export default StudentsPage;
