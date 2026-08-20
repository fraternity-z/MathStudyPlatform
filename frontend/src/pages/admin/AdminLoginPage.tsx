import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { ThemeToggle } from '../../components/ui/ThemeToggle';
import { setCredentials } from '@/modules/auth/store/authSlice';
import { Shield, Lock, User, AlertCircle } from 'lucide-react';
import { logger } from '../../libs/utils/logger';
import { authService } from '@/modules/auth/services/authService';
import { LoginCaptchaModal } from '@/modules/auth/components/LoginCaptchaModal';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';
import { isAdminRequestCancelled, toAdminAppError } from '@/modules/admin/utils/errorFeedback';

const adminLogger = logger.createContextLogger('AdminLogin');

interface PendingAdminLogin {
  username: string;
  password: string;
}

export const AdminLoginPage: React.FC = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | AppError | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingLogin, setPendingLogin] = useState<PendingAdminLogin | null>(null);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPendingLogin({ username, password });
  };

  const handleCaptchaVerified = useCallback(async (captchaToken: string) => {
    if (!pendingLogin || isLoading) return;

    const credentials = pendingLogin;
    setPendingLogin(null);
    setIsLoading(true);

    try {
      const response = await authService.adminLogin({ ...credentials, captchaToken });

      // 校验服务端返回的真实角色是否为管理员
      if (response.user.role !== 'admin') {
        setError('该账户不是管理员，请使用对应身份的登录入口');
        return;
      }

      // 设置认证状态
      dispatch(setCredentials({
        token: response.access_token,
        user: {
          id: response.user.id,
          name: response.user.username,
          email: response.user.email,
          role: 'admin',
        },
      }));

      adminLogger.info('Admin login successful', { username: credentials.username });
      // 跳转到管理员控制台
      navigate('/admin/dashboard');
    } catch (err) {
      if (!isAdminRequestCancelled(err)) {
        const appError = toAdminAppError(err, '登录失败，请稍后重试');
        setError(appError);
        adminLogger.security('Admin login failed', {
          username: credentials.username,
          kind: appError.kind,
          status: appError.status,
          requestId: appError.requestId,
        });
      }
    } finally {
      setIsLoading(false);
    }
  }, [dispatch, isLoading, navigate, pendingLogin]);

  const handleCaptchaClose = useCallback(() => {
    setPendingLogin(null);
  }, []);

  return (
    <div className="min-h-screen bg-linear-to-br from-surface-50 to-surface-100 dark:from-surface-950 dark:to-surface-900 flex items-center justify-center p-6 relative">
      {/* 主题切换按钮 */}
      <div className="absolute top-6 right-6">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-md">
        {/* Logo 和标题 */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-primary-600 dark:bg-primary-500 rounded-2xl mb-4">
            <Shield className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-2">
            管理员控制台
          </h1>
          <p className="text-surface-500 dark:text-surface-400">
            数学学习平台 - 系统管理
          </p>
        </div>

        {/* 登录卡片 */}
        <Card>
          <CardHeader>
            <CardTitle>管理员登录</CardTitle>
            <CardDescription>请使用管理员账户登录系统</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              {/* 错误提示 */}
              {typeof error === 'string' && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span className="text-sm">{error}</span>
                </div>
              )}
              {error && typeof error !== 'string' ? <RequestErrorNotice error={error} /> : null}

              {/* 用户名 */}
              <div>
                <label className="block text-sm font-medium text-surface-900 dark:text-surface-100 mb-2">
                  管理员账号
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-surface-400" />
                  <Input
                    type="text"
                    placeholder="请输入管理员账号"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="pl-10"
                    disabled={isLoading}
                    required
                  />
                </div>
              </div>

              {/* 密码 */}
              <div>
                <label className="block text-sm font-medium text-surface-900 dark:text-surface-100 mb-2">
                  密码
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-surface-400" />
                  <Input
                    type="password"
                    placeholder="请输入密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-10"
                    disabled={isLoading}
                    required
                  />
                </div>
              </div>

              {/* 安全提示 */}
              <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                <Shield className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                <div className="text-xs text-blue-600 dark:text-blue-400">
                  <div className="font-medium mb-1">安全提示</div>
                  <div>管理员账户拥有系统最高权限，请妥善保管您的登录凭证。</div>
                </div>
              </div>

              {/* 登录按钮 */}
              <Button type="submit" className="w-full" disabled={isLoading}>
                <Shield className="w-4 h-4 mr-2" />
                {isLoading ? '登录中...' : '登录管理后台'}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* 版权信息 */}
        <div className="mt-8 text-center text-sm text-surface-500 dark:text-surface-400">
          <p>© 2024 数学学习平台. All rights reserved.</p>
        </div>
      </div>

      <LoginCaptchaModal
        isOpen={Boolean(pendingLogin)}
        onClose={handleCaptchaClose}
        onVerified={handleCaptchaVerified}
      />
    </div>
  );
};
