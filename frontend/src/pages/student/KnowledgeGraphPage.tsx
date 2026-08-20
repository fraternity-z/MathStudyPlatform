import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box,
  Boxes,
  CircleDot,
  List,
  PanelRightOpen,
  Route,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { buildKnowledgeGraphIndex } from '@/libs/graph';
import { toAppError, toAppErrorFeedback, type AppError } from '@/libs/http/apiClient';
import { cn } from '@/libs/utils/cn';
import {
  KnowledgeGraph,
  KnowledgeGraphLegend,
  type KnowledgeNode,
} from '@/modules/knowledge';
import {
  KnowledgeGraphInspector,
  KnowledgeGraphMobileSheet,
} from '@/modules/knowledge/components/KnowledgeGraphInspector';
import { knowledgeEdgeKey } from '@/modules/knowledge/components/graphRendererTypes';
import {
  readStoredKnowledgeGraphViewMode,
  storeKnowledgeGraphViewMode,
} from '@/modules/knowledge/hooks/useKnowledgeGraphMode';
import { knowledgeService } from '@/modules/knowledge/services/knowledgeService';
import { fetchKnowledgeGraph, selectNode, updateFilter } from '@/modules/knowledge/store/knowledgeSlice';
import type {
  KnowledgeGraphExperienceMode,
  KnowledgeGraphViewMode,
  LearningPathItem,
  ResolvedKnowledgeGraphViewMode,
} from '@/modules/knowledge/types/knowledge';
import { useAppDispatch, useAppSelector } from '@/store';

type MasteryFilter = 'all' | 'mastered' | 'learning' | 'weak';

const typeOptions = [
  { value: '', label: '全部类型' },
  { value: 'concept', label: '概念' },
  { value: 'theorem', label: '定理' },
  { value: 'method', label: '方法' },
];

const masteryOptions = [
  { value: 'all', label: '全部掌握度' },
  { value: 'mastered', label: '已掌握' },
  { value: 'learning', label: '学习中' },
  { value: 'weak', label: '薄弱' },
];

const viewModes: Array<{ value: KnowledgeGraphViewMode; label: string; icon: typeof Box }> = [
  { value: 'auto', label: '自动', icon: SlidersHorizontal },
  { value: '3d', label: '3D', icon: Box },
  { value: '2d', label: '2D', icon: Boxes },
  { value: 'list', label: '列表', icon: List },
];

export const KnowledgeGraphPage = () => {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const focusNodeId = searchParams.get('focus')?.trim() || null;
  const appliedFocusNodeId = useRef<string | null>(null);
  const { toast } = useToast();
  const { nodes, edges, statistics, filters, selectedNodeId, loadingState, requestError } = useAppSelector(
    (state) => state.knowledge,
  );

  const [localSearchTerm, setLocalSearchTerm] = useState('');
  const [chapterOptions, setChapterOptions] = useState([{ value: '', label: '全部章节' }]);
  const [chapterError, setChapterError] = useState<AppError | null>(null);
  const [chapterRequestKey, setChapterRequestKey] = useState(0);
  const [masteryFilter, setMasteryFilter] = useState<MasteryFilter>('all');
  const [experienceMode, setExperienceMode] = useState<KnowledgeGraphExperienceMode>('explore');
  const [viewMode, setViewMode] = useState<KnowledgeGraphViewMode>(readStoredKnowledgeGraphViewMode);
  const [resolvedViewMode, setResolvedViewMode] = useState<ResolvedKnowledgeGraphViewMode>('2d');
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const [targetNodeId, setTargetNodeId] = useState<string | null>(null);
  const [goalLoading, setGoalLoading] = useState(true);
  const [goalSaving, setGoalSaving] = useState(false);
  const [goalError, setGoalError] = useState<AppError | null>(null);
  const [path, setPath] = useState<LearningPathItem[]>([]);
  const [pathLoading, setPathLoading] = useState(false);
  const [pathError, setPathError] = useState<AppError | null>(null);
  const [pathRequestVersion, setPathRequestVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void knowledgeService.getLearningGoal(controller.signal)
      .then((goal) => {
        setTargetNodeId(goal.target_id);
        setGoalError(null);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setGoalError(toAppError(requestError, '学习目标加载失败'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setGoalLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setChapterError(null);
    void knowledgeService.getChapters(controller.signal)
      .then((chapters) => {
        if (controller.signal.aborted) return;
        setChapterOptions([
          { value: '', label: '全部章节' },
          ...chapters.map((chapter) => ({ value: chapter, label: chapter })),
        ]);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setChapterError(toAppError(error, '章节筛选加载失败'));
        }
      });
    return () => controller.abort();
  }, [chapterRequestKey]);

  const retryChapters = useCallback(() => {
    setChapterRequestKey((value) => value + 1);
  }, []);

  useEffect(() => {
    const request = dispatch(fetchKnowledgeGraph(filters));
    return () => request.abort();
  }, [dispatch, filters]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (localSearchTerm !== (filters.search ?? '')) {
        dispatch(updateFilter({ key: 'search', value: localSearchTerm || undefined }));
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [dispatch, filters.search, localSearchTerm]);

  useEffect(() => {
    if (!targetNodeId) {
      setPath([]);
      setPathError(null);
      setPathLoading(false);
      return;
    }
    const controller = new AbortController();
    setPathLoading(true);
    setPathError(null);
    void knowledgeService.getLearningPath(targetNodeId, controller.signal)
      .then((response) => setPath(response.path))
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setPathError(toAppError(requestError, '目标路径加载失败'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPathLoading(false);
      });
    return () => controller.abort();
  }, [pathRequestVersion, targetNodeId]);

  const graphIndex = useMemo(() => buildKnowledgeGraphIndex(nodes, edges), [edges, nodes]);
  const selectedNode = selectedNodeId ? graphIndex.nodesById.get(selectedNodeId) ?? null : null;

  const visibleNodes = useMemo(
    () => nodes.filter((node) => matchesMasteryFilter(node, masteryFilter)),
    [masteryFilter, nodes],
  );
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    [edges, visibleNodeIds],
  );

  const pathNodeIds = useMemo(() => new Set(path.map((item) => item.id)), [path]);
  const highlightedNodeIds = useMemo(() => {
    if (experienceMode === 'path' && targetNodeId) {
      const ids = new Set(pathNodeIds);
      ids.add(targetNodeId);
      return ids;
    }
    if (!selectedNodeId) return EMPTY_SET;
    const ids = new Set<string>([selectedNodeId]);
    for (const edge of visibleEdges) {
      if (edge.source === selectedNodeId || edge.target === selectedNodeId) {
        ids.add(edge.source);
        ids.add(edge.target);
      }
    }
    return ids;
  }, [experienceMode, pathNodeIds, selectedNodeId, targetNodeId, visibleEdges]);

  const highlightedEdgeKeys = useMemo(() => {
    const keys = new Set<string>();
    if (experienceMode !== 'path') return keys;
    for (const edge of visibleEdges) {
      if (
        edge.relation === 'prerequisite'
        && pathNodeIds.has(edge.source)
        && pathNodeIds.has(edge.target)
      ) {
        keys.add(knowledgeEdgeKey(edge));
      }
    }
    return keys;
  }, [experienceMode, pathNodeIds, visibleEdges]);

  const handleNodeSelect = useCallback((nodeId: string) => {
    dispatch(selectNode(nodeId));
    setMobileSheetOpen(true);
  }, [dispatch]);

  const handleNodeClick = useCallback((node: KnowledgeNode) => {
    handleNodeSelect(node.id);
  }, [handleNodeSelect]);

  useEffect(() => {
    if (!focusNodeId) {
      appliedFocusNodeId.current = null;
      return;
    }
    if (appliedFocusNodeId.current === focusNodeId) return;
    if (!nodes.some((node) => node.id === focusNodeId)) return;

    appliedFocusNodeId.current = focusNodeId;
    handleNodeSelect(focusNodeId);
  }, [focusNodeId, handleNodeSelect, nodes]);

  const handleSetGoal = useCallback(async (node: KnowledgeNode) => {
    const previousTarget = targetNodeId;
    setGoalSaving(true);
    setGoalError(null);
    setTargetNodeId(node.id);
    setExperienceMode('path');
    try {
      const goal = await knowledgeService.setLearningGoal(node.id);
      setTargetNodeId(goal.target_id);
      toast({ type: 'success', title: '学习目标已更新', description: node.label });
    } catch (requestError) {
      setTargetNodeId(previousTarget);
      const appError = toAppError(requestError, '学习目标保存失败');
      setGoalError(appError);
      const feedback = toAppErrorFeedback(appError);
      if (feedback) toast(feedback);
    } finally {
      setGoalSaving(false);
    }
  }, [targetNodeId, toast]);

  const handleExplain = useCallback((node: KnowledgeNode) => {
    const prerequisites = graphIndex.prerequisiteEdgesByTarget.get(node.id) ?? [];
    const prerequisiteNames = prerequisites
      .map((edge) => graphIndex.nodesById.get(edge.source)?.label)
      .filter((label): label is string => Boolean(label));
    navigate('/session/new', {
      state: {
        mode: 'explain',
        topic: `知识点讲解 · ${node.label}`.slice(0, 36),
        initialMessage: [
          `【知识点讲解：${node.label}】`,
          `章节：${node.chapter || '未分章节'}`,
          `当前掌握度：${Math.round(node.mastery * 100)}%`,
          `先修知识：${prerequisiteNames.join('、') || '无'}`,
          '',
          node.description || '该知识点暂未补充说明。',
          '',
          '请先用直觉和一个具体例子解释，再梳理关键步骤与常见误区，最后给我一道不直接提供答案的自测题。',
        ].join('\n'),
      },
    });
  }, [graphIndex, navigate]);

  const handlePractice = useCallback((node: KnowledgeNode) => {
    navigate(`/exercise?mode=ai&concept_id=${encodeURIComponent(node.id)}&autostart=1`);
  }, [navigate]);

  const handleMistakes = useCallback((node: KnowledgeNode) => {
    navigate(`/mistake-book?view=library&concept_id=${encodeURIComponent(node.id)}`);
  }, [navigate]);

  const handleOpenLearningPath = useCallback(() => {
    navigate(targetNodeId ? `/learning-path?target=${encodeURIComponent(targetNodeId)}` : '/learning-path');
  }, [navigate, targetNodeId]);

  const handleViewModeChange = useCallback((mode: KnowledgeGraphViewMode) => {
    setViewMode(mode);
    storeKnowledgeGraphViewMode(mode);
  }, []);

  const inspector = (
    <KnowledgeGraphInspector
      nodes={visibleNodes}
      graphIndex={graphIndex}
      selectedNode={selectedNode}
      targetNodeId={targetNodeId}
      path={path}
      pathLoading={pathLoading}
      pathError={pathError}
      goalSaving={goalSaving}
      goalError={goalError}
      onSelectNode={handleNodeSelect}
      onExplain={handleExplain}
      onPractice={handlePractice}
      onMistakes={handleMistakes}
      onSetGoal={handleSetGoal}
      onOpenLearningPath={handleOpenLearningPath}
      onRetryPath={() => setPathRequestVersion((value) => value + 1)}
    />
  );

  const initialLoading = loadingState === 'loading' && nodes.length === 0;
  const initialError = loadingState === 'error' && nodes.length === 0;

  return (
    <MainLayout showFooter={false}>
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-[1600px] flex-col px-3 py-4 sm:px-6 sm:py-5">
        <header className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <CircleDot className="h-5 w-5 text-amber-600" aria-hidden="true" />
              <h1 className="text-2xl font-bold tracking-normal text-surface-950 dark:text-white">知识星图</h1>
            </div>
            <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">
              {targetNodeId
                ? `当前目标：${graphIndex.nodesById.get(targetNodeId)?.label || '已设置知识点'}`
                : goalLoading ? '正在读取学习目标...' : '尚未设置学习目标'}
            </p>
          </div>
          <div className="flex items-center gap-4 text-sm text-surface-500 dark:text-surface-400">
            <span><strong className="font-semibold text-surface-900 dark:text-white">{statistics?.total_nodes ?? 0}</strong> 个节点</span>
            <span><strong className="font-semibold text-emerald-600 dark:text-emerald-400">{statistics ? Math.round(statistics.overall_mastery * 100) : 0}%</strong> 掌握度</span>
            <span className="hidden sm:inline">{resolvedViewMode.toUpperCase()} 视图</span>
          </div>
        </header>

        <GraphControls
          experienceMode={experienceMode}
          viewMode={viewMode}
          search={localSearchTerm}
          chapter={filters.chapter ?? ''}
          type={filters.type ?? ''}
          mastery={masteryFilter}
          chapterOptions={chapterOptions}
          onExperienceModeChange={setExperienceMode}
          onViewModeChange={handleViewModeChange}
          onSearchChange={setLocalSearchTerm}
          onChapterChange={(value) => dispatch(updateFilter({ key: 'chapter', value: value || undefined }))}
          onTypeChange={(value) => dispatch(updateFilter({ key: 'type', value: value || undefined }))}
          onMasteryChange={(value) => setMasteryFilter(value as MasteryFilter)}
        />

        {chapterError ? (
          <RequestErrorNotice
            error={chapterError}
            onRetry={retryChapters}
            onRefresh={retryChapters}
            onDismiss={() => setChapterError(null)}
            className="mb-3"
          />
        ) : null}

        {initialLoading ? (
          <div className="flex min-h-[560px] flex-1 items-center justify-center rounded-md border border-surface-200 bg-white text-sm text-surface-500 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-400">
            正在加载知识星图...
          </div>
        ) : initialError ? (
          <div className="flex min-h-[560px] flex-1 items-center justify-center rounded-md border border-surface-200 bg-white px-6 dark:border-surface-700 dark:bg-surface-900">
            <RequestErrorNotice
              error={requestError ?? toAppError(null, '知识星图加载失败')}
              onRetry={() => void dispatch(fetchKnowledgeGraph(filters))}
              onRefresh={() => void dispatch(fetchKnowledgeGraph(filters))}
              className="w-full max-w-xl"
            />
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0">
              {visibleNodes.length ? (
                <KnowledgeGraph
                  nodes={visibleNodes}
                  edges={visibleEdges}
                  selectedNodeId={selectedNodeId}
                  targetNodeId={targetNodeId}
                  highlightedNodeIds={highlightedNodeIds}
                  highlightedEdgeKeys={highlightedEdgeKeys}
                  viewMode={viewMode}
                  onResolvedViewModeChange={setResolvedViewMode}
                  onNodeClick={handleNodeClick}
                  height="clamp(560px, calc(100vh - 245px), 760px)"
                />
              ) : (
                <div className="flex h-[560px] items-center justify-center rounded-md border border-surface-200 bg-white text-sm text-surface-500 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-400">
                  没有匹配的知识点
                </div>
              )}
              <div className="mt-2 flex min-h-8 items-center justify-between gap-3 overflow-x-auto px-1">
                <KnowledgeGraphLegend />
                {loadingState === 'loading' ? <span className="shrink-0 text-xs text-surface-400">正在更新...</span> : null}
              </div>
            </div>

            <aside className="hidden h-[clamp(560px,calc(100vh-245px),760px)] min-h-0 overflow-hidden rounded-md border border-surface-200 bg-white lg:flex dark:border-surface-700 dark:bg-surface-900">
              {inspector}
            </aside>
          </div>
        )}
      </div>

      {(selectedNode || targetNodeId) && !mobileSheetOpen ? (
        <button
          type="button"
          onClick={() => setMobileSheetOpen(true)}
          className="fixed bottom-4 right-4 z-30 inline-flex h-11 w-11 items-center justify-center rounded-md bg-primary-600 text-white shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 lg:hidden"
          title="打开学习导航"
          aria-label="打开学习导航"
        >
          <PanelRightOpen className="h-5 w-5" />
        </button>
      ) : null}

      <KnowledgeGraphMobileSheet open={mobileSheetOpen} onClose={() => setMobileSheetOpen(false)}>
        <KnowledgeGraphInspector
          nodes={visibleNodes}
          graphIndex={graphIndex}
          selectedNode={selectedNode}
          targetNodeId={targetNodeId}
          path={path}
          pathLoading={pathLoading}
          pathError={pathError}
          goalSaving={goalSaving}
          goalError={goalError}
          onSelectNode={handleNodeSelect}
          onExplain={handleExplain}
          onPractice={handlePractice}
          onMistakes={handleMistakes}
          onSetGoal={handleSetGoal}
          onOpenLearningPath={handleOpenLearningPath}
          onRetryPath={() => setPathRequestVersion((value) => value + 1)}
          onClose={() => setMobileSheetOpen(false)}
        />
      </KnowledgeGraphMobileSheet>
    </MainLayout>
  );
};

function GraphControls({
  experienceMode,
  viewMode,
  search,
  chapter,
  type,
  mastery,
  chapterOptions,
  onExperienceModeChange,
  onViewModeChange,
  onSearchChange,
  onChapterChange,
  onTypeChange,
  onMasteryChange,
}: {
  experienceMode: KnowledgeGraphExperienceMode;
  viewMode: KnowledgeGraphViewMode;
  search: string;
  chapter: string;
  type: string;
  mastery: MasteryFilter;
  chapterOptions: Array<{ value: string; label: string }>;
  onExperienceModeChange: (mode: KnowledgeGraphExperienceMode) => void;
  onViewModeChange: (mode: KnowledgeGraphViewMode) => void;
  onSearchChange: (value: string) => void;
  onChapterChange: (value: string) => void;
  onTypeChange: (value: string) => void;
  onMasteryChange: (value: string) => void;
}) {
  return (
    <div className="mb-3 flex flex-col gap-2 rounded-md border border-surface-200 bg-white p-2 dark:border-surface-700 dark:bg-surface-900 xl:flex-row xl:items-center">
      <div className="flex h-10 shrink-0 items-center rounded-md bg-surface-100 p-1 dark:bg-surface-800" role="group" aria-label="学习视角">
        <ModeButton active={experienceMode === 'explore'} onClick={() => onExperienceModeChange('explore')}>
          <CircleDot className="h-4 w-4" />探索
        </ModeButton>
        <ModeButton active={experienceMode === 'path'} onClick={() => onExperienceModeChange('path')}>
          <Route className="h-4 w-4" />目标路径
        </ModeButton>
      </div>

      <div className="relative min-w-44 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          className="pl-9"
          placeholder="搜索知识点"
          aria-label="搜索知识点"
        />
      </div>
      <div className="grid grid-cols-3 gap-2 xl:flex xl:w-auto">
        <Select className="min-w-0 xl:w-36" options={chapterOptions} value={chapter} onChange={onChapterChange} aria-label="章节" />
        <Select className="min-w-0 xl:w-28" options={typeOptions} value={type} onChange={onTypeChange} aria-label="类型" />
        <Select className="min-w-0 xl:w-32" options={masteryOptions} value={mastery} onChange={onMasteryChange} aria-label="掌握度" />
      </div>

      <div className="flex h-10 shrink-0 items-center overflow-x-auto rounded-md bg-surface-100 p-1 dark:bg-surface-800" role="group" aria-label="图谱视图">
        {viewModes.map((option) => {
          const Icon = option.icon;
          return (
            <ModeButton key={option.value} active={viewMode === option.value} onClick={() => onViewModeChange(option.value)}>
              <Icon className="h-4 w-4" />{option.label}
            </ModeButton>
          );
        })}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
        active
          ? 'bg-white text-surface-950 shadow-sm dark:bg-surface-700 dark:text-white'
          : 'text-surface-500 hover:text-surface-900 dark:text-surface-400 dark:hover:text-white',
      )}
    >
      {children}
    </button>
  );
}

function matchesMasteryFilter(node: KnowledgeNode, filter: MasteryFilter): boolean {
  if (filter === 'mastered') return node.mastery >= 0.8;
  if (filter === 'learning') return node.mastery >= 0.4 && node.mastery < 0.8;
  if (filter === 'weak') return node.mastery < 0.4;
  return true;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
