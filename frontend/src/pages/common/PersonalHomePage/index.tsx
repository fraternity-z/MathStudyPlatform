import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { useAppSelector } from '@/store';
import { selectCurrentUser } from '@/modules/auth/store/authSlice';
import { HomeHero } from './HomeHero';
import { HomeStatsStrip } from './HomeStatsStrip';
import { HomeSections } from './HomeSections';
import { loadStudentHomeData, loadTeacherHomeData } from './homeData';
import type { PersonalHomeData, HomeRole } from './types';
import { isRequestCancelled } from '@/libs/http/appError';

interface PersonalHomeViewProps {
  role: HomeRole;
  displayName: string;
  data: PersonalHomeData;
  loading: boolean;
  onRetry: () => void;
}

const loadingData: Record<HomeRole, PersonalHomeData> = {
  student: {
    role: 'student',
    primaryHref: '/exercise',
    primaryLabel: '开始学习',
    primaryContext: '正在整理你的学习进度',
    stats: [
      { key: 'study-time', label: '累计学习', value: '—', tone: 'blue' },
      { key: 'accuracy', label: '正确率', value: '—', tone: 'violet' },
      { key: 'streak', label: '连续学习', value: '—', tone: 'emerald' },
      { key: 'mastered', label: '已掌握', value: '—', tone: 'coral' },
    ],
    actions: [],
    recentItems: [],
    affiliation: {
      title: '班级信息加载中',
      subtitle: '稍等片刻',
      href: '/my-class',
      actionLabel: '我的班级',
      empty: true,
    },
    failedSections: [],
    sectionErrors: [],
  },
  teacher: {
    role: 'teacher',
    primaryHref: '/teacher/dashboard',
    primaryLabel: '进入教学概览',
    primaryContext: '正在整理今天的教学数据',
    stats: [
      { key: 'students', label: '学生总数', value: '—', tone: 'blue' },
      { key: 'active', label: '今日活跃', value: '—', tone: 'violet' },
      { key: 'completion', label: '平均完成率', value: '—', tone: 'emerald' },
      { key: 'grading', label: '待批改', value: '—', tone: 'coral' },
    ],
    actions: [],
    recentItems: [],
    affiliation: {
      title: '教学信息加载中',
      subtitle: '稍等片刻',
      href: '/teacher/classes',
      actionLabel: '班级管理',
      empty: true,
    },
    failedSections: [],
    sectionErrors: [],
  },
};

const unexpectedFailureLabel = '主页数据';

function markHomeUnavailable(data: PersonalHomeData): PersonalHomeData {
  const fallbackError = {
    kind: 'unknown' as const,
    message: '主页数据暂时无法加载，请稍后重试',
    retryable: true,
    source: 'ui' as const,
  };
  const sectionErrors = data.sectionErrors.length > 0
    ? data.sectionErrors
    : [{ section: unexpectedFailureLabel, error: fallbackError }];
  return {
    ...data,
    primaryContext: data.role === 'teacher'
      ? '主页数据暂时无法加载，仍可进入教学概览'
      : '主页数据暂时无法加载，仍可开始学习',
    affiliation: {
      ...data.affiliation,
      title: data.role === 'teacher' ? '教学信息暂不可用' : '班级信息暂不可用',
      subtitle: '常用入口仍可正常使用',
      detail: '可以稍后重新加载',
      empty: false,
      unavailable: true,
    },
    failedSections: data.failedSections.includes(unexpectedFailureLabel)
      ? data.failedSections
      : [...data.failedSections, unexpectedFailureLabel],
    sectionErrors,
  };
}

export function PersonalHomeView({
  role,
  displayName,
  data,
  loading,
  onRetry,
}: PersonalHomeViewProps) {
  return (
    <MainLayout showFooter={false} className="bg-white dark:bg-surface-950">
      <div className="min-h-[calc(100vh-4rem)] bg-white dark:bg-surface-950">
        <HomeHero
          role={role}
          name={displayName}
          primaryHref={data.primaryHref}
          primaryLabel={data.primaryLabel}
          primaryContext={data.primaryContext}
        />

        <div className="relative z-10 -mt-px pt-5">
          <HomeStatsStrip stats={data.stats} loading={loading} />
        </div>

        {data.sectionErrors.length > 0 && !loading ? (
          <div className="mx-auto mt-5 max-w-7xl px-4 sm:px-6 lg:px-8">
            <div role="status" aria-live="polite" className="space-y-3">
              <p className="text-sm text-surface-600 dark:text-surface-300">
                部分数据暂时未能加载，常用入口仍可正常使用。
              </p>
              {data.sectionErrors.map(({ section, error }) => (
                <RequestErrorNotice
                  key={`${section}:${error.requestId ?? error.code ?? error.kind}`}
                  error={{ ...error, message: `${section}：${error.message}` }}
                  onRetry={onRetry}
                  onRefresh={error.kind === 'conflict' ? onRetry : undefined}
                />
              ))}
            </div>
          </div>
        ) : null}

        <HomeSections
          role={role}
          actions={data.actions}
          recentItems={data.recentItems}
          affiliation={data.affiliation}
          recentUnavailable={data.failedSections.includes(role === 'teacher' ? '班级信息' : '学习记录') || data.failedSections.includes(unexpectedFailureLabel)}
          loading={loading}
        />
      </div>
    </MainLayout>
  );
}

export function PersonalHomePage() {
  const user = useAppSelector(selectCurrentUser);
  const role: HomeRole = user?.role === 'teacher' ? 'teacher' : 'student';
  const [data, setData] = useState<PersonalHomeData>(() => loadingData[role]);
  const [loading, setLoading] = useState(true);
  const loadControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoading(true);
    try {
      const nextData = role === 'teacher'
        ? await loadTeacherHomeData(controller.signal)
        : await loadStudentHomeData(controller.signal);
      if (!controller.signal.aborted) setData(nextData);
    } catch (error) {
      if (!controller.signal.aborted && !isRequestCancelled(error)) {
        setData((currentData) => markHomeUnavailable(currentData));
      }
    } finally {
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [role]);

  useEffect(() => {
    if (user?.role === 'admin') return undefined;

    setData(loadingData[role]);
    void load();
    return () => {
      loadControllerRef.current?.abort();
    };
  }, [load, role, user?.role]);

  if (user?.role === 'admin') {
    return <Navigate to="/admin/dashboard" replace />;
  }

  const displayName = user?.name?.trim() || (role === 'teacher' ? '老师' : '同学');

  return (
    <PersonalHomeView
      role={role}
      displayName={displayName}
      data={data}
      loading={loading}
      onRetry={() => void load()}
    />
  );
}
