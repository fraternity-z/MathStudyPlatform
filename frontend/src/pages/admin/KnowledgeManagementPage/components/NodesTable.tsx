import React from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Search, Plus, Edit, Trash2, Loader2 } from 'lucide-react';
import { NODE_TYPE_LABELS } from '@/modules/admin/types/knowledgeAdmin';
import { NODE_TYPE_OPTIONS } from '../constants';
import type { KnowledgeNodeAdmin } from '@/modules/admin/types/knowledgeAdmin';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';

interface NodesTableProps {
  nodes: KnowledgeNodeAdmin[];
  loading: boolean;
  error: AppError | null;
  onRetry: () => void;
  searchInput: string;
  chapterFilter: string;
  typeFilter: string;
  chapters: string[];
  nodePage: number;
  nodeTotalPages: number;
  nodeTotal: number;
  onSearchChange: (value: string) => void;
  onChapterFilterChange: (value: string) => void;
  onTypeFilterChange: (value: string) => void;
  onPageChange: (page: number) => void;
  onAddNode: () => void;
  onEditNode: (node: KnowledgeNodeAdmin) => void;
  onDeleteNode: (id: string, name: string) => void;
}

export const NodesTable = React.memo<NodesTableProps>(
  ({
    nodes,
    loading,
    error,
    onRetry,
    searchInput,
    chapterFilter,
    typeFilter,
    chapters,
    nodePage,
    nodeTotalPages,
    nodeTotal,
    onSearchChange,
    onChapterFilterChange,
    onTypeFilterChange,
    onPageChange,
    onAddNode,
    onEditNode,
    onDeleteNode,
  }) => {
    const chapterOptions = [
      { value: '', label: '全部章节' },
      ...chapters.map((ch) => ({ value: ch, label: ch })),
    ];

    return (
      <div className="space-y-4">
        {/* 筛选栏 */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-400" />
            <Input
              placeholder="搜索知识点..."
              value={searchInput}
              onChange={(e) => onSearchChange(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select options={chapterOptions} value={chapterFilter} onChange={onChapterFilterChange} />
          <Select options={NODE_TYPE_OPTIONS} value={typeFilter} onChange={onTypeFilterChange} />
          <Button onClick={onAddNode}>
            <Plus className="h-4 w-4 mr-1" /> 新增节点
          </Button>
        </div>

        {/* 节点列表 */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
            <span className="ml-2 text-surface-500">加载中...</span>
          </div>
        ) : error ? (
          <RequestErrorNotice error={error} onRetry={onRetry} onRefresh={onRetry} />
        ) : nodes.length === 0 ? (
          <div className="text-center py-12 text-surface-400">暂无知识节点数据</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-200 dark:border-surface-700">
                    <th className="text-left py-3 px-4 font-medium text-surface-500">名称</th>
                    <th className="text-left py-3 px-4 font-medium text-surface-500">类型</th>
                    <th className="text-left py-3 px-4 font-medium text-surface-500">章节</th>
                    <th className="text-left py-3 px-4 font-medium text-surface-500">难度</th>
                    <th className="text-left py-3 px-4 font-medium text-surface-500">标签</th>
                    <th className="text-right py-3 px-4 font-medium text-surface-500">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((node) => (
                    <tr
                      key={node.id}
                      className="border-b border-surface-100 dark:border-surface-800 hover:bg-surface-50 dark:hover:bg-surface-800/50"
                    >
                      <td className="py-3 px-4">
                        <div>
                          <span className="font-medium text-surface-900 dark:text-surface-100">{node.name}</span>
                          {node.name_en && <span className="ml-2 text-xs text-surface-400">{node.name_en}</span>}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <Badge variant="secondary">{NODE_TYPE_LABELS[node.node_type] || node.node_type}</Badge>
                      </td>
                      <td className="py-3 px-4 text-surface-600 dark:text-surface-400">{node.chapter || '-'}</td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-2 bg-surface-200 dark:bg-surface-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-primary-500 rounded-full"
                              style={{ width: `${(node.difficulty ?? 0.5) * 100}%` }}
                            />
                          </div>
                          <span className="text-xs text-surface-500">{(node.difficulty ?? 0.5).toFixed(1)}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex gap-1 flex-wrap">
                          {(node.tags || []).slice(0, 3).map((tag) => (
                            <Badge key={tag} variant="outline" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                          {(node.tags || []).length > 3 && (
                            <Badge variant="outline" className="text-xs">
                              +{node.tags.length - 3}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => onEditNode(node)}>
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-500 hover:text-red-700"
                            onClick={() => onDeleteNode(node.id, node.name)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 分页 */}
            <div className="flex items-center justify-between pt-2">
              <span className="text-sm text-surface-500">共 {nodeTotal} 条</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={nodePage <= 1}
                  onClick={() => onPageChange(nodePage - 1)}
                >
                  上一页
                </Button>
                <span className="text-sm text-surface-600 dark:text-surface-400">
                  {nodePage} / {nodeTotalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={nodePage >= nodeTotalPages}
                  onClick={() => onPageChange(nodePage + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }
);

NodesTable.displayName = 'NodesTable';
