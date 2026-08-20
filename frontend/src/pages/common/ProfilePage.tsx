import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAppSelector } from '@/store';
import { selectCurrentUser } from '@/modules/auth/store/authSlice';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { User, Mail, School, Lock, ArrowLeft, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { RequestErrorNotice } from '@/components/feedback';
import {
  formatAppErrorDescription,
  isRequestCancelled,
  toAppError,
  type AppError,
} from '@/libs/http/apiClient';
import { passwordChangeSchema, type PasswordChangeFormData } from '@/libs/validation/schemas';
import { authService } from '@/modules/auth/services/authService';
import { useAuth } from '@/modules/auth/hooks/useAuth';
import { xidianService, type XidianBindingStatus, type XidianCaptchaChallenge } from '@/modules/xidian/services/xidianService';
import { WechatBindingSection } from '@/modules/wechat/components/WechatBindingSection';

export const ProfilePage: React.FC = () => {
  const user = useAppSelector(selectCurrentUser);
  const navigate = useNavigate();
  const { handleLogout, isLoggingOut } = useAuth();

  // 修改密码表单状态
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [xidianStatus, setXidianStatus] = useState<XidianBindingStatus | null>(null);
  const [xidianLoading, setXidianLoading] = useState(false);
  const [xidianStatusError, setXidianStatusError] = useState<AppError | null>(null);
  const [bindingModalOpen, setBindingModalOpen] = useState(false);
  const [captchaChallenge, setCaptchaChallenge] = useState<XidianCaptchaChallenge | null>(null);
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [bindingForm, setBindingForm] = useState({ username: '', password: '' });
  const [sliderValue, setSliderValue] = useState(0);
  const [bindingError, setBindingError] = useState<string | AppError | null>(null);
  const [bindingSubmitting, setBindingSubmitting] = useState(false);
  const [xidianActionStatus, setXidianActionStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PasswordChangeFormData>({
    resolver: zodResolver(passwordChangeSchema),
  });

  const onSubmitPasswordChange = async (data: PasswordChangeFormData) => {
    setIsSubmitting(true);
    setSubmitStatus(null);

    try {
      const response = await authService.changePassword({
        old_password: data.currentPassword,
        new_password: data.newPassword,
      });
      setSubmitStatus({ type: 'success', message: response.message || '密码修改成功' });
      reset();
      await handleLogout();
    } catch (error: unknown) {
      if (!isRequestCancelled(error)) {
        setSubmitStatus({
          type: 'error',
          message: formatAppErrorDescription(toAppError(error, '密码修改失败，请重试')),
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const loadXidianStatus = useCallback(async (signal?: AbortSignal) => {
    if (!user?.id) return;
    setXidianLoading(true);
    setXidianStatusError(null);
    try {
      const status = await xidianService.getBindingStatus(signal);
      if (!signal?.aborted) setXidianStatus(status);
    } catch (error) {
      if (!signal?.aborted && !isRequestCancelled(error)) {
        setXidianStatusError(toAppError(error, '西电账号绑定状态加载失败'));
      }
    } finally {
      if (!signal?.aborted) setXidianLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    const controller = new AbortController();
    void loadXidianStatus(controller.signal);
    return () => controller.abort();
  }, [loadXidianStatus]);

  const handleOpenBinding = async () => {
    setBindingModalOpen(true);
    setBindingError(null);
    setSliderValue(0);
    setBindingForm({ username: '', password: '' });
    setCaptchaLoading(true);
    try {
      const challenge = await xidianService.startBinding();
      setCaptchaChallenge(challenge);
    } catch (error) {
      if (!isRequestCancelled(error)) {
        setBindingError(toAppError(error, '验证码加载失败，请稍后重试'));
      }
    } finally {
      setCaptchaLoading(false);
    }
  };

  const handleRefreshCaptcha = async () => {
    setBindingError(null);
    setCaptchaLoading(true);
    try {
      const challenge = await xidianService.startBinding();
      setCaptchaChallenge(challenge);
      setSliderValue(0);
    } catch (error) {
      if (!isRequestCancelled(error)) {
        setBindingError(toAppError(error, '验证码加载失败，请稍后重试'));
      }
    } finally {
      setCaptchaLoading(false);
    }
  };

  const handleCompleteBinding = async () => {
    if (!captchaChallenge) {
      setBindingError('请先获取验证码');
      return;
    }
    setBindingSubmitting(true);
    setBindingError(null);
    try {
      const response = await xidianService.completeBinding({
        challenge_id: captchaChallenge.challenge_id,
        slider_position: sliderValue,
        username: bindingForm.username || undefined,
        password: bindingForm.password || undefined,
      });
      setXidianStatus({
        is_bound: response.is_bound,
        username: response.username,
        last_verified_at: response.last_verified_at,
      });
      setXidianActionStatus({ type: 'success', message: '绑定成功' });
      setBindingModalOpen(false);
      setBindingForm({ username: '', password: '' });
    } catch (error) {
      if (!isRequestCancelled(error)) {
        setBindingError(toAppError(error, '西电账号绑定失败，请稍后重试'));
      }
    } finally {
      setBindingSubmitting(false);
    }
  };

  const handleUnbind = async () => {
    setXidianActionStatus(null);
    try {
      await xidianService.unbind();
      setXidianStatus({ is_bound: false });
      setXidianActionStatus({ type: 'success', message: '已解绑' });
    } catch (error) {
      if (!isRequestCancelled(error)) {
        const appError = toAppError(error, '西电账号解绑失败，请稍后重试');
        setXidianActionStatus({ type: 'error', message: formatAppErrorDescription(appError) });
      }
    }
  };

  const isXidianBound = xidianStatus?.is_bound;
  const lastVerifiedText = xidianStatus?.last_verified_at
    ? new Date(xidianStatus.last_verified_at).toLocaleString()
    : null;

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <Button
        variant="ghost"
        className="mb-4 pl-0 hover:bg-transparent hover:text-primary-600 dark:hover:text-primary-400"
        onClick={() => navigate(-1)}
      >
        <ArrowLeft className="w-4 h-4 mr-2" />
        返回
      </Button>
      <h1 className="text-3xl font-bold mb-8 text-surface-900 dark:text-surface-100">个人中心</h1>

      <div className="grid gap-6">
        {/* Basic Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="w-5 h-5" />
              基本信息
            </CardTitle>
            <CardDescription>查看和管理您的个人基本信息</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-6">
              <div className="h-24 w-24 rounded-full bg-linear-to-tr from-primary-100 to-secondary-100 dark:from-primary-900 dark:to-secondary-900 flex items-center justify-center text-primary-700 dark:text-primary-300 font-bold text-3xl shadow-md">
                <User className="w-12 h-12" />
              </div>
              <div className="min-w-0 space-y-1">
                <h3 className="text-2xl font-bold text-surface-900 dark:text-surface-100">{user?.name || '未登录'}</h3>
                <div className="flex flex-wrap items-center gap-2 text-surface-500 dark:text-surface-400">
                  <span className="whitespace-nowrap px-2 py-0.5 bg-surface-100 dark:bg-surface-700 rounded text-xs font-medium border border-surface-200 dark:border-surface-600">
                    {user?.role === 'student' ? '学生' : user?.role === 'teacher' ? '教师' : '访客'}
                  </span>
                  <span className="break-all text-xs sm:text-sm">ID: {user?.id}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Account Binding */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="w-5 h-5" />
              账号安全与绑定
            </CardTitle>
            <CardDescription>查看注册邮箱并管理学校账户与消息渠道</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Email */}
            <div
              aria-label="注册邮箱"
              className="flex items-center p-4 border border-surface-200 dark:border-surface-700 rounded-lg bg-surface-50/50 dark:bg-surface-800/50"
            >
              <div className="flex items-center gap-4">
                <div className="p-2.5 bg-white dark:bg-surface-700 rounded-full border border-surface-200 dark:border-surface-600 text-surface-600 dark:text-surface-400">
                  <Mail className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-medium text-surface-900 dark:text-surface-100">注册邮箱</p>
                  <p className="text-sm text-surface-500 dark:text-surface-400">
                    {user?.email || '未提供'}
                  </p>
                </div>
              </div>
            </div>

             {/* Xidian Account */}
             <div className="flex flex-col gap-4 p-4 border border-surface-200 dark:border-surface-700 rounded-lg bg-surface-50/50 dark:bg-surface-800/50 hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-4">
                    <div className="p-2.5 bg-white dark:bg-surface-700 rounded-full border border-surface-200 dark:border-surface-600 text-surface-600 dark:text-surface-400">
                        <School className="w-5 h-5" />
                    </div>
                    <div>
                        <p className="font-medium text-surface-900 dark:text-surface-100">西电账号</p>
                        <p className="text-sm text-surface-500 dark:text-surface-400">
                          {xidianLoading
                            ? '加载中...'
                            : isXidianBound
                              ? `已绑定${xidianStatus?.username ? `（${xidianStatus.username}）` : ''}`
                              : '未绑定'}
                        </p>
                        {isXidianBound && (
                          <p className="text-xs text-surface-400 dark:text-surface-500">
                            {lastVerifiedText ? `最近验证：${lastVerifiedText}` : '已验证账户归属'}
                          </p>
                        )}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                  {!xidianStatusError && isXidianBound ? (
                    <Button variant="outline" size="sm" onClick={handleUnbind} className="whitespace-nowrap">
                      解绑
                    </Button>
                  ) : !xidianStatusError ? (
                    <Button variant="outline" size="sm" onClick={handleOpenBinding} className="whitespace-nowrap">
                      绑定
                    </Button>
                  ) : null}
                </div>
            </div>
            {xidianStatusError ? (
              <RequestErrorNotice
                error={xidianStatusError}
                onRetry={() => void loadXidianStatus()}
                onRefresh={() => void loadXidianStatus()}
              />
            ) : null}
            <p className="text-xs text-surface-500 dark:text-surface-400">
              绑定仅用于验证西电账号归属；平台不会保存西电密码或教务会话。
            </p>
            {xidianActionStatus && (
              <div
                className={`flex items-center gap-2 p-3 rounded-lg ${
                  xidianActionStatus.type === 'success'
                    ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                    : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                }`}
              >
                {xidianActionStatus.type === 'success' ? (
                  <CheckCircle className="w-4 h-4" />
                ) : (
                  <XCircle className="w-4 h-4" />
                )}
                <span className="text-sm">{xidianActionStatus.message}</span>
              </div>
            )}
            {(user?.role === 'student' || user?.role === 'teacher') && (
              <WechatBindingSection userId={user.id} />
            )}
          </CardContent>
        </Card>

        {/* Password Change */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="w-5 h-5" />
              修改密码
            </CardTitle>
            <CardDescription>定期修改密码以保护您的账户安全</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 max-w-md">
            <form onSubmit={handleSubmit(onSubmitPasswordChange)} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-surface-700 dark:text-surface-300">当前密码</label>
                <Input
                  type="password"
                  placeholder="请输入当前密码"
                  {...register('currentPassword')}
                  disabled={isSubmitting || isLoggingOut}
                />
                {errors.currentPassword && (
                  <p className="text-sm text-red-500">{errors.currentPassword.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-surface-700 dark:text-surface-300">新密码</label>
                <Input
                  type="password"
                  placeholder="请输入新密码"
                  {...register('newPassword')}
                  disabled={isSubmitting || isLoggingOut}
                />
                {errors.newPassword && (
                  <p className="text-sm text-red-500">{errors.newPassword.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-surface-700 dark:text-surface-300">确认新密码</label>
                <Input
                  type="password"
                  placeholder="请再次输入新密码"
                  {...register('confirmNewPassword')}
                  disabled={isSubmitting || isLoggingOut}
                />
                {errors.confirmNewPassword && (
                  <p className="text-sm text-red-500">{errors.confirmNewPassword.message}</p>
                )}
              </div>

              {/* 提交状态提示 */}
              {submitStatus && (
                <div
                  className={`flex items-center gap-2 p-3 rounded-lg ${
                    submitStatus.type === 'success'
                      ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                      : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                  }`}
                >
                  {submitStatus.type === 'success' ? (
                    <CheckCircle className="w-4 h-4" />
                  ) : (
                    <XCircle className="w-4 h-4" />
                  )}
                  <span className="text-sm">{submitStatus.message}</span>
                </div>
              )}

              <div className="pt-2">
                <Button type="submit" disabled={isSubmitting || isLoggingOut}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      修改中...
                    </>
                  ) : (
                    '修改密码'
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      <Modal
        isOpen={bindingModalOpen}
        onClose={() => setBindingModalOpen(false)}
        title="绑定西电账号"
        className="max-w-lg"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-surface-700 dark:text-surface-300">学号/工号</label>
            <Input
              placeholder="请输入学号/工号"
              value={bindingForm.username}
              onChange={(event) => setBindingForm((prev) => ({ ...prev, username: event.target.value }))}
              disabled={bindingSubmitting}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-surface-700 dark:text-surface-300">密码</label>
            <Input
              type="password"
              placeholder="请输入密码"
              value={bindingForm.password}
              onChange={(event) => setBindingForm((prev) => ({ ...prev, password: event.target.value }))}
              disabled={bindingSubmitting}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-surface-700 dark:text-surface-300">滑块验证码</span>
              <Button variant="ghost" size="sm" onClick={handleRefreshCaptcha} disabled={captchaLoading || bindingSubmitting}>
                刷新
              </Button>
            </div>
            <div className="flex flex-col items-center gap-3">
              {captchaLoading && <span className="text-sm text-surface-500">验证码加载中...</span>}
              {!captchaLoading && captchaChallenge && (
                <>
                  <div
                    className="relative overflow-hidden rounded-lg border border-surface-200 dark:border-surface-700"
                    style={{ width: captchaChallenge.puzzle_width, height: captchaChallenge.puzzle_height }}
                  >
                    <img
                      src={`data:image/png;base64,${captchaChallenge.captcha_big}`}
                      alt="captcha"
                      className="h-full w-full object-cover"
                    />
                    <img
                      src={`data:image/png;base64,${captchaChallenge.captcha_piece}`}
                      alt="piece"
                      className="absolute"
                      style={{
                        left: Math.max(0, sliderValue * captchaChallenge.puzzle_width),
                        top: captchaChallenge.piece_y || 0,
                        width: captchaChallenge.piece_width,
                        height: captchaChallenge.piece_height,
                      }}
                    />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(sliderValue * 100)}
                    onChange={(event) => setSliderValue(Number(event.target.value) / 100)}
                    className="w-full"
                    disabled={bindingSubmitting}
                  />
                </>
              )}
            </div>
          </div>

          {typeof bindingError === 'string' ? (
            bindingError ? (
              <div className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-red-700 dark:bg-red-900/20 dark:text-red-400">
                <XCircle className="h-4 w-4" />
                <span className="text-sm">{bindingError}</span>
              </div>
            ) : null
          ) : bindingError ? (
            <RequestErrorNotice
              error={bindingError}
              onRetry={() => void handleRefreshCaptcha()}
              onRefresh={() => void handleRefreshCaptcha()}
            />
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setBindingModalOpen(false)} disabled={bindingSubmitting}>
              取消
            </Button>
            <Button
              onClick={handleCompleteBinding}
              disabled={bindingSubmitting || captchaLoading || !bindingForm.username.trim() || !bindingForm.password}
            >
              {bindingSubmitting ? '绑定中...' : '提交绑定'}
            </Button>
          </div>
        </div>
      </Modal>

    </div>
  );
};
