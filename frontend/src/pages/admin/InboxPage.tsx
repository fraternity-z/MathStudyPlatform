import React, { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/modules/admin/components/AdminLayout';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import {
  Inbox,
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  AlertCircle,
  Copy,
} from 'lucide-react';
import { passwordResetService } from '@/modules/password-reset/services/passwordResetService';
import type {
  PasswordResetRequestItem,
  PasswordResetReviewResponse,
} from '@/modules/password-reset/types/passwordReset';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';
import { isAdminRequestCancelled, toAdminAppError } from '@/modules/admin/utils/errorFeedback';

type TabFilter = 'all' | 'pending' | 'approved' | 'rejected';

const STATUS_MAP: Record<string, { label: string; variant: 'default' | 'success' | 'destructive' | 'warning' }> = {
  pending: { label: '待审批', variant: 'warning' },
  approved: { label: '已通过', variant: 'success' },
  rejected: { label: '已拒绝', variant: 'destructive' },
};

export const InboxPage: React.FC = () => {
  const [items, setItems] = useState<PasswordResetRequestItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [tab, setTab] = useState<TabFilter>('all');
  const [page, setPage] = useState(1);
  const pageSize = 15;

  // 审批弹窗状态
  const [reviewTarget, setReviewTarget] = useState<PasswordResetRequestItem | null>(null);
  const [reviewAction, setReviewAction] = useState<'approve' | 'reject'>('approve');
  const [rejectReason, setRejectReason] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [reviewResult, setReviewResult] = useState<PasswordResetReviewResponse | null>(null);
  const [reviewError, setReviewError] = useState<AppError | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await passwordResetService.listRequests({
        status: tab === 'all' ? undefined : tab,
        page,
        page_size: pageSize,
      }, signal);
      if (signal?.aborted) return;
      setItems(res.items);
      setTotal(res.total);
      setPendingCount(res.pending_count);
    } catch (error) {
      if (signal?.aborted || isAdminRequestCancelled(error)) return;
      setLoadError(toAdminAppError(error, '加载密码重置申请失败'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [tab, page]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const handleReview = async () => {
    if (!reviewTarget) return;
    setReviewing(true);
    setReviewError(null);
    try {
      const res = await passwordResetService.review(reviewTarget.id, {
        action: reviewAction,
        reject_reason: reviewAction === 'reject' ? rejectReason : undefined,
      });
      setReviewResult(res);
      await fetchData();
    } catch (error) {
      if (!isAdminRequestCancelled(error)) {
        setReviewError(toAdminAppError(error, '审批操作失败，请稍后重试'));
      }
    } finally {
      setReviewing(false);
    }
  };

  const closeReviewModal = () => {
    setReviewTarget(null);
    setRejectReason('');
    setReviewResult(null);
    setReviewError(null);
  };

  const openReview = (item: PasswordResetRequestItem, action: 'approve' | 'reject') => {
    setReviewTarget(item);
    setReviewAction(action);
    setRejectReason('');
    setReviewResult(null);
    setReviewError(null);
  };

  const tabs: { key: TabFilter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'pending', label: `待审批${pendingCount > 0 ? ` (${pendingCount})` : ''}` },
    { key: 'approved', label: '已通过' },
    { key: 'rejected', label: '已拒绝' },
  ];

  const totalPages = Math.ceil(total / pageSize);

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* 页面标题 */}
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100 flex items-center gap-3">
            <Inbox className="w-7 h-7 text-primary-600 dark:text-primary-400" />
            信箱
          </h1>
          <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">
            管理密码重置申请与临时密码通知
          </p>
        </div>

        {/* 统计卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4 flex items-center gap-4">
              <div className="w-10 h-10 bg-orange-100 dark:bg-orange-900/30 rounded-lg flex items-center justify-center">
                <Clock className="w-5 h-5 text-orange-600 dark:text-orange-400" />
              </div>
              <div>
                <p className="text-2xl font-bold text-surface-900 dark:text-surface-100">{pendingCount}</p>
                <p className="text-xs text-surface-500">待审批</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-4">
              <div className="w-10 h-10 bg-emerald-100 dark:bg-emerald-900/30 rounded-lg flex items-center justify-center">
                <CheckCircle className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-2xl font-bold text-surface-900 dark:text-surface-100">{total - pendingCount}</p>
                <p className="text-xs text-surface-500">已处理</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-4">
              <div className="w-10 h-10 bg-primary-100 dark:bg-primary-900/30 rounded-lg flex items-center justify-center">
                <Inbox className="w-5 h-5 text-primary-600 dark:text-primary-400" />
              </div>
              <div>
                <p className="text-2xl font-bold text-surface-900 dark:text-surface-100">{total}</p>
                <p className="text-xs text-surface-500">总申请</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 标签页 + 表格 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  onClick={() => { setTab(t.key); setPage(1); }}
                  className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                    tab === t.key
                      ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400'
                      : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-primary-600" />
              </div>
            ) : loadError ? (
              <RequestErrorNotice
                error={loadError}
                onRetry={() => void fetchData()}
                onRefresh={() => void fetchData()}
              />
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-surface-400">
                <Inbox className="w-12 h-12 mb-3" />
                <p className="text-sm">暂无申请记录</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-surface-200 dark:border-surface-700">
                        <th className="text-left py-3 px-4 font-medium text-surface-500">用户名</th>
                        <th className="text-left py-3 px-4 font-medium text-surface-500">邮箱</th>
                        <th className="text-left py-3 px-4 font-medium text-surface-500">申请理由</th>
                        <th className="text-left py-3 px-4 font-medium text-surface-500">申请时间</th>
                        <th className="text-left py-3 px-4 font-medium text-surface-500">状态</th>
                        <th className="text-left py-3 px-4 font-medium text-surface-500">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id} className="border-b border-surface-100 dark:border-surface-800 hover:bg-surface-50 dark:hover:bg-surface-800/50">
                          <td className="py-3 px-4 text-surface-900 dark:text-surface-100 font-medium">{item.username}</td>
                          <td className="py-3 px-4 text-surface-600 dark:text-surface-400">{item.email}</td>
                          <td className="py-3 px-4 text-surface-600 dark:text-surface-400 max-w-48 truncate">{item.reason || '-'}</td>
                          <td className="py-3 px-4 text-surface-500 dark:text-surface-400 whitespace-nowrap">
                            {new Date(item.created_at).toLocaleString('zh-CN')}
                          </td>
                          <td className="py-3 px-4">
                            <Badge variant={STATUS_MAP[item.status]?.variant || 'default'}>
                              {STATUS_MAP[item.status]?.label || item.status}
                            </Badge>
                          </td>
                          <td className="py-3 px-4">
                            {item.status === 'pending' ? (
                              <div className="flex items-center gap-2">
                                <Button size="sm" variant="primary" onClick={() => openReview(item, 'approve')}>
                                  <CheckCircle className="w-3.5 h-3.5 mr-1" />
                                  通过
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => openReview(item, 'reject')}>
                                  <XCircle className="w-3.5 h-3.5 mr-1" />
                                  拒绝
                                </Button>
                              </div>
                            ) : (
                              <span className="text-surface-400 text-xs">已处理</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* 分页 */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4 pt-4 border-t border-surface-200 dark:border-surface-700">
                    <p className="text-sm text-surface-500">共 {total} 条记录</p>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                        上一页
                      </Button>
                      <span className="text-sm text-surface-600 dark:text-surface-400">
                        {page} / {totalPages}
                      </span>
                      <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                        下一页
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* 审批弹窗 */}
        <Modal
          isOpen={!!reviewTarget}
          onClose={closeReviewModal}
          title={reviewResult ? '审批结果' : (reviewAction === 'approve' ? '确认通过' : '拒绝申请')}
        >
          {reviewError ? (
            <RequestErrorNotice
              error={reviewError}
              onRetry={() => void handleReview()}
              onRefresh={() => void fetchData()}
            />
          ) : reviewResult ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-surface-700 dark:text-surface-300">{reviewResult.message}</p>
              {reviewResult.temp_password ? (
                <div className="flex items-center gap-2 rounded-md border border-surface-200 bg-surface-50 p-3 dark:border-surface-700 dark:bg-surface-800">
                  <code className="min-w-0 flex-1 break-all text-left text-sm font-semibold text-surface-900 dark:text-surface-100">
                    {reviewResult.temp_password}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void navigator.clipboard.writeText(reviewResult.temp_password ?? '')}
                    title="复制临时密码"
                    aria-label="复制临时密码"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
              {reviewResult.email_notification ? (
                <div
                  role="status"
                  className={`flex items-center gap-2 rounded-md border p-3 text-left text-sm ${
                    reviewResult.email_notification.status === 'sent'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300'
                      : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300'
                  }`}
                >
                  {reviewResult.email_notification.status === 'sent' ? (
                    <CheckCircle className="h-4 w-4 shrink-0" />
                  ) : (
                    <AlertCircle className="h-4 w-4 shrink-0" />
                  )}
                  <span>{reviewResult.email_notification.message}</span>
                </div>
              ) : null}
              <Button onClick={closeReviewModal} className="w-full">确定</Button>
            </div>
          ) : reviewAction === 'approve' ? (
            <div className="space-y-4">
              <p className="text-sm text-surface-700 dark:text-surface-300">
                确认通过用户 <span className="font-semibold">{reviewTarget?.username}</span> 的密码重置申请？
              </p>
              <div className="p-3 bg-orange-50 dark:bg-orange-900/20 rounded-lg">
                <p className="text-xs text-orange-700 dark:text-orange-300 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  通过后系统会生成临时密码并发送到申请邮箱
                </p>
              </div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={closeReviewModal} disabled={reviewing}>
                  取消
                </Button>
                <Button className="flex-1" onClick={handleReview} disabled={reviewing}>
                  {reviewing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                  确认通过
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-surface-700 dark:text-surface-300">
                拒绝用户 <span className="font-semibold">{reviewTarget?.username}</span> 的密码重置申请
              </p>
              <div>
                <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                  拒绝理由（可选）
                </label>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="请输入拒绝理由"
                  className="w-full px-4 py-2.5 rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 text-surface-900 dark:text-surface-100 text-sm placeholder:text-surface-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none"
                  rows={3}
                />
              </div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={closeReviewModal} disabled={reviewing}>
                  取消
                </Button>
                <Button variant="destructive" className="flex-1" onClick={handleReview} disabled={reviewing}>
                  {reviewing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                  确认拒绝
                </Button>
              </div>
            </div>
          )}
        </Modal>
      </div>
    </AdminLayout>
  );
};
