import React, { useEffect, useCallback, useMemo, useRef } from 'react';
import { AdminLayout } from '@/modules/admin/components/AdminLayout';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Loader2, RefreshCw } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/store';
import {
  fetchStats,
  fetchChapters,
  fetchNodes,
  fetchRelations,
  fetchAllNodesSimple,
  createNode,
  updateNode,
  deleteNode,
  createRelation,
  updateRelation,
  deleteRelation,
  setActiveTab,
  setSearchTerm,
  setChapterFilter,
  setTypeFilter,
  setNodePage,
  openNodeModal,
  closeNodeModal,
  openRelationModal,
  closeRelationModal,
  setDeleteConfirm,
} from '@/modules/admin/store/knowledgeAdminSlice';
import {
  selectActiveTab,
  selectStats,
  selectStatsLoading,
  selectNodesTableData,
  selectRelationsData,
  selectModalState,
  selectNodeFilterParams,
} from '@/store/selectors/knowledgeAdminSelectors';
import type {
  KnowledgeNodeCreateData,
  KnowledgeNodeUpdateData,
  KnowledgeRelationCreateData,
  KnowledgeRelationUpdateData,
} from '@/modules/admin/types/knowledgeAdmin';
import { StatsCards } from './components/StatsCards';
import { NodesTable } from './components/NodesTable';
import { RelationsTable } from './components/RelationsTable';
import { NodeFormModal } from './components/NodeFormModal';
import { RelationFormModal } from './components/RelationFormModal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RequestErrorNotice } from '@/components/feedback';

const KnowledgeGraphEditor = React.lazy(() =>
  import('./components/KnowledgeGraphEditor').then((module) => ({ default: module.KnowledgeGraphEditor })),
);

/**
 * 知识点管理页面
 *
 * 使用 Redux 进行状态管理，遵循以下原则：
 * - KISS: 简化组件逻辑，状态管理集中在 Redux
 * - DRY: 使用 selectors 避免重复的状态选择逻辑
 * - 单一职责: 组件只负责 UI 渲染和用户交互
 */
export const KnowledgeManagementPage: React.FC = () => {
  const dispatch = useAppDispatch();

  // ========== 状态选择 (使用组合 selectors 减少订阅数) ==========
  const activeTab = useAppSelector(selectActiveTab);
  const stats = useAppSelector(selectStats);
  const statsLoading = useAppSelector(selectStatsLoading);
  const {
    nodes, nodesLoading, nodesError,
    nodePage, nodeTotalPages, nodeTotal,
    searchTerm, chapterFilter, typeFilter, chapters,
  } = useAppSelector(selectNodesTableData);
  const { relations, relationsLoading, relationsError } = useAppSelector(selectRelationsData);
  const {
    nodeModalOpen, editingNode,
    relationModalOpen, editingRelation,
    deleteConfirm, saving, allNodes, allNodesLoading, allNodesError, requestError,
  } = useAppSelector(selectModalState);
  const nodeFilterParams = useAppSelector(selectNodeFilterParams);
  const allNodesRequested = useRef(allNodes.length > 0);

  // ========== 初始化数据加载 ==========
  useEffect(() => {
    dispatch(fetchStats());
    dispatch(fetchChapters());
  }, [dispatch]);

  // ========== 节点列表加载 (依赖筛选条件) ==========
  useEffect(() => {
    dispatch(fetchNodes(nodeFilterParams));
  }, [dispatch, nodeFilterParams]);

  // ========== 关系列表加载 (切换到关系/图谱 tab 时) ==========
  useEffect(() => {
    if (activeTab === 'relations' || activeTab === 'graph') {
      dispatch(fetchRelations());
    }
  }, [dispatch, activeTab]);

  const needsAllNodes = activeTab === 'graph' || relationModalOpen;
  useEffect(() => {
    if (!needsAllNodes || allNodesRequested.current) return;
    allNodesRequested.current = true;
    dispatch(fetchAllNodesSimple());
  }, [dispatch, needsAllNodes]);

  // ========== 节点类型映射 (图谱视图用) ==========
  const nodeTypeMap = useMemo(() => {
    const map = new Map<string, string>();
    allNodes.forEach((n) => {
      if (n.node_type) map.set(n.id, n.node_type);
    });
    return map;
  }, [allNodes]);

  // ========== 搜索防抖 ==========
  const [searchInput, setSearchInput] = React.useState(searchTerm);

  useEffect(() => {
    const timer = setTimeout(() => {
      dispatch(setSearchTerm(searchInput));
    }, 500);
    return () => clearTimeout(timer);
  }, [dispatch, searchInput]);

  // ========== 刷新所有数据 ==========
  const handleRefreshAll = useCallback(() => {
    dispatch(fetchStats());
    dispatch(fetchNodes(nodeFilterParams));
    dispatch(fetchChapters());
    if (activeTab === 'relations' || activeTab === 'graph') dispatch(fetchRelations());
    if (allNodesRequested.current) dispatch(fetchAllNodesSimple());
  }, [activeTab, dispatch, nodeFilterParams]);

  const handleRetryAllNodes = useCallback(() => {
    allNodesRequested.current = true;
    dispatch(fetchAllNodesSimple());
  }, [dispatch]);

  // ========== 节点操作 ==========
  const handleAddNode = useCallback(() => {
    dispatch(openNodeModal(null));
  }, [dispatch]);

  const handleEditNode = useCallback(
    (node: typeof nodes[0]) => {
      dispatch(openNodeModal(node));
    },
    [dispatch]
  );

  const handleDeleteNodeConfirm = useCallback(
    (id: string, name: string) => {
      dispatch(setDeleteConfirm({ type: 'node', id, name }));
    },
    [dispatch]
  );

  const handleSaveNode = useCallback(
    async (data: KnowledgeNodeCreateData | KnowledgeNodeUpdateData) => {
      if (editingNode) {
        await dispatch(updateNode({ nodeId: editingNode.id, data: data as KnowledgeNodeUpdateData })).unwrap();
      } else {
        await dispatch(createNode(data as KnowledgeNodeCreateData)).unwrap();
      }
      // 刷新相关数据
      dispatch(fetchStats());
      dispatch(fetchNodes(nodeFilterParams));
      dispatch(fetchChapters());
      if (allNodesRequested.current) dispatch(fetchAllNodesSimple());
    },
    [dispatch, editingNode, nodeFilterParams]
  );

  // ========== 关系操作 ==========
  const handleAddRelation = useCallback(() => {
    dispatch(openRelationModal(null));
  }, [dispatch]);

  /** 图谱视图中拖拽创建关系 */
  const handleGraphCreateRelation = useCallback(
    async (data: KnowledgeRelationCreateData) => {
      await dispatch(createRelation(data)).unwrap();
      dispatch(fetchStats());
      dispatch(fetchRelations());
    },
    [dispatch],
  );

  const handleEditRelation = useCallback(
    (relation: typeof relations[0]) => {
      dispatch(openRelationModal(relation));
    },
    [dispatch]
  );

  const handleDeleteRelationConfirm = useCallback(
    (id: string, name: string) => {
      dispatch(setDeleteConfirm({ type: 'relation', id, name }));
    },
    [dispatch]
  );

  const handleSaveRelation = useCallback(
    async (data: KnowledgeRelationCreateData | KnowledgeRelationUpdateData) => {
      if (editingRelation) {
        await dispatch(updateRelation({ relationId: editingRelation.id, data: data as KnowledgeRelationUpdateData })).unwrap();
      } else {
        await dispatch(createRelation(data as KnowledgeRelationCreateData)).unwrap();
      }
      // 刷新相关数据
      dispatch(fetchStats());
      dispatch(fetchRelations());
    },
    [dispatch, editingRelation]
  );

  // ========== 删除确认 ==========
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;

    if (deleteConfirm.type === 'node') {
      await dispatch(deleteNode(deleteConfirm.id)).unwrap();
      // 刷新相关数据
      dispatch(fetchStats());
      dispatch(fetchNodes(nodeFilterParams));
      dispatch(fetchRelations());
      if (allNodesRequested.current) dispatch(fetchAllNodesSimple());
    } else {
      await dispatch(deleteRelation(deleteConfirm.id)).unwrap();
      // 刷新相关数据
      dispatch(fetchStats());
      dispatch(fetchRelations());
    }
  }, [dispatch, deleteConfirm, nodeFilterParams]);

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* 页面标题 */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100">知识点管理</h1>
            <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">管理知识图谱中的节点和关系</p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleRefreshAll}>
            <RefreshCw className="h-4 w-4 mr-1" /> 刷新
          </Button>
        </div>

        {/* 统计卡片 */}
        <StatsCards stats={stats} loading={statsLoading} />

        {requestError ? <RequestErrorNotice error={requestError} onRefresh={handleRefreshAll} /> : null}

        {/* 选项卡 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-4">
              <button
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  activeTab === 'nodes'
                    ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                    : 'text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'
                }`}
                onClick={() => dispatch(setActiveTab('nodes'))}
              >
                知识节点
              </button>
              <button
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  activeTab === 'relations'
                    ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                    : 'text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'
                }`}
                onClick={() => dispatch(setActiveTab('relations'))}
              >
                知识关系
              </button>
              <button
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  activeTab === 'graph'
                    ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                    : 'text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'
                }`}
                onClick={() => dispatch(setActiveTab('graph'))}
              >
                图谱视图
              </button>
            </div>
          </CardHeader>
          <CardContent>
            {activeTab === 'nodes' ? (
              <NodesTable
                nodes={nodes}
                loading={nodesLoading}
                error={nodesError}
                onRetry={() => { void dispatch(fetchNodes(nodeFilterParams)); }}
                searchInput={searchInput}
                chapterFilter={chapterFilter}
                typeFilter={typeFilter}
                chapters={chapters}
                nodePage={nodePage}
                nodeTotalPages={nodeTotalPages}
                nodeTotal={nodeTotal}
                onSearchChange={setSearchInput}
                onChapterFilterChange={(value) => dispatch(setChapterFilter(value))}
                onTypeFilterChange={(value) => dispatch(setTypeFilter(value))}
                onPageChange={(page) => dispatch(setNodePage(page))}
                onAddNode={handleAddNode}
                onEditNode={handleEditNode}
                onDeleteNode={handleDeleteNodeConfirm}
              />
            ) : activeTab === 'relations' ? (
              <RelationsTable
                relations={relations}
                loading={relationsLoading}
                error={relationsError}
                onRetry={() => { void dispatch(fetchRelations()); }}
                onAddRelation={handleAddRelation}
                onEditRelation={handleEditRelation}
                onDeleteRelation={handleDeleteRelationConfirm}
              />
            ) : allNodesError ? (
              <RequestErrorNotice error={allNodesError} onRetry={handleRetryAllNodes} onRefresh={handleRetryAllNodes} />
            ) : (
              <React.Suspense fallback={(
                <div className="flex min-h-64 items-center justify-center text-sm text-surface-500">
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中...
                </div>
              )}>
                <KnowledgeGraphEditor
                  allNodes={allNodes}
                  relations={relations}
                  relationsLoading={relationsLoading || allNodesLoading}
                  saving={saving}
                  nodeTypeMap={nodeTypeMap}
                  chapters={chapters}
                  onCreateRelation={handleGraphCreateRelation}
                  onEditRelation={handleEditRelation}
                  onDeleteRelation={handleDeleteRelationConfirm}
                />
              </React.Suspense>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 节点编辑模态框 */}
      {nodeModalOpen && (
        <NodeFormModal
          node={editingNode}
          chapters={chapters}
          saving={saving}
          onSave={handleSaveNode}
          onClose={() => dispatch(closeNodeModal())}
        />
      )}

      {/* 关系编辑模态框 */}
      {relationModalOpen && (
        <RelationFormModal
          relation={editingRelation}
          allNodes={allNodes}
          nodesLoading={allNodesLoading}
          nodesError={allNodesError}
          saving={saving}
          onRetryNodes={handleRetryAllNodes}
          onSave={handleSaveRelation}
          onClose={() => dispatch(closeRelationModal())}
        />
      )}

      {/* 删除确认对话框 */}
      <ConfirmDialog
        isOpen={!!deleteConfirm}
        onClose={() => dispatch(setDeleteConfirm(null))}
        onConfirm={handleConfirmDelete}
        loading={saving}
        title="确认删除"
        message={
          deleteConfirm ? (
            <>
              确定要删除{deleteConfirm.type === 'node' ? '知识节点' : '知识关系'}「
              <span className="font-medium text-surface-900 dark:text-surface-100">{deleteConfirm.name}</span>
              」吗？
              {deleteConfirm.type === 'node' && '关联的所有关系也会被一并删除。'}
              此操作不可撤销。
            </>
          ) : ''
        }
      />
    </AdminLayout>
  );
};

export default KnowledgeManagementPage;
