import React, { useCallback, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { useAppDispatch } from '@/store';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { authService } from '@/modules/auth/services/authService';
import { setCredentials } from '@/modules/auth/store/authSlice';
import { loginSchema, type LoginFormData } from '@/libs/validation';
import { ArrowRight, Sparkles, GraduationCap, BookOpen, Eye, EyeOff } from 'lucide-react';
import { logger } from '@/libs/utils/logger';
import {
  formatAppErrorDescription,
  isRequestCancelled,
  toAppError,
} from '@/libs/http/apiClient';
import { Button } from '@/components/ui/Button';
import {
  FormField,
  FormDivider,
  FormFooterLink,
  FormFooterText,
  FormRootError,
  RoleSelector,
  type RoleOption,
} from '@/libs/form';
import { ForgotPasswordModal } from './ForgotPasswordModal';
import { AuthFormLayout } from './AuthFormLayout';
import { LoginCaptchaModal } from './LoginCaptchaModal';

const authLogger = logger.createContextLogger('Auth');

type UserRole = 'student' | 'teacher';

interface LoginFormProps {
  onSuccess?: () => void;
  onSwitchToRegister?: () => void;
}

/**
 * 角色选项配置
 */
const roleOptions: RoleOption<UserRole>[] = [
  {
    value: 'student',
    label: '学生',
    description: '进入学习中心',
    icon: GraduationCap,
    gradient: 'from-primary-500 to-secondary-500',
    bgGradient: 'from-primary-50 to-secondary-50 dark:from-primary-900/50 dark:to-secondary-900/50',
    borderColor: 'border-primary-500 dark:border-primary-400',
    textColor: 'text-primary-600 dark:text-primary-400',
  },
  {
    value: 'teacher',
    label: '教师',
    description: '进入教学管理',
    icon: BookOpen,
    gradient: 'from-emerald-500 to-teal-500',
    bgGradient: 'from-emerald-50 to-teal-50 dark:from-emerald-900/50 dark:to-teal-900/50',
    borderColor: 'border-emerald-500 dark:border-emerald-400',
    textColor: 'text-emerald-600 dark:text-emerald-400',
  },
];

export const LoginForm: React.FC<LoginFormProps> = ({ onSuccess, onSwitchToRegister }) => {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const shouldReduceMotion = useReducedMotion();
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [pendingLogin, setPendingLogin] = useState<LoginFormData | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors, isSubmitting },
    setError,
    clearErrors,
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: '',
      password: '',
      role: 'student',
    },
  });

  // 使用 useWatch 替代 watch()，与 React Compiler 兼容
  const role = useWatch({ control, name: 'role' });

  const onSubmit = (data: LoginFormData) => {
    clearErrors('root');
    setPendingLogin(data);
  };

  const handleCaptchaVerified = useCallback(async (captchaToken: string) => {
    if (!pendingLogin || isLoggingIn) return;

    const data = pendingLogin;
    setPendingLogin(null);
    setIsLoggingIn(true);
    try {
      const response = await authService.login({
        username: data.username,
        password: data.password,
        role: data.role,
        captchaToken,
      });

      // 入口与身份一致：管理员不能在此入口登录，老师/学生不能交叉登录
      const selectedRole = data.role;
      const actualRole = response.user.role;
      if (actualRole === 'admin') {
        setError('root', {
          type: 'manual',
          message: '管理员请使用管理员专用入口登录',
        });
        return;
      }
      if (selectedRole === 'student' && actualRole === 'teacher') {
        setError('root', {
          type: 'manual',
          message: '您已注册为教师，请选择「教师」身份或使用教师入口登录',
        });
        return;
      }
      if (selectedRole === 'teacher' && actualRole === 'student') {
        setError('root', {
          type: 'manual',
          message: '您已注册为学生，请选择「学生」身份或使用学生入口登录',
        });
        return;
      }

      dispatch(setCredentials({
        token: response.token,
        user: response.user,
      }));

      authLogger.info('Login successful', {
        userId: response.user.id,
        role: response.user.role
      });

      if (onSuccess) {
        onSuccess();
      }

      navigate('/home');
    } catch (err) {
      authLogger.security('Login failed', {
        username: data.username,
        role: data.role,
        error: err instanceof Error ? err.message : 'Unknown error'
      });
      if (!isRequestCancelled(err)) {
        const appError = toAppError(err, '登录失败，请检查用户名和密码');
        const hidesAuthenticationDetail = appError.kind === 'unauthenticated'
          || appError.kind === 'forbidden'
          || appError.kind === 'validation';
        setError('root', {
          type: 'manual',
          message: hidesAuthenticationDetail
            ? '登录失败，请检查用户名和密码'
            : formatAppErrorDescription(appError),
        });
      }
    } finally {
      setIsLoggingIn(false);
    }
  }, [dispatch, isLoggingIn, navigate, onSuccess, pendingLogin, setError]);

  const handleCaptchaClose = useCallback(() => {
    setPendingLogin(null);
  }, []);

  const formBusy = isSubmitting || isLoggingIn;

  return (
    <>
      <AuthFormLayout avertGaze={showPassword}>
          <header className="space-y-2 text-center">
            <motion.div
              className="mx-auto flex h-10 w-10 items-center justify-center text-surface-900 dark:text-surface-100"
              animate={!shouldReduceMotion && formBusy ? { rotate: 180 } : { rotate: 0 }}
              transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.45, ease: 'easeOut' }}
            >
              <Sparkles className="h-7 w-7" />
            </motion.div>
            <h1 className="text-3xl font-bold text-surface-950 dark:text-white">欢迎回来</h1>
            <p className="text-sm text-surface-500 dark:text-surface-400">
              登录后开启智能数学学习之旅
            </p>
          </header>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <RoleSelector
              options={roleOptions}
              value={role}
              onChange={(value) => setValue('role', value)}
              disabled={formBusy}
              label="选择身份"
              error={errors.role?.message}
              variant="compact"
            />

            <FormField
              label="用户名"
              placeholder="请输入用户名"
              autoComplete="username"
              disabled={formBusy}
              error={errors.username?.message}
              className="h-11 rounded-none border-x-0 border-t-0 border-b bg-transparent px-0 py-2 focus:border-secondary-600 focus:bg-transparent focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-transparent dark:focus:border-secondary-400 dark:focus:bg-transparent"
              {...register('username')}
            />

            <FormField
              label="密码"
              type={showPassword ? 'text' : 'password'}
              placeholder="请输入密码"
              autoComplete="current-password"
              disabled={formBusy}
              error={errors.password?.message}
              className="h-11 rounded-none border-x-0 border-t-0 border-b bg-transparent px-0 py-2 focus:border-secondary-600 focus:bg-transparent focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-transparent dark:focus:border-secondary-400 dark:focus:bg-transparent"
              trailingAction={(
                <button
                  type="button"
                  disabled={formBusy}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  aria-pressed={showPassword}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-secondary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary-500/40 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-surface-800 dark:hover:text-secondary-300"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              )}
              {...register('password')}
            />

            <div className="-mt-1 flex justify-end">
              <button
                type="button"
                onClick={() => setShowForgotPassword(true)}
                disabled={formBusy}
                className="text-sm text-secondary-700 transition-colors hover:text-secondary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary-500/40 dark:text-secondary-300 dark:hover:text-secondary-200"
              >
                忘记密码？
              </button>
            </div>

            <FormRootError message={errors.root?.message} />

            <Button
              type="submit"
              isLoading={formBusy}
              className="group h-12 w-full rounded-full bg-surface-950 text-sm font-semibold text-white shadow-lg shadow-surface-950/15 hover:bg-secondary-700 dark:bg-white dark:text-surface-950 dark:hover:bg-secondary-200"
            >
              <span className="flex items-center justify-center gap-2">
                {role === 'student' ? '学生登录' : '教师登录'}
                <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none" />
              </span>
            </Button>
          </form>

          <FormDivider />

          <FormFooterLink
            text="还没有账号？"
            linkText="立即注册"
            onClick={onSwitchToRegister}
          />

          <FormFooterText>
            登录即表示您同意我们的
            <Link
              to="/terms-of-service"
              className="ml-1 text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300 underline underline-offset-2"
            >
              服务条款
            </Link>
            和
            <Link
              to="/privacy-policy"
              className="ml-1 text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300 underline underline-offset-2"
            >
              隐私政策
            </Link>
          </FormFooterText>
      </AuthFormLayout>

      <ForgotPasswordModal
        isOpen={showForgotPassword}
        onClose={() => setShowForgotPassword(false)}
      />

      <LoginCaptchaModal
        isOpen={Boolean(pendingLogin)}
        onClose={handleCaptchaClose}
        onVerified={handleCaptchaVerified}
      />
    </>
  );
};
