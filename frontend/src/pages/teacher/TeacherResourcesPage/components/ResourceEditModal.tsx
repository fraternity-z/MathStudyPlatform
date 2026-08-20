import React, { useState } from 'react';
import type { Resource, ResourceUpdateRequest } from '@/modules/resource/types/resource';
import { Modal } from '../../../../components/ui/Modal';
import { Button } from '../../../../components/ui/Button';
import { Input } from '../../../../components/ui/Input';
import { Loader2, Check } from 'lucide-react';
import { RequestErrorNotice } from '@/components/feedback';
import { toAppError, type AppError } from '@/libs/http/apiClient';
import { resourceService } from '@/modules/resource/services/resourceService';

interface ResourceEditModalProps {
  resource: Resource | null;
  onClose: () => void;
  onSuccess: () => void;
}

export const ResourceEditModal = React.memo<ResourceEditModalProps>(({ resource, onClose, onSuccess }) => {
  const [formData, setFormData] = useState<ResourceUpdateRequest>({
    title: resource?.title || '',
    type: resource?.type || 'video',
    body: resource?.body || '',
    chapter: resource?.chapter || '',
    topic: resource?.topic || '',
    source: resource?.source || '',
    url: resource?.url || '',
    duration: resource?.duration || '',
    pages: resource?.pages || undefined,
    storage_type: resource?.storage_type || undefined,
  });
  const [submitError, setSubmitError] = useState<AppError | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // 当 resource 变化时更新表单数据
  React.useEffect(() => {
    if (resource) {
      setFormData({
        title: resource.title,
        type: resource.type,
        body: resource.body || '',
        chapter: resource.chapter || '',
        topic: resource.topic || '',
        source: resource.source || '',
        url: resource.url || '',
        duration: resource.duration || '',
        pages: resource.pages || undefined,
        storage_type: resource.storage_type || undefined,
      });
    }
  }, [resource]);

  const handleSubmit = async () => {
    if (!resource || !formData.title?.trim()) return;

    setSubmitError(null);
    setIsSaving(true);
    try {
      await resourceService.updateResource(resource.id, formData);
      onSuccess();
    } catch (error) {
      setSubmitError(toAppError(error, '更新资源失败'));
    } finally {
      setIsSaving(false);
    }
  };

  if (!resource) return null;

  return (
    <Modal isOpen={!!resource} onClose={onClose} title="编辑资源">
      <div className="space-y-4">
        {submitError ? (
          <RequestErrorNotice error={submitError} onDismiss={() => setSubmitError(null)} />
        ) : null}
        <div>
          <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
            资源标题 *
          </label>
          <Input
            value={formData.title || ''}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            placeholder="输入资源标题"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
            资源类型 *
          </label>
          <select
            value={formData.type || 'video'}
            onChange={(e) => setFormData({ ...formData, type: e.target.value as 'video' | 'document' })}
            className="w-full px-3 py-2 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="video">视频</option>
            <option value="document">文档</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
            资源链接
          </label>
          <Input
            value={formData.url || ''}
            onChange={(e) => setFormData({ ...formData, url: e.target.value })}
            placeholder="输入资源 URL"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
              来源
            </label>
            <Input
              value={formData.source || ''}
              onChange={(e) => setFormData({ ...formData, source: e.target.value })}
              placeholder="如：3Blue1Brown"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
              主题
            </label>
            <Input
              value={formData.topic || ''}
              onChange={(e) => setFormData({ ...formData, topic: e.target.value })}
              placeholder="如：极限"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
              章节
            </label>
            <Input
              value={formData.chapter || ''}
              onChange={(e) => setFormData({ ...formData, chapter: e.target.value })}
              placeholder="如：第一章"
            />
          </div>
          {formData.type === 'video' ? (
            <div>
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
                时长
              </label>
              <Input
                value={formData.duration || ''}
                onChange={(e) => setFormData({ ...formData, duration: e.target.value })}
                placeholder="如：18:32"
              />
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
                页数
              </label>
              <Input
                type="number"
                value={formData.pages || ''}
                onChange={(e) =>
                  setFormData({ ...formData, pages: e.target.value ? parseInt(e.target.value) : undefined })
                }
                placeholder="如：45"
              />
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
            描述
          </label>
          <textarea
            value={formData.body || ''}
            onChange={(e) => setFormData({ ...formData, body: e.target.value })}
            placeholder="输入资源描述..."
            rows={3}
            className="w-full px-3 py-2 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
          />
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving || !formData.title?.trim()}>
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                保存中...
              </>
            ) : (
              <>
                <Check className="w-4 h-4 mr-2" />
                保存
              </>
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
});

ResourceEditModal.displayName = 'ResourceEditModal';
