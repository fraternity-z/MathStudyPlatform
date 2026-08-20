import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  BookOpenCheck,
  Edit3,
  ListOrdered,
  Loader2,
  LockKeyhole,
  Plus,
  Save,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { RequestErrorNotice } from '@/components/feedback';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { toAppError, type AppError } from '@/libs/http/apiClient';
import { MathText } from '@/libs/math/MathText';
import { questionService } from '@/modules/question/services/questionService';
import type { Question, QuestionCreateData } from '@/modules/question/types/question';
import type { ImportResult } from '@/modules/question/types/questionImport';
import { QuestionImportModal } from '@/pages/teacher/QuestionBankPage/components/QuestionImportModal';
import { dailyQuestionService } from '../services/dailyQuestionService';
import type {
  DailyQuestionUniformScheduleItem,
} from '../types/dailyQuestion';

interface UniformQuestionScheduleProps {
  classId: string;
  onSaved?: () => void;
  onTodayAssignedChange?: (assigned: boolean) => void;
}

interface ScheduleDraftItem extends DailyQuestionUniformScheduleItem {
  status: Question['status'];
}

interface StoredScheduleDraft {
  scheduleVersion: number;
  items: ScheduleDraftItem[];
}

const maxScheduleItems = 60;
const questionBankPageSize = 50;

const shanghaiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const displayDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  weekday: 'short',
  timeZone: 'UTC',
});

function getShanghaiISODate(): string {
  const parts = new Map(
    shanghaiDateFormatter.formatToParts(new Date()).map(({ type, value }) => [type, value]),
  );
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

function addCalendarDays(date: string, offset: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + offset));
  return value.toISOString().slice(0, 10);
}

function assignScheduleDates(items: ScheduleDraftItem[], startDate: string): ScheduleDraftItem[] {
  return items.map((item, index) => ({
    ...item,
    assignmentDate: addCalendarDays(startDate, index),
  }));
}

function formatScheduleDate(date: string, today: string): string {
  if (date === today) return '今天';
  return displayDateFormatter.format(new Date(`${date}T00:00:00Z`));
}

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

function fromScheduleItem(item: DailyQuestionUniformScheduleItem): ScheduleDraftItem {
  return { ...item, status: 'published' };
}

function fromQuestion(question: Question, assignmentDate: string): ScheduleDraftItem {
  return {
    assignmentDate,
    contentId: question.id,
    targetConceptId: question.conceptIds[0] ?? null,
    title: question.title,
    body: question.body,
    difficulty: question.difficulty,
    locked: false,
    status: question.status,
  };
}

function sameOrder(left: ScheduleDraftItem[], right: ScheduleDraftItem[]): boolean {
  return left.length === right.length
    && left.every((item, index) => item.contentId === right[index]?.contentId);
}

function hasDuplicateContentIDs(items: ScheduleDraftItem[]): boolean {
  return new Set(items.map((item) => item.contentId)).size !== items.length;
}

function selectUniqueScheduleAdditions(
  items: ScheduleDraftItem[],
  questions: Question[],
): { additions: Question[]; duplicateCount: number } {
  const scheduledIDs = new Set(items.map((item) => item.contentId));
  const additions: Question[] = [];
  let duplicateCount = 0;
  for (const question of questions) {
    if (scheduledIDs.has(question.id)) {
      duplicateCount += 1;
      continue;
    }
    scheduledIDs.add(question.id);
    additions.push(question);
  }
  return { additions, duplicateCount };
}

function duplicateAdditionMessage(count: number): string {
  return count === 1
    ? '该题已在日程中，不能重复安排'
    : `已跳过 ${count} 道重复题目，同一道题不能重复安排`;
}

function storageKey(classId: string): string {
  return `daily-question-uniform-schedule:${classId}`;
}

function readStoredDraft(classId: string): StoredScheduleDraft | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(classId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const stored = value as Partial<StoredScheduleDraft>;
    if (
      typeof stored.scheduleVersion !== 'number'
      || !Number.isSafeInteger(stored.scheduleVersion)
      || stored.scheduleVersion < 0
      || !Array.isArray(stored.items)
      || stored.items.length > maxScheduleItems
    ) return null;
    const items = stored.items.filter((item): item is ScheduleDraftItem => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<ScheduleDraftItem>;
      return typeof candidate.contentId === 'string'
        && candidate.contentId.length > 0
        && typeof candidate.title === 'string'
        && typeof candidate.body === 'string'
        && typeof candidate.difficulty === 'number'
        && (candidate.status === 'draft'
          || candidate.status === 'published'
          || candidate.status === 'archived');
    });
    if (items.length !== stored.items.length || new Set(items.map((item) => item.contentId)).size !== items.length) {
      return null;
    }
    return { scheduleVersion: stored.scheduleVersion, items };
  } catch {
    return null;
  }
}

function writeStoredDraft(
  classId: string,
  scheduleVersion: number,
  items: ScheduleDraftItem[] | null,
): void {
  try {
    if (items) {
      window.sessionStorage.setItem(storageKey(classId), JSON.stringify({ scheduleVersion, items }));
    } else {
      window.sessionStorage.removeItem(storageKey(classId));
    }
  } catch {
    // The server remains the source of truth when session storage is unavailable.
  }
}

export function UniformQuestionSchedule({
  classId,
  onSaved,
  onTodayAssignedChange,
}: UniformQuestionScheduleProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const today = getShanghaiISODate();
  const [scheduleStartDate, setScheduleStartDate] = useState(today);
  const [scheduleVersion, setScheduleVersion] = useState(0);
  const [persistedItems, setPersistedItems] = useState<ScheduleDraftItem[]>([]);
  const [draftItems, setDraftItems] = useState<ScheduleDraftItem[]>([]);
  const [questionOptions, setQuestionOptions] = useState<Question[]>([]);
  const [questionGroups, setQuestionGroups] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [questionBankPage, setQuestionBankPage] = useState(1);
  const [questionBankTotal, setQuestionBankTotal] = useState(0);
  const [selectedQuestions, setSelectedQuestions] = useState<Question[]>([]);
  const [positionDrafts, setPositionDrafts] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isQuestionBankLoading, setIsQuestionBankLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [questionBankError, setQuestionBankError] = useState<AppError | null>(null);
  const [loadedScheduleClassId, setLoadedScheduleClassId] = useState<string | null>(null);
  const questionBankRequestRef = useRef(0);
  const draftItemsRef = useRef<ScheduleDraftItem[]>([]);

  const isScheduleLoaded = loadedScheduleClassId === classId;
  const isDirty = !sameOrder(draftItems, persistedItems);
  const draftOrderKey = useMemo(
    () => draftItems.map((item) => item.contentId).join('|'),
    [draftItems],
  );
  const persistedTodayAssigned = persistedItems.some((item) => item.assignmentDate === today);
  const persistedStartAssigned = persistedItems.some(
    (item) => item.assignmentDate === scheduleStartDate,
  );
  const returnPath = `/teacher/class/${encodeURIComponent(classId)}?tab=daily-question`;

  const normalizeDraftDates = useCallback((items: ScheduleDraftItem[]) => (
    assignScheduleDates(items, scheduleStartDate)
  ), [scheduleStartDate]);

  const loadSchedule = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    setError(null);
    setLoadedScheduleClassId(null);
    try {
      const schedule = await dailyQuestionService.getUniformSchedule(classId, signal);
      if (signal?.aborted) return;

      const nextStartDate = schedule.startDate || today;
      const nextPersisted = schedule.items.map(fromScheduleItem);
      const stored = readStoredDraft(classId);
      const storedItems = stored?.scheduleVersion === schedule.scheduleVersion ? stored.items : null;
      const storedStartsOnDate = !storedItems?.length || storedItems[0].assignmentDate === nextStartDate;
      const storedKeepsLocks = storedStartsOnDate && storedItems?.every((item, index) => (
        !nextPersisted[index]?.locked || item.contentId === nextPersisted[index].contentId
      ));
      const restored = storedItems?.map((item, index) => ({
        ...item,
        locked: nextPersisted[index]?.locked ?? false,
      }));
      setScheduleStartDate(nextStartDate);
      setScheduleVersion(schedule.scheduleVersion);
      setPersistedItems(nextPersisted);
      setDraftItems(
        restored && storedKeepsLocks
          ? assignScheduleDates(restored, nextStartDate)
          : nextPersisted,
      );
      setLoadedScheduleClassId(classId);
    } catch (loadError) {
      if (signal?.aborted) return;
      setError(toAppError(loadError, '统一题日程加载失败'));
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, [classId, today]);

  const loadQuestionBank = useCallback(async () => {
    const requestID = questionBankRequestRef.current + 1;
    questionBankRequestRef.current = requestID;
    setIsQuestionBankLoading(true);
    setQuestionBankError(null);
    try {
      const [questionList, groups] = await Promise.all([
        questionService.listQuestions({
          page: questionBankPage,
          pageSize: questionBankPageSize,
          group: selectedGroup || undefined,
          status: 'active',
          sortBy: 'created_at',
          sortOrder: 'desc',
        }),
        questionService.getGroups(),
      ]);
      if (questionBankRequestRef.current !== requestID) return;
      const availableQuestions = questionList.items;
      setQuestionGroups(groups);
      setQuestionOptions(availableQuestions);
      setQuestionBankTotal(questionList.total);
      setSelectedQuestions((current) => current.map((selected) => (
        availableQuestions.find((question) => question.id === selected.id) ?? selected
      )));
    } catch (loadError) {
      if (questionBankRequestRef.current !== requestID) return;
      setQuestionOptions([]);
      setQuestionBankTotal(0);
      setQuestionBankError(toAppError(loadError, '题库加载失败'));
    } finally {
      if (questionBankRequestRef.current === requestID) {
        setIsQuestionBankLoading(false);
      }
    }
  }, [questionBankPage, selectedGroup]);

  const formatRequestError = useCallback((requestError: unknown, fallback: string): string => {
    const appError = toAppError(requestError, fallback);
    return [
      appError.message,
      appError.retryAfter !== undefined && appError.retryAfter > 0
        ? `可在 ${appError.retryAfter} 秒后重试`
        : '',
      appError.requestId ? `请求编号：${appError.requestId}` : '',
    ].filter(Boolean).join('；');
  }, []);

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

  useEffect(() => {
    const controller = new AbortController();
    void loadSchedule(controller.signal);
    return () => controller.abort();
  }, [loadSchedule]);

  useEffect(() => {
    void loadQuestionBank();
    return () => {
      questionBankRequestRef.current += 1;
    };
  }, [loadQuestionBank]);

  useEffect(() => {
    draftItemsRef.current = draftItems;
  }, [draftItems]);

  useEffect(() => {
    const scheduledIDs = new Set(draftItems.map((item) => item.contentId));
    const remainingCapacity = Math.max(0, maxScheduleItems - draftItems.length);
    setSelectedQuestions((current) => {
      const next = current
        .filter((question) => !scheduledIDs.has(question.id))
        .slice(0, remainingCapacity);
      return next.length === current.length
        && next.every((question, index) => question.id === current[index]?.id)
        ? current
        : next;
    });
  }, [draftItems]);

  useEffect(() => {
    setPositionDrafts({});
  }, [draftOrderKey]);

  useEffect(() => {
    if (!isScheduleLoaded) return;
    onTodayAssignedChange?.(persistedTodayAssigned);
  }, [isScheduleLoaded, onTodayAssignedChange, persistedTodayAssigned]);

  useEffect(() => {
    if (isLoading || !isScheduleLoaded) return;
    writeStoredDraft(classId, scheduleVersion, isDirty ? draftItems : null);
  }, [classId, draftItems, isDirty, isLoading, isScheduleLoaded, scheduleVersion]);

  useEffect(() => {
    const contentId = searchParams.get('daily_question_content_id')?.trim();
    if (!contentId || isLoading || !isScheduleLoaded) return;
    let cancelled = false;

    const addCreatedQuestion = async () => {
      try {
        const question = await questionService.getQuestion(contentId);
        if (cancelled) return;
        setQuestionOptions((current) => [
          question,
          ...current.filter((item) => item.id !== question.id),
        ]);
        const currentItems = draftItemsRef.current;
        const { additions, duplicateCount } = selectUniqueScheduleAdditions(
          currentItems,
          [question],
        );
        if (duplicateCount > 0) {
          const refreshedItems = currentItems.map((item) => item.contentId === question.id
            ? {
                ...fromQuestion(question, item.assignmentDate),
                locked: item.locked,
              }
            : item);
          draftItemsRef.current = refreshedItems;
          setDraftItems(refreshedItems);
          toast({ type: 'error', title: duplicateAdditionMessage(duplicateCount) });
        } else if (currentItems.length >= maxScheduleItems) {
          toast({ type: 'error', title: '统一题日程最多安排 60 道题' });
        } else {
          const nextItems = normalizeDraftDates([
            ...currentItems,
            fromQuestion(
              additions[0],
              addCalendarDays(scheduleStartDate, currentItems.length),
            ),
          ]);
          draftItemsRef.current = nextItems;
          setDraftItems(nextItems);
          toast({ type: 'success', title: '新建题目已加入待安排列表' });
        }
      } catch (loadError) {
        if (!cancelled) {
          notifyRequestError(loadError, '新建题目读取失败');
        }
      } finally {
        if (!cancelled) {
          const nextParams = new URLSearchParams(searchParams);
          nextParams.delete('daily_question_content_id');
          setSearchParams(nextParams, { replace: true });
        }
      }
    };

    void addCreatedQuestion();
    return () => {
      cancelled = true;
    };
  }, [isLoading, isScheduleLoaded, normalizeDraftDates, notifyRequestError, scheduleStartDate, searchParams, setSearchParams, toast]);

  const toggleQuestionSelection = (question: Question) => {
    if (draftItems.some((item) => item.contentId === question.id)) {
      setSelectedQuestions((current) => current.filter((item) => item.id !== question.id));
      toast({ type: 'error', title: duplicateAdditionMessage(1) });
      return;
    }
    if (selectedQuestions.some((item) => item.id === question.id)) {
      setSelectedQuestions((current) => current.filter((item) => item.id !== question.id));
      return;
    }
    const available = maxScheduleItems - draftItems.length;
    if (selectedQuestions.length >= available) {
      toast({ type: 'error', title: `最多还可选择 ${available} 道题` });
      return;
    }
    setSelectedQuestions((current) => [...current, question]);
  };

  const addSelectedQuestions = () => {
    if (selectedQuestions.length === 0) return;
    if (draftItems.length >= maxScheduleItems) {
      toast({ type: 'error', title: '统一题日程最多安排 60 道题' });
      return;
    }
    const { additions, duplicateCount } = selectUniqueScheduleAdditions(
      draftItems,
      selectedQuestions,
    );
    if (duplicateCount > 0) {
      toast({ type: 'error', title: duplicateAdditionMessage(duplicateCount) });
    }
    const nextItems = normalizeDraftDates([
      ...draftItems,
      ...additions
        .slice(0, maxScheduleItems - draftItems.length)
        .map((question) => fromQuestion(question, today)),
    ]);
    draftItemsRef.current = nextItems;
    setDraftItems(nextItems);
    setSelectedQuestions([]);
  };

  const moveQuestionTo = (index: number, targetIndex: number): boolean => {
    if (hasDuplicateContentIDs(draftItems)) {
      toast({ type: 'error', title: '日程中存在重复题目，同一道题不能安排两次' });
      return false;
    }
    if (targetIndex === index) return true;
    if (targetIndex < 0 || targetIndex >= draftItems.length) {
      toast({ type: 'error', title: `序号请填写 1-${draftItems.length}` });
      return false;
    }
    const rangeStart = Math.min(index, targetIndex);
    const rangeEnd = Math.max(index, targetIndex);
    if (
      draftItems[index].locked
      || draftItems.slice(rangeStart, rangeEnd + 1).some((item) => item.locked)
    ) {
      toast({ type: 'error', title: '已锁定题目不能移动或被跨越' });
      return false;
    }
    setDraftItems((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(targetIndex, 0, moved);
      return normalizeDraftDates(next);
    });
    return true;
  };

  const moveQuestion = (index: number, offset: -1 | 1) => {
    void moveQuestionTo(index, index + offset);
  };

  const commitQuestionPosition = (index: number, contentID: string) => {
    const rawValue = positionDrafts[contentID];
    if (rawValue === undefined) return;
    const position = Number(rawValue);
    if (!Number.isInteger(position) || position < 1 || position > draftItems.length) {
      toast({ type: 'error', title: `序号请填写 1-${draftItems.length}` });
      setPositionDrafts((current) => {
        const next = { ...current };
        delete next[contentID];
        return next;
      });
      return;
    }
    const moved = moveQuestionTo(index, position - 1);
    if (!moved || position - 1 === index) {
      setPositionDrafts((current) => {
        const next = { ...current };
        delete next[contentID];
        return next;
      });
    }
  };

  const removeQuestion = (index: number) => {
    if (draftItems[index]?.locked) return;
    setDraftItems((current) => normalizeDraftDates(current.filter((_, itemIndex) => itemIndex !== index)));
  };

  const saveSchedule = async () => {
    if (isSaving || !isDirty || !isScheduleLoaded) return;
    if (hasDuplicateContentIDs(draftItems)) {
      const message = '日程中存在重复题目，同一道题不能安排两次';
      toast({ type: 'error', title: message });
      return;
    }
    const submittedItems = draftItems;
    draftItemsRef.current = submittedItems;
    setIsSaving(true);
    setError(null);
    try {
      const saved = await dailyQuestionService.setUniformSchedule(
        classId,
        scheduleVersion,
        draftItems.map((item) => item.contentId),
      );
      const nextItems = saved.items.map(fromScheduleItem);
      const nextStartDate = saved.startDate || scheduleStartDate;
      const currentDraft = draftItemsRef.current;
      const draftUnchanged = sameOrder(currentDraft, submittedItems);
      setScheduleStartDate(nextStartDate);
      setScheduleVersion(saved.scheduleVersion);
      setPersistedItems(nextItems);
      if (draftUnchanged) {
        draftItemsRef.current = nextItems;
        setDraftItems(nextItems);
        writeStoredDraft(classId, saved.scheduleVersion, null);
      } else {
        const pendingItems = assignScheduleDates(currentDraft, nextStartDate);
        draftItemsRef.current = pendingItems;
        setDraftItems(pendingItems);
        writeStoredDraft(classId, saved.scheduleVersion, pendingItems);
      }
      toast({
        type: 'success',
        title: draftUnchanged
          ? nextItems.length > 0 ? '班级统一题日程已保存' : '统一题日程已清空'
          : '已保存提交时的日程，后续修改仍待保存',
      });
      onSaved?.();
    } catch (saveError) {
      const appError = toAppError(saveError, '统一题日程保存失败');
      if (appError.kind === 'conflict') {
        writeStoredDraft(classId, scheduleVersion, null);
        setError(appError);
        return;
      }
      notifyRequestError(appError, '统一题日程保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  const importQuestions = async (questions: QuestionCreateData[]): Promise<ImportResult> => {
    const available = maxScheduleItems - draftItems.length;
    const selected = questions.slice(0, available);
    const createdQuestions: Question[] = [];
    const errors: string[] = [];
    for (const [index, question] of selected.entries()) {
      try {
        createdQuestions.push(await questionService.createQuestion(question));
      } catch (createError) {
        errors.push(`第 ${index + 1} 题：${formatRequestError(createError, '导入失败')}`);
      }
    }

    if (createdQuestions.length > 0) {
      const currentItems = draftItemsRef.current;
      const { additions, duplicateCount } = selectUniqueScheduleAdditions(
        currentItems,
        createdQuestions,
      );
      setQuestionOptions((current) => [
        ...createdQuestions,
        ...current.filter((item) => !createdQuestions.some((created) => created.id === item.id)),
      ]);
      if (duplicateCount > 0) {
        toast({ type: 'error', title: duplicateAdditionMessage(duplicateCount) });
      }
      const acceptedAdditions = additions.slice(0, maxScheduleItems - currentItems.length);
      const nextItems = normalizeDraftDates([
        ...currentItems,
        ...acceptedAdditions.map((question, index) => (
          fromQuestion(question, addCalendarDays(scheduleStartDate, currentItems.length + index))
        )),
      ]);
      draftItemsRef.current = nextItems;
      setDraftItems(nextItems);
    }

    return {
      success: createdQuestions.length,
      failed: questions.length - createdQuestions.length,
      errors,
    };
  };

  const selectableOptions = useMemo(() => questionOptions.filter(
    (question) => !draftItems.some((item) => item.contentId === question.id),
  ), [draftItems, questionOptions]);
  const remainingCapacity = Math.max(0, maxScheduleItems - draftItems.length);
  const questionBankTotalPages = Math.ceil(questionBankTotal / questionBankPageSize);

  if (isLoading) {
    return (
      <div className="flex min-h-32 items-center justify-center gap-2 border-y border-surface-200 py-6 text-sm text-surface-500 dark:border-surface-700 dark:text-surface-400">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        正在读取统一题日程
      </div>
    );
  }

  if (!isScheduleLoaded) {
    return (
      <section className="border-y border-surface-200 py-6 dark:border-surface-700">
        <RequestErrorNotice
          error={error ?? {
            kind: 'unknown',
            message: '统一题日程尚未加载，请重试',
            retryable: true,
            source: 'ui',
          }}
          onRetry={() => void loadSchedule()}
          onRefresh={() => void loadSchedule()}
        />
      </section>
    );
  }

  return (
    <section className="space-y-5 border-y border-surface-200 py-5 dark:border-surface-700">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-surface-700 dark:text-surface-300">
            <BookOpenCheck className="h-4 w-4 text-primary-500" aria-hidden="true" />
            班级统一题日程
          </h3>
          <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
            第 1 题用于{formatScheduleDate(scheduleStartDate, today)}，后续题按上海自然日依次布置。学生获得题目后对应日期会锁定。
          </p>
        </div>
        <Badge variant={isDirty ? 'warning' : persistedStartAssigned ? 'success' : 'warning'}>
          {isDirty
            ? '待保存'
            : `${formatScheduleDate(scheduleStartDate, today)}${persistedStartAssigned ? '已布置' : '未布置'}`}
        </Badge>
      </div>

      {error ? (
        <RequestErrorNotice
          error={error}
          onRetry={() => void loadSchedule()}
          onRefresh={() => void loadSchedule()}
        />
      ) : null}

      <fieldset
        disabled={isSaving}
        aria-busy={isSaving}
        className="min-w-0 space-y-5 border-0 p-0"
      >
      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h4 className="text-sm font-medium text-surface-700 dark:text-surface-300">
              从题库添加
            </h4>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <p className="text-xs text-surface-500 dark:text-surface-400">
                {isQuestionBankLoading
                  ? '正在读取题库'
                  : `共 ${questionBankTotal} 道 · 已选 ${selectedQuestions.length} 道`}
              </p>
              {selectedQuestions.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setSelectedQuestions([])}
                >
                  <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  清空选择
                </Button>
              ) : null}
            </div>
          </div>
          <div className="w-full sm:w-48">
            <label
              htmlFor="daily-question-schedule-group"
              className="mb-1.5 block text-xs font-medium text-surface-600 dark:text-surface-400"
            >
              题目分组
            </label>
            <Select
              id="daily-question-schedule-group"
              value={selectedGroup}
              options={[
                { value: '', label: '全部分组' },
                ...questionGroups.map((group) => ({ value: group, label: group })),
              ]}
              onChange={(group) => {
                setSelectedGroup(group);
                setQuestionBankPage(1);
              }}
            />
          </div>
        </div>

        {questionBankError ? (
          <RequestErrorNotice
            error={questionBankError}
            onRetry={() => void loadQuestionBank()}
            onRefresh={() => void loadQuestionBank()}
          />
        ) : null}

        {questionBankError ? null : isQuestionBankLoading ? (
          <div className="flex min-h-28 items-center justify-center gap-2 rounded-md border border-surface-200 text-sm text-surface-500 dark:border-surface-700 dark:text-surface-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            正在读取题库
          </div>
        ) : selectableOptions.length > 0 ? (
          <div
            className="max-h-80 overscroll-contain overflow-y-auto rounded-md border border-surface-200 dark:border-surface-700"
            role="group"
            aria-label="从题库多选统一题"
          >
            <div className="divide-y divide-surface-200 dark:divide-surface-700">
              {selectableOptions.map((question) => {
                const selected = selectedQuestions.some((item) => item.id === question.id);
                return (
                  <label
                    key={question.id}
                    className={`grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-3 px-3 py-3 transition-colors ${
                      selected
                        ? 'bg-primary-50 dark:bg-primary-950/30'
                        : 'hover:bg-surface-50 dark:hover:bg-surface-800/70'
                    }`}
                  >
                    <input
                      type="checkbox"
                      name="daily-question-schedule-content"
                      value={question.id}
                      checked={selected}
                      disabled={!selected && selectedQuestions.length >= remainingCapacity}
                      onChange={() => toggleQuestionSelection(question)}
                      className="mt-1 h-4 w-4 border-surface-300 text-primary-600 focus:ring-primary-500 dark:border-surface-600"
                    />
                    <span className="min-w-0">
                      <span className="block line-clamp-3 text-sm font-medium text-surface-900 dark:text-surface-100">
                        <MathText>{question.body}</MathText>
                      </span>
                      <span className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="max-w-full truncate">
                          {question.title || '未分组'}
                        </Badge>
                        <Badge variant="secondary">{questionTypeLabel(question.type)}</Badge>
                        <Badge variant="outline">{difficultyLabel(question.difficulty)}</Badge>
                        {question.status === 'draft' ? <Badge variant="warning">保存时发布</Badge> : null}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-surface-300 px-4 py-5 text-sm text-surface-500 dark:border-surface-700 dark:text-surface-400">
            {selectedGroup ? '该分组暂无可添加题目' : '题库中暂无可添加题目'}
          </div>
        )}

        {questionBankTotalPages > 1 ? (
          <Pagination
            currentPage={questionBankPage}
            totalPages={questionBankTotalPages}
            onPageChange={setQuestionBankPage}
            className="justify-center"
          />
        ) : null}

        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={selectedQuestions.length === 0 || draftItems.length >= maxScheduleItems}
            onClick={addSelectedQuestions}
          >
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            添加到日程{selectedQuestions.length > 0 ? ` (${selectedQuestions.length})` : ''}
          </Button>
        </div>
      </div>

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
        <Button
          variant="outline"
          disabled={draftItems.length >= maxScheduleItems}
          onClick={() => setIsImportModalOpen(true)}
        >
          <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
          导入题目
        </Button>
      </div>

      {draftItems.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-surface-200 dark:border-surface-700">
          <div className="flex items-center gap-2 border-b border-surface-200 bg-surface-50 px-3 py-2 text-xs font-medium text-surface-500 dark:border-surface-700 dark:bg-surface-800 dark:text-surface-400">
            <ListOrdered className="h-4 w-4" aria-hidden="true" />
            已安排 {draftItems.length} 天
          </div>
          <div className="max-h-96 divide-y divide-surface-200 overflow-y-auto overscroll-contain dark:divide-surface-700">
            {draftItems.map((item, index) => {
              const scheduledDate = item.assignmentDate || addCalendarDays(scheduleStartDate, index);
              return (
                <div
                  key={item.contentId}
                  className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <div className="line-clamp-3 text-sm font-medium text-surface-900 dark:text-surface-100">
                      <MathText>{item.body}</MathText>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">
                        {formatScheduleDate(scheduledDate, today)}
                      </Badge>
                      <span className="text-xs text-surface-500 dark:text-surface-400">
                        {scheduledDate}
                      </span>
                      <Badge variant="outline" className="max-w-full truncate">
                        {item.title || '未分组'}
                      </Badge>
                      <Badge variant="outline">{difficultyLabel(item.difficulty)}</Badge>
                      {item.status === 'draft' ? <Badge variant="warning">保存时发布</Badge> : null}
                      {item.locked ? (
                        <Badge variant="secondary">
                          <LockKeyhole className="mr-1 h-3 w-3" aria-hidden="true" />
                          已锁定
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    <label className="mr-1 flex items-center gap-1 text-xs text-surface-500 dark:text-surface-400">
                      序号
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={draftItems.length}
                        step={1}
                        value={positionDrafts[item.contentId] ?? String(index + 1)}
                        disabled={item.locked}
                        aria-label={`调整 ${item.title || '题目'} 的日程序号`}
                        title={item.locked ? '学生已获得题目，不能调整序号' : '直接填写目标序号'}
                        className="h-9 w-16 px-2 text-center"
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) => setPositionDrafts((current) => ({
                          ...current,
                          [item.contentId]: event.target.value,
                        }))}
                        onBlur={() => commitQuestionPosition(index, item.contentId)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="上移"
                      aria-label={`上移 ${item.title || '题目'}`}
                      disabled={index === 0 || item.locked || draftItems[index - 1]?.locked}
                      onClick={() => moveQuestion(index, -1)}
                    >
                      <ArrowUp className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="下移"
                      aria-label={`下移 ${item.title || '题目'}`}
                      disabled={
                        index === draftItems.length - 1
                        || item.locked
                        || draftItems[index + 1]?.locked
                      }
                      onClick={() => moveQuestion(index, 1)}
                    >
                      <ArrowDown className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title={item.locked ? '学生已获得题目，不能编辑' : '编辑题目'}
                      aria-label={`编辑 ${item.title || '题目'}`}
                      disabled={item.locked}
                      onClick={() => navigate(
                        `/teacher/question/${encodeURIComponent(item.contentId)}/edit?return_to=${encodeURIComponent(returnPath)}`,
                      )}
                    >
                      <Edit3 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title={item.locked ? '学生已获得题目，不能移除' : '移除题目'}
                      aria-label={`移除 ${item.title || '题目'}`}
                      disabled={item.locked}
                      onClick={() => removeQuestion(index)}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-amber-300 bg-amber-50/60 px-4 py-5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
          当前尚未布置统一题，学生端会显示“老师未布置”。
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2 border-t border-surface-200 pt-4 dark:border-surface-700">
        <Button
          variant="outline"
          disabled={!isDirty || isSaving}
          onClick={() => setDraftItems(persistedItems)}
        >
          <Undo2 className="mr-2 h-4 w-4" aria-hidden="true" />
          撤销更改
        </Button>
        <Button disabled={!isDirty} isLoading={isSaving} onClick={() => void saveSchedule()}>
          {!isSaving ? <Save className="mr-2 h-4 w-4" aria-hidden="true" /> : null}
          保存日程
        </Button>
      </div>
      </fieldset>

      <QuestionImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        maxSelected={Math.max(1, maxScheduleItems - draftItems.length)}
        importActionLabel="导入到待安排列表"
        completionActionLabel="安排题目顺序"
        onImportQuestions={importQuestions}
        onImportComplete={() => undefined}
      />
    </section>
  );
}
