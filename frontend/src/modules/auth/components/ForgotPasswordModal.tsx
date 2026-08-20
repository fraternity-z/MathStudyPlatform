import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound, User, Mail, MessageSquare, CheckCircle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import {
  FormField,
  FormHeader,
  FormRootError,
  FormSubmitButton,
} from '@/libs/form';
import { forgotPasswordSchema, type ForgotPasswordFormData } from '@/libs/validation';
import { passwordResetService } from '@/modules/password-reset/services/passwordResetService';
import {
  formatAppErrorDescription,
  isRequestCancelled,
  toAppError,
} from '@/libs/http/apiClient';

interface ForgotPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ForgotPasswordModal: React.FC<ForgotPasswordModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [submitted, setSubmitted] = useState(false);
  const [resultMessage, setResultMessage] = useState('');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
    reset,
  } = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { username: '', email: '', reason: '' },
  });

  const onSubmit = async (data: ForgotPasswordFormData) => {
    try {
      const res = await passwordResetService.submit({
        username: data.username,
        email: data.email,
        reason: data.reason || '',
      });
      if (res.success) {
        setResultMessage(res.message);
        setSubmitted(true);
      } else {
        setError('root', { type: 'manual', message: res.message });
      }
    } catch (err) {
      if (!isRequestCancelled(err)) {
        setError('root', {
          type: 'manual',
          message: formatAppErrorDescription(toAppError(err, '提交失败，请稍后重试')),
        });
      }
    }
  };

  const handleClose = () => {
    setSubmitted(false);
    setResultMessage('');
    reset();
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      showHeader={false}
      ariaLabel={submitted ? '密码重置申请已提交' : '忘记密码'}
    >
      {submitted ? (
        <div className="text-center space-y-4 py-4">
          <div className="mx-auto w-16 h-16 bg-emerald-100 dark:bg-emerald-900/30 rounded-full flex items-center justify-center">
            <CheckCircle className="w-8 h-8 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h3 className="text-lg font-semibold text-surface-900 dark:text-surface-100">
            申请已提交
          </h3>
          <p className="text-sm text-surface-600 dark:text-surface-400">
            {resultMessage}
          </p>
          <button
            type="button"
            onClick={handleClose}
            className="mt-4 px-6 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            知道了
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <FormHeader
            icon={KeyRound}
            title="忘记密码"
            subtitle="填写账号信息，提交后等待管理员审批重置"
          />

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              label="用户名"
              icon={User}
              placeholder="请输入注册时的用户名"
              autoComplete="username"
              disabled={isSubmitting}
              error={errors.username?.message}
              {...register('username')}
            />

            <FormField
              label="注册邮箱"
              icon={Mail}
              type="email"
              placeholder="请输入注册时的邮箱"
              autoComplete="email"
              disabled={isSubmitting}
              error={errors.email?.message}
              {...register('email')}
            />

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300">
                <span className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4" />
                  申请理由（可选）
                </span>
              </label>
              <textarea
                placeholder="简要说明申请原因，有助于管理员快速审批"
                disabled={isSubmitting}
                className="w-full px-4 py-2.5 rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 text-surface-900 dark:text-surface-100 text-sm placeholder:text-surface-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none"
                rows={3}
                {...register('reason')}
              />
              {errors.reason?.message && (
                <p className="text-xs text-red-500">{errors.reason.message}</p>
              )}
            </div>

            <FormRootError message={errors.root?.message} />

            <FormSubmitButton isLoading={isSubmitting}>
              提交申请
            </FormSubmitButton>
          </form>

          <p className="text-xs text-center text-surface-500 dark:text-surface-400">
            管理员审批通过后，临时密码将发送至您的注册邮箱，请查收后尽快修改
          </p>
        </div>
      )}
    </Modal>
  );
};
