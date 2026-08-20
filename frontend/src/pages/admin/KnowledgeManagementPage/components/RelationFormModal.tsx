import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Loader2 } from 'lucide-react';
import { RELATION_TYPE_OPTIONS, INPUT_CLASS } from '../constants';
import type {
  KnowledgeRelationAdmin,
  KnowledgeRelationCreateData,
  KnowledgeRelationUpdateData,
  SimpleNode,
} from '@/modules/admin/types/knowledgeAdmin';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';

interface RelationFormModalProps {
  relation: KnowledgeRelationAdmin | null;
  allNodes: SimpleNode[];
  nodesLoading: boolean;
  nodesError: AppError | null;
  saving: boolean;
  onSave: (data: KnowledgeRelationCreateData | KnowledgeRelationUpdateData) => void;
  onRetryNodes: () => void;
  onClose: () => void;
}

export const RelationFormModal = React.memo<RelationFormModalProps>(
  ({ relation, allNodes, nodesLoading, nodesError, saving, onSave, onRetryNodes, onClose }) => {
    const [form, setForm] = useState({
      source_id: relation?.source_id || '',
      target_id: relation?.target_id || '',
      relation_type: relation?.relation_type || 'has_prerequisite',
      weight: relation?.weight ?? 1.0,
      description: relation?.description || '',
    });

    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if (relation) {
        onSave({
          relation_type: form.relation_type as KnowledgeRelationCreateData['relation_type'],
          weight: form.weight,
          description: form.description || undefined,
        });
      } else {
        onSave({
          source_id: form.source_id,
          target_id: form.target_id,
          relation_type: form.relation_type as KnowledgeRelationCreateData['relation_type'],
          weight: form.weight,
          description: form.description || undefined,
        });
      }
    };

    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-surface-900 rounded-xl p-6 max-w-lg w-full mx-4 shadow-xl">
          <h3 className="text-lg font-semibold text-surface-900 dark:text-surface-100 mb-4">
            {relation ? '编辑知识关系' : '新增知识关系'}
          </h3>
          {nodesLoading ? (
            <div className="mb-4 flex items-center justify-center py-4 text-sm text-surface-500">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载节点...
            </div>
          ) : nodesError ? (
            <RequestErrorNotice error={nodesError} onRetry={onRetryNodes} onRefresh={onRetryNodes} className="mb-4" />
          ) : null}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* 源节点 */}
            <div>
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
                源节点 *
              </label>
              <select
                className={INPUT_CLASS}
                value={form.source_id}
                onChange={(e) => setForm((f) => ({ ...f, source_id: e.target.value }))}
                disabled={!!relation || nodesLoading || !!nodesError}
                required
              >
                <option value="">请选择源节点</option>
                {allNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                    {n.chapter ? ` (${n.chapter})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* 关系类型 */}
            <div>
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
                关系类型 *
              </label>
              <select
                className={INPUT_CLASS}
                value={form.relation_type}
                onChange={(e) => setForm((f) => ({ ...f, relation_type: e.target.value }))}
              >
                {RELATION_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 目标节点 */}
            <div>
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
                目标节点 *
              </label>
              <select
                className={INPUT_CLASS}
                value={form.target_id}
                onChange={(e) => setForm((f) => ({ ...f, target_id: e.target.value }))}
                disabled={!!relation || nodesLoading || !!nodesError}
                required
              >
                <option value="">请选择目标节点</option>
                {allNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                    {n.chapter ? ` (${n.chapter})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* 权重 */}
            <div>
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
                权重: {form.weight.toFixed(2)}
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                className="w-full"
                value={form.weight}
                onChange={(e) => setForm((f) => ({ ...f, weight: parseFloat(e.target.value) }))}
              />
            </div>

            {/* 描述 */}
            <div>
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">描述</label>
              <input
                className={INPUT_CLASS}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            {/* 按钮 */}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                取消
              </Button>
              <Button
                type="submit"
                disabled={saving || nodesLoading || !!nodesError || (!relation && (!form.source_id || !form.target_id))}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                {relation ? '保存修改' : '创建关系'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    );
  }
);

RelationFormModal.displayName = 'RelationFormModal';
