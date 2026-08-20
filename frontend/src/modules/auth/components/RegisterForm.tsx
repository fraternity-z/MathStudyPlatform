import React, { useCallback, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CheckCircle,
  Eye,
  EyeOff,
  GraduationCap,
  Loader2,
  UserPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { RequestErrorNotice } from '@/components/feedback';
import { registerSchema, type RegisterFormData } from '@/libs/validation';
import {
  FormDivider,
  FormField,
  FormFooterLink,
  FormFooterText,
  FormRootError,
  RoleSelector,
  type RoleOption,
} from '@/libs/form';
import { systemSettingService, type RegistrationSettings } from '@/modules/admin/services/systemSettingService';
import { authService } from '@/modules/auth/services/authService';
import {
  formatAppErrorDescription,
  isRequestCancelled,
  toAppError,
  type AppError,
} from '@/libs/http/apiClient';
import { AuthFormLayout } from './AuthFormLayout';

type UserRole = 'student' | 'teacher';

interface RegisterFormProps {
  onSwitchToLogin?: () => void;
}

interface PasswordVisibilityButtonProps {
  disabled: boolean;
  fieldLabel: string;
  onToggle: () => void;
  visible: boolean;
}

const authInputClassName =
  'h-11 rounded-none border-x-0 border-t-0 border-b bg-transparent px-0 py-2 focus:border-secondary-600 focus:bg-transparent focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-transparent dark:focus:border-secondary-400 dark:focus:bg-transparent';

const passwordVisibilityButtonClassName =
  'flex h-9 w-9 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-secondary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary-500/40 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-surface-800 dark:hover:text-secondary-300';

const roleOptions: RoleOption<UserRole>[] = [
  {
    value: 'student',
    label: '学生',
    description: '我想学习数学知识',
    icon: GraduationCap,
    gradient: 'from-primary-500 to-secondary-500',
    bgGradient: 'from-primary-50 to-secondary-50 dark:from-primary-900/50 dark:to-secondary-900/50',
    borderColor: 'border-primary-500 dark:border-primary-400',
    textColor: 'text-primary-600 dark:text-primary-400',
  },
  {
    value: 'teacher',
    label: '教师',
    description: '我想管理学生和课程',
    icon: BookOpen,
    gradient: 'from-emerald-500 to-teal-500',
    bgGradient: 'from-emerald-50 to-teal-50 dark:from-emerald-900/50 dark:to-teal-900/50',
    borderColor: 'border-emerald-500 dark:border-emerald-400',
    textColor: 'text-emerald-600 dark:text-emerald-400',
  },
];

function PasswordVisibilityButton({
  disabled,
  fieldLabel,
  onToggle,
  visible,
}: PasswordVisibilityButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={`${visible ? '隐藏' : '显示'}${fieldLabel}`}
      aria-pressed={visible}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className={passwordVisibilityButtonClassName}
    >
      {visible ? (
        <EyeOff className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Eye className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}

export const RegisterForm: React.FC<RegisterFormProps> = ({ onSwitchToLogin }) => {
  const shouldReduceMotion = useReducedMotion();
  const [registrationStatus, setRegistrationStatus] = useState<RegistrationSettings | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [registrationError, setRegistrationError] = useState<AppError | null>(null);
  const [registerSuccess, setRegisterSuccess] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const loadRegistrationStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    setRegistrationError(null);
    try {
      const status = await systemSettingService.getRegistrationStatus();
      setRegistrationStatus(status);
    } catch (error) {
      if (!isRequestCancelled(error)) {
        setRegistrationError(toAppError(error, '注册设置加载失败'));
      }
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void loadRegistrationStatus();
  }, [loadRegistrationStatus]);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      username: '',
      email: '',
      password: '',
      confirmPassword: '',
      role: 'student',
    },
  });

  const role = useWatch({ control, name: 'role' });

  const isCurrentRoleAllowed = registrationStatus
    ? role === 'student'
      ? registrationStatus.allow_student
      : registrationStatus.allow_teacher
    : true;

  const isAllRegistrationClosed = registrationStatus
    ? !registrationStatus.allow_student && !registrationStatus.allow_teacher
    : false;

  const dynamicRoleOptions: RoleOption<UserRole>[] = roleOptions.map((option) => ({
    ...option,
    disabled: registrationStatus
      ? option.value === 'student'
        ? !registrationStatus.allow_student
        : !registrationStatus.allow_teacher
      : false,
    disabledReason:
      registrationStatus &&
      ((option.value === 'student' && !registrationStatus.allow_student) ||
        (option.value === 'teacher' && !registrationStatus.allow_teacher))
        ? '暂停注册'
        : undefined,
  }));

  const onSubmit = async (data: RegisterFormData) => {
    if (!isCurrentRoleAllowed) {
      setError('root', {
        type: 'manual',
        message: `${role === 'student' ? '学生' : '教师'}注册功能已暂停`,
      });
      return;
    }

    try {
      await authService.register({
        username: data.username,
        email: data.email,
        password: data.password,
        role: data.role,
      });

      setRegisteredEmail(data.email);
      setShowPassword(false);
      setShowConfirmPassword(false);
      setRegisterSuccess(true);
    } catch (err) {
      if (!isRequestCancelled(err)) {
        setError('root', {
          type: 'manual',
          message: formatAppErrorDescription(toAppError(err, '注册失败，请稍后重试')),
        });
      }
    }
  };

  const headerTitle = registerSuccess ? '注册成功' : '创建账号';
  const headerSubtitle = registerSuccess
    ? '账号已创建，可以直接登录'
    : '加入我们，开启智能数学学习之旅';
  const HeaderIcon = registerSuccess ? CheckCircle : UserPlus;

  let content: React.ReactNode;

  if (isLoadingStatus) {
    content = (
      <div className="flex items-center justify-center py-12" role="status" aria-live="polite">
        <Loader2 className="h-8 w-8 animate-spin text-secondary-600 dark:text-secondary-400" aria-hidden="true" />
        <span className="sr-only">正在加载注册设置</span>
      </div>
    );
  } else if (registrationError) {
    content = (
      <RequestErrorNotice
        error={registrationError}
        onRetry={() => void loadRegistrationStatus()}
        onRefresh={() => void loadRegistrationStatus()}
      />
    );
  } else if (registerSuccess) {
    content = (
      <>
        <div className="space-y-4 py-6 text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-900/30">
            <CheckCircle className="h-12 w-12 text-emerald-500" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-100">账号创建成功</h2>
            <p className="mt-1 break-all text-sm text-surface-500 dark:text-surface-400">
              邮箱 {registeredEmail} 已保存，可以直接登录。
            </p>
          </div>
        </div>

        <FormDivider />

        <FormFooterLink text="下一步" linkText="立即登录" onClick={onSwitchToLogin} />
      </>
    );
  } else if (isAllRegistrationClosed) {
    content = (
      <>
        <div className="space-y-4 py-8 text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-amber-50 dark:bg-amber-900/30">
            <AlertCircle className="h-12 w-12 text-amber-500" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-100">注册功能已暂停</h2>
            <p className="mx-auto mt-2 max-w-xs text-sm text-surface-500 dark:text-surface-400">
              系统当前暂停了新用户注册，请稍后再试或联系管理员。
            </p>
          </div>
        </div>

        <FormDivider />

        <FormFooterLink text="已有账号？" linkText="立即登录" onClick={onSwitchToLogin} />
      </>
    );
  } else {
    content = (
      <>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <RoleSelector
            options={dynamicRoleOptions}
            value={role}
            onChange={(value) => setValue('role', value)}
            label="选择身份"
            error={errors.role?.message}
            variant="compact"
          />

          <FormField
            label="用户名"
            placeholder="请输入用户名"
            autoComplete="username"
            disabled={isSubmitting || !isCurrentRoleAllowed}
            error={errors.username?.message}
            className={authInputClassName}
            {...register('username')}
          />

          <div className="space-y-2">
            <FormField
              label="邮箱"
              type="email"
              placeholder="请输入邮箱地址"
              autoComplete="email"
              disabled={isSubmitting || !isCurrentRoleAllowed}
              error={errors.email?.message}
              className={authInputClassName}
              {...register('email')}
            />
            <p className="-mt-1 text-xs text-surface-500 dark:text-surface-400">
              用于账号联系与密码找回
            </p>
          </div>

          <FormField
            label="密码"
            type={showPassword ? 'text' : 'password'}
            placeholder="请输入强密码"
            autoComplete="new-password"
            disabled={isSubmitting || !isCurrentRoleAllowed}
            error={errors.password?.message}
            className={authInputClassName}
            trailingAction={(
              <PasswordVisibilityButton
                disabled={isSubmitting || !isCurrentRoleAllowed}
                fieldLabel="密码"
                visible={showPassword}
                onToggle={() => setShowPassword((visible) => !visible)}
              />
            )}
            {...register('password')}
          />

          <FormField
            label="确认密码"
            type={showConfirmPassword ? 'text' : 'password'}
            placeholder="请再次输入密码"
            autoComplete="new-password"
            disabled={isSubmitting || !isCurrentRoleAllowed}
            error={errors.confirmPassword?.message}
            className={authInputClassName}
            trailingAction={(
              <PasswordVisibilityButton
                disabled={isSubmitting || !isCurrentRoleAllowed}
                fieldLabel="确认密码"
                visible={showConfirmPassword}
                onToggle={() => setShowConfirmPassword((visible) => !visible)}
              />
            )}
            {...register('confirmPassword')}
          />

          {!isCurrentRoleAllowed ? (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-600 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-400">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="text-sm">
                {role === 'student' ? '学生' : '教师'}注册功能已暂停，请选择其他身份或稍后再试
              </span>
            </div>
          ) : null}

          <FormRootError message={errors.root?.message} />

          <Button
            type="submit"
            isLoading={isSubmitting}
            disabled={!isCurrentRoleAllowed}
            className="group h-12 w-full rounded-full bg-surface-950 text-sm font-semibold text-white shadow-lg shadow-surface-950/15 hover:bg-secondary-700 dark:bg-white dark:text-surface-950 dark:hover:bg-secondary-200"
          >
            <span className="flex items-center justify-center gap-2">
              注册
              <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none" aria-hidden="true" />
            </span>
          </Button>
        </form>

        <FormDivider />

        <FormFooterLink text="已有账号？" linkText="立即登录" onClick={onSwitchToLogin} />

        <FormFooterText>
          注册即表示您同意我们的
          <Link
            to="/terms-of-service"
            className="ml-1 text-primary-600 underline underline-offset-2 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300"
          >
            服务条款
          </Link>
          和
          <Link
            to="/privacy-policy"
            className="ml-1 text-primary-600 underline underline-offset-2 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300"
          >
            隐私政策
          </Link>
        </FormFooterText>
      </>
    );
  }

  return (
    <AuthFormLayout avertGaze={showPassword || showConfirmPassword}>
      <header className="space-y-2 text-center">
        <motion.div
          className="mx-auto flex h-10 w-10 items-center justify-center text-surface-900 dark:text-surface-100"
          animate={
            !shouldReduceMotion && (isLoadingStatus || isSubmitting) ? { rotate: 180 } : { rotate: 0 }
          }
          transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.45, ease: 'easeOut' }}
        >
          <HeaderIcon className="h-7 w-7" aria-hidden="true" />
        </motion.div>
        <h1 className="text-3xl font-bold text-surface-950 dark:text-white">{headerTitle}</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400">{headerSubtitle}</p>
      </header>

      {content}
    </AuthFormLayout>
  );
};
