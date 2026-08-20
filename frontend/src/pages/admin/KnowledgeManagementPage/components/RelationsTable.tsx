import React from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Plus, Edit, Trash2, Loader2 } from 'lucide-react';
import { RELATION_TYPE_LABELS } from '@/modules/admin/types/knowledgeAdmin';
import type { KnowledgeRelationAdmin } from '@/modules/admin/types/knowledgeAdmin';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';

interface RelationsTableProps {
  relations: KnowledgeRelationAdmin[];
  loading: boolean;
  error: AppError | null;
  onRetry: () => void;
  onAddRelation: () => void;
  onEditRelation: (relation: KnowledgeRelationAdmin) => void;
  onDeleteRelation: (id: string, name: string) => void;
}

export const RelationsTable = React.memo<RelationsTableProps>(
  ({ relations, loading, error, onRetry, onAddRelation, onEditRelation, onDeleteRelation }) => {
    return (
      <div className="space-y-4">
        {/* 关系操作栏 */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-surface-500">共 {relations.length} 条关系</span>
          <Button onClick={onAddRelation}>
            <Plus className="h-4 w-4 mr-1" /> 新增关系
          </Button>
        </div>

        {/* 关系列表 */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
            <span className="ml-2 text-surface-500">加载中...</span>
          </div>
        ) : error ? (
          <RequestErrorNotice error={error} onRetry={onRetry} onRefresh={onRetry} />
        ) : relations.length === 0 ? (
          <div className="text-center py-12 text-surface-400">暂无知识关系数据</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-200 dark:border-surface-700">
                  <th className="text-left py-3 px-4 font-medium text-surface-500">源节点</th>
                  <th className="text-left py-3 px-4 font-medium text-surface-500">关系类型</th>
                  <th className="text-left py-3 px-4 font-medium text-surface-500">目标节点</th>
                  <th className="text-left py-3 px-4 font-medium text-surface-500">权重</th>
                  <th className="text-right py-3 px-4 font-medium text-surface-500">操作</th>
                </tr>
              </thead>
              <tbody>
                {relations.map((rel) => (
                  <tr
                    key={rel.id}
                    className="border-b border-surface-100 dark:border-surface-800 hover:bg-surface-50 dark:hover:bg-surface-800/50"
                  >
                    <td className="py-3 px-4 font-medium text-surface-900 dark:text-surface-100">
                      {rel.source_name || rel.source_id}
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant="secondary">
                        {RELATION_TYPE_LABELS[rel.relation_type] || rel.relation_type}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 font-medium text-surface-900 dark:text-surface-100">
                      {rel.target_name || rel.target_id}
                    </td>
                    <td className="py-3 px-4 text-surface-600 dark:text-surface-400">{rel.weight?.toFixed(2)}</td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => onEditRelation(rel)}>
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-500 hover:text-red-700"
                          onClick={() =>
                            onDeleteRelation(rel.id, `${rel.source_name} → ${rel.target_name}`)
                          }
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
        )}
      </div>
    );
  }
);

RelationsTable.displayName = 'RelationsTable';
