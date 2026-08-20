import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CalendarCheck2,
  Loader2,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/appError';
import {
  getDailyQuestionPresentation,
  type DailyQuestionAssignment,
  type DailyQuestionTone,
} from '../types/dailyQuestion';

interface DailyQuestionStatusEntryProps {
  assignment: DailyQuestionAssignment | null;
  loading: boolean;
  error?: AppError | null;
}

const toneBadge = {
  neutral: 'outline',
  info: 'secondary',
  success: 'success',
  warning: 'warning',
  danger: 'destructive',
} as const satisfies Record<DailyQuestionTone, 'outline' | 'secondary' | 'success' | 'warning' | 'destructive'>;

function getStatusHint(
  assignment: DailyQuestionAssignment | null,
  loading: boolean,
  error?: AppError | null,
): string {
  if (loading) return '正在同步今日任务';
  if (error || !assignment) return '进入每日一题页面后可重试';
  if (assignment.failureCode === 'teacher_not_assigned') return '老师布置后即可开始作答';

  switch (assignment.status) {
    case 'not_started':
      return '今天只安排这一题';
    case 'preparing':
      return '题目准备完成后会固定下来';
    case 'ready':
      return '今日题目已固定';
    case 'completed':
      if (assignment.firstResult === 'incorrect') {
        return assignment.correctedAttemptId
          ? '今日订正已完成'
          : '已计入连续完成，等待订正';
      }
      return `连续完成 ${Math.max(0, assignment.streakDays)} 天，明天继续`;
    case 'unavailable':
      return '进入页面可重试或选择智能刷题';
  }
}

export function DailyQuestionStatusEntry({
  assignment,
  loading,
  error,
}: DailyQuestionStatusEntryProps) {
  const navigate = useNavigate();
  const presentation = getDailyQuestionPresentation(error ? null : assignment);

  return (
    <Card className="border-surface-200 dark:border-surface-700">
      <CardHeader className="border-b border-surface-100 dark:border-surface-800">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex min-w-0 items-center gap-2 text-lg">
            <CalendarCheck2
              className="h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400"
              aria-hidden="true"
            />
            <span className="truncate">每日一题</span>
          </CardTitle>
          <Badge variant={loading ? 'secondary' : toneBadge[presentation.tone]}>
            {loading ? '读取中' : presentation.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-5">
        {error ? (
          <RequestErrorNotice
            error={error}
            onRetry={() => navigate('/daily-question')}
            onRefresh={error.kind === 'conflict' ? () => navigate('/daily-question') : undefined}
          />
        ) : (
          <p className="text-sm leading-6 text-surface-600 dark:text-surface-400">
            {loading ? '正在读取今天的固定题目状态。' : presentation.description}
          </p>
        )}
        <Button
          type="button"
          className="w-full gap-2"
          disabled={loading}
          onClick={() => navigate('/daily-question')}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          )}
          {loading ? '请稍候' : presentation.actionLabel}
        </Button>
        <p className="text-center text-xs text-surface-500 dark:text-surface-400">
          {getStatusHint(assignment, loading, error)}
        </p>
      </CardContent>
    </Card>
  );
}
