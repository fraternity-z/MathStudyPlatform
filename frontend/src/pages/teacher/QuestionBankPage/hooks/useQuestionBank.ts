import { useState, useCallback, useEffect, useRef } from 'react';
import { useDebounce } from '../../../../hooks/useDebounce';
import { useToast } from '../../../../components/ui/Toast';
import { questionService } from '@/modules/question/services/questionService';
import type { Question, QuestionStats } from '@/modules/question/types/question';
import { logger } from '../../../../libs/utils/logger';
import { toAppError, type AppError } from '@/libs/http/apiClient';

const log = logger.createContextLogger('QuestionBankPage');

export function useQuestionBank() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState('');
  const debouncedSearchTerm = useDebounce(searchTerm, 500);
  const [selectedDifficulty, setSelectedDifficulty] = useState('');
  const [selectedType, setSelectedType] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(20);
  const [selectedQuestions, setSelectedQuestions] = useState<string[]>([]);
  const [dailyCandidateUpdatingIds, setDailyCandidateUpdatingIds] = useState<string[]>([]);

  // 数据状态
  const [questions, setQuestions] = useState<Question[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<QuestionStats | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [statsError, setStatsError] = useState<AppError | null>(null);
  const [groupsError, setGroupsError] = useState<AppError | null>(null);

  // 导入/导出模态框状态
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // 更多操作下拉菜单状态
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const questionRequestRef = useRef(0);

  // 筛选状态计算
  const hasActiveFilters = selectedDifficulty !== '' || selectedType !== '' || selectedStatus !== '' || selectedGroup !== '' || searchTerm !== '';

  const resetFilters = () => {
    setSearchTerm('');
    setSelectedDifficulty('');
    setSelectedType('');
    setSelectedStatus('');
    setSelectedGroup('');
    setCurrentPage(1);
  };

  // 加载题目列表
  const loadQuestions = useCallback(async () => {
    const requestID = questionRequestRef.current + 1;
    questionRequestRef.current = requestID;
    setLoading(true);
    setError(null);
    try {
      const response = await questionService.listQuestions({
        page: currentPage,
        pageSize,
        search: debouncedSearchTerm || undefined,
        difficulty: selectedDifficulty || undefined,
        type: selectedType || undefined,
        status: selectedStatus || undefined,
        group: selectedGroup || undefined,
        sortBy: 'created_at',
        sortOrder: 'desc',
      });
      if (questionRequestRef.current !== requestID) return;
      setQuestions(response.items);
      setTotal(response.total);
      log.info('题目列表加载成功', { total: response.total });
    } catch (err) {
      if (questionRequestRef.current !== requestID) return;
      log.error('加载题目列表失败', err);
      setError(toAppError(err, '加载题目列表失败，请稍后重试'));
    } finally {
      if (questionRequestRef.current === requestID) setLoading(false);
    }
  }, [currentPage, pageSize, debouncedSearchTerm, selectedDifficulty, selectedType, selectedStatus, selectedGroup]);

  // 加载统计数据
  const loadStats = async () => {
    setStatsError(null);
    try {
      const statsData = await questionService.getStats();
      setStats(statsData);
      log.info('统计数据加载成功', statsData);
    } catch (err) {
      log.error('加载统计数据失败', err);
      setStatsError(toAppError(err, '题目统计加载失败，请稍后重试'));
    }
  };

  // 加载分组列表
  const loadGroups = async () => {
    setGroupsError(null);
    try {
      const groupsData = await questionService.getGroups();
      setGroups(groupsData);
    } catch (err) {
      log.error('加载分组列表失败', err);
      setGroupsError(toAppError(err, '题目分组加载失败，请稍后重试'));
    }
  };

  // 初始加载
  useEffect(() => {
    void loadQuestions();
    void loadStats();
    void loadGroups();
    return () => {
      questionRequestRef.current += 1;
    };
  }, [loadQuestions]);

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

  // 筛选条件变化时重置到第1页
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearchTerm, selectedDifficulty, selectedType, selectedStatus, selectedGroup]);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    if (!openMenuId) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openMenuId]);

  const toggleSelectQuestion = (id: string) => {
    setSelectedQuestions((prev) =>
      prev.includes(id) ? prev.filter((qId) => qId !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selectedQuestions.length === questions.length) {
      setSelectedQuestions([]);
    } else {
      setSelectedQuestions(questions.map((q) => q.id));
    }
  };

  // 批量发布
  const handleBatchPublish = async () => {
    if (selectedQuestions.length === 0) return;
    try {
      setLoading(true);
      const result = await questionService.batchPublish(selectedQuestions);
      log.info('批量发布完成', result);
      toast({
        type: 'success',
        title: `成功发布 ${result.success} 道题目`,
        description: result.failed > 0 ? `失败 ${result.failed} 道` : undefined,
      });
      setSelectedQuestions([]);
      await loadQuestions();
      await loadStats();
    } catch (err) {
      log.error('批量发布失败', err);
      notifyRequestError(err, '批量发布失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  // 批量删除
  const handleBatchDelete = async () => {
    if (selectedQuestions.length === 0) return;
    if (!confirm(`确定要删除选中的 ${selectedQuestions.length} 道题目吗？此操作不可恢复。`)) return;
    try {
      setLoading(true);
      const result = await questionService.batchDelete(selectedQuestions);
      log.info('批量删除完成', result);
      toast({
        type: 'success',
        title: `成功删除 ${result.success} 道题目`,
        description: result.failed > 0 ? `失败 ${result.failed} 道` : undefined,
      });
      setSelectedQuestions([]);
      await loadQuestions();
      await loadStats();
    } catch (err) {
      log.error('批量删除失败', err);
      notifyRequestError(err, '批量删除失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  // 批量复制
  const handleBatchDuplicate = async () => {
    if (selectedQuestions.length === 0) return;
    try {
      setLoading(true);
      const result = await questionService.batchDuplicate(selectedQuestions);
      log.info('批量复制完成', result);
      toast({
        type: 'success',
        title: `成功复制 ${result.success} 道题目`,
        description: result.failed > 0 ? `失败 ${result.failed} 道` : undefined,
      });
      setSelectedQuestions([]);
      await loadQuestions();
      await loadStats();
    } catch (err) {
      log.error('批量复制失败', err);
      notifyRequestError(err, '批量复制失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  // 单题复制
  const handleDuplicate = async (questionId: string) => {
    try {
      setOpenMenuId(null);
      const result = await questionService.batchDuplicate([questionId]);
      if (result.success > 0) {
        toast({ type: 'success', title: '题目复制成功' });
        await loadQuestions();
        await loadStats();
      } else {
        toast({ type: 'error', title: '复制失败' });
      }
    } catch (error) {
      notifyRequestError(error, '复制失败，请稍后重试');
    }
  };

  // 单题状态变更
  const handleStatusChange = async (questionId: string, newStatus: string) => {
    try {
      setOpenMenuId(null);
      await questionService.updateQuestion(questionId, { status: newStatus });
      const statusLabels: Record<string, string> = {
        published: '已发布',
        draft: '已转为草稿',
        archived: '已归档',
      };
      toast({ type: 'success', title: `题目${statusLabels[newStatus] || '状态已更新'}` });
      await loadQuestions();
      await loadStats();
    } catch (statusError) {
      notifyRequestError(statusError, '状态更新失败，请稍后重试');
    }
  };

  const handleDailyCandidateChange = async (questionId: string, enabled: boolean) => {
    const question = questions.find((item) => item.id === questionId);
    if (enabled && question?.status !== 'published') {
      toast({ type: 'error', title: '只有已发布题目可以设为每日题候选' });
      return;
    }

    setDailyCandidateUpdatingIds((ids) => ids.includes(questionId) ? ids : [...ids, questionId]);
    try {
      await questionService.setDailyCandidate(questionId, enabled);
      toast({
        type: 'success',
        title: enabled ? '已设为每日题候选' : '已取消每日题候选',
      });
      await loadQuestions();
    } catch (error) {
      notifyRequestError(error, '每日题候选状态更新失败，请稍后重试');
    } finally {
      setDailyCandidateUpdatingIds((ids) => ids.filter((id) => id !== questionId));
    }
  };

  // 单题删除
  const handleDeleteSingle = async (questionId: string) => {
    setOpenMenuId(null);
    if (!confirm('确定要删除此题目吗？此操作不可恢复。')) return;
    try {
      await questionService.deleteQuestion(questionId);
      toast({ type: 'success', title: '题目已删除' });
      await loadQuestions();
      await loadStats();
    } catch (deleteError) {
      notifyRequestError(deleteError, '删除失败，请稍后重试');
    }
  };

  return {
    // 筛选状态
    searchTerm, setSearchTerm,
    selectedDifficulty, setSelectedDifficulty,
    selectedType, setSelectedType,
    selectedStatus, setSelectedStatus,
    selectedGroup, setSelectedGroup,
    currentPage, setCurrentPage,
    pageSize,
    hasActiveFilters,
    resetFilters,
    // 数据
    questions, total, stats, groups, loading, error, statsError, groupsError, dailyCandidateUpdatingIds,
    // 选择
    selectedQuestions, toggleSelectQuestion, toggleSelectAll,
    // 批量操作
    handleBatchPublish, handleBatchDelete, handleBatchDuplicate,
    // 单题操作
    handleDuplicate, handleStatusChange, handleDailyCandidateChange, handleDeleteSingle,
    // 菜单
    openMenuId, setOpenMenuId, menuRef,
    // 模态框
    importModalOpen, setImportModalOpen,
    exportModalOpen, setExportModalOpen,
    // 刷新
    loadQuestions, loadStats, loadGroups,
  };
}
