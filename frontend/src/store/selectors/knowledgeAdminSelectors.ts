/**
 * 知识点管理 Selectors
 *
 * 使用 createSelector 实现记忆化，优化性能
 * 遵循 DRY 原则，使用工厂函数生成通用 selectors
 */

import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from '../index';

// ========== 基础 Selector ==========

const selectKnowledgeAdminState = (state: RootState) => state.knowledgeAdmin;

// ========== 字段 Selectors ==========

export const selectActiveTab = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.activeTab
);

export const selectStats = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.stats
);

export const selectStatsLoading = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.statsLoading
);

export const selectNodes = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.nodes
);

export const selectNodesLoading = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.nodesLoading
);

export const selectNodesError = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.nodesError
);

export const selectNodePage = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.nodePage
);

export const selectNodeTotalPages = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.nodeTotalPages
);

export const selectNodeTotal = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.nodeTotal
);

export const selectSearchTerm = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.searchTerm
);

export const selectChapterFilter = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.chapterFilter
);

export const selectTypeFilter = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.typeFilter
);

export const selectChapters = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.chapters
);

export const selectRelations = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.relations
);

export const selectRelationsLoading = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.relationsLoading
);

export const selectAllNodes = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.allNodes
);

export const selectAllNodesLoading = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.allNodesLoading
);

export const selectAllNodesError = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.allNodesError
);

export const selectNodeModalOpen = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.nodeModalOpen
);

export const selectEditingNode = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.editingNode
);

export const selectRelationModalOpen = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.relationModalOpen
);

export const selectEditingRelation = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.editingRelation
);

export const selectDeleteConfirm = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.deleteConfirm
);

export const selectSaving = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.saving
);

export const selectKnowledgeAdminLoadingState = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.loadingState
);

export const selectKnowledgeAdminError = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.error
);

export const selectIsKnowledgeAdminLoading = createSelector(
  [selectKnowledgeAdminState],
  (state) => state.loadingState === 'loading'
);

// ========== 组合 Selectors (减少组件订阅数) ==========

/**
 * 节点表格所需的全部状态
 */
export const selectNodesTableData = createSelector(
  [selectKnowledgeAdminState],
  (state) => ({
    nodes: state.nodes,
    nodesLoading: state.nodesLoading,
    nodesError: state.nodesError,
    nodePage: state.nodePage,
    nodeTotalPages: state.nodeTotalPages,
    nodeTotal: state.nodeTotal,
    searchTerm: state.searchTerm,
    chapterFilter: state.chapterFilter,
    typeFilter: state.typeFilter,
    chapters: state.chapters,
  })
);

/**
 * 关系表格所需的全部状态
 */
export const selectRelationsData = createSelector(
  [selectKnowledgeAdminState],
  (state) => ({
    relations: state.relations,
    relationsLoading: state.relationsLoading,
    relationsError: state.relationsError,
  })
);

/**
 * 模态框相关状态
 */
export const selectModalState = createSelector(
  [selectKnowledgeAdminState],
  (state) => ({
    nodeModalOpen: state.nodeModalOpen,
    editingNode: state.editingNode,
    relationModalOpen: state.relationModalOpen,
    editingRelation: state.editingRelation,
    deleteConfirm: state.deleteConfirm,
    saving: state.saving,
    allNodes: state.allNodes,
    allNodesLoading: state.allNodesLoading,
    allNodesError: state.allNodesError,
    chapters: state.chapters,
    requestError: state.requestError,
  })
);

// ========== 派生 Selectors (组合逻辑) ==========

/**
 * 是否有筛选条件
 */
export const selectHasFilters = createSelector(
  [selectSearchTerm, selectChapterFilter, selectTypeFilter],
  (searchTerm, chapterFilter, typeFilter) => {
    return !!(searchTerm || chapterFilter || typeFilter);
  }
);

/**
 * 节点筛选参数
 */
export const selectNodeFilterParams = createSelector(
  [selectNodePage, selectChapterFilter, selectTypeFilter, selectSearchTerm],
  (page, chapter, type, search) => ({
    page,
    page_size: 15,
    chapter: chapter || undefined,
    type: type || undefined,
    search: search || undefined,
  })
);

/**
 * 是否显示节点空状态
 */
export const selectShowNodesEmptyState = createSelector(
  [selectNodes, selectNodesLoading, selectHasFilters],
  (nodes, loading, hasFilters) => {
    return !loading && nodes.length === 0 && !hasFilters;
  }
);

/**
 * 是否显示节点无结果状态
 */
export const selectShowNodesNoResults = createSelector(
  [selectNodes, selectNodesLoading, selectHasFilters],
  (nodes, loading, hasFilters) => {
    return !loading && nodes.length === 0 && hasFilters;
  }
);

/**
 * 是否显示关系空状态
 */
export const selectShowRelationsEmptyState = createSelector(
  [selectRelations, selectRelationsLoading],
  (relations, loading) => {
    return !loading && relations.length === 0;
  }
);

/**
 * 分页信息
 */
export const selectPaginationInfo = createSelector(
  [selectNodePage, selectNodeTotalPages, selectNodeTotal],
  (currentPage, totalPages, total) => ({
    currentPage,
    totalPages,
    total,
    hasNextPage: currentPage < totalPages,
    hasPrevPage: currentPage > 1,
  })
);

/**
 * 是否正在执行任何操作
 */
export const selectIsAnyLoading = createSelector(
  [selectStatsLoading, selectNodesLoading, selectRelationsLoading, selectSaving],
  (statsLoading, nodesLoading, relationsLoading, saving) => {
    return statsLoading || nodesLoading || relationsLoading || saving;
  }
);
