import React, { useState, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Loader2, UserPlus, Save } from 'lucide-react';
import { adminUserService } from '@/modules/admin/services/adminUserService';
import type { UserRole, UserItem } from '@/modules/admin/types/adminUsers';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';
import { isAdminRequestCancelled, toAdminAppError } from '@/modules/admin/utils/errorFeedback';

interface UserFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  mode: 'add' | 'edit';
  user?: UserItem | null;
}

const passwordPolicyMessage = '密码至少 8 位，需包含大小写字母、数字和特殊字符';
const passwordPolicyRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]).{8,72}$/;

function isStrongPassword(password: string): boolean {
  return passwordPolicyRegex.test(password);
}

export const UserFormModal: React.FC<UserFormModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  mode,
  user,
}) => {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    role: 'student' as UserRole,
    display_name: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | AppError | null>(null);

  const isEditMode = mode === 'edit';

  // 编辑模式下，初始化表单数据
  useEffect(() => {
    if (isOpen && isEditMode && user) {
      setFormData({
        username: user.username,
        email: user.email,
        password: '',
        confirmPassword: '',
        role: user.role,
        display_name: user.display_name || '',
      });
    } else if (isOpen && !isEditMode) {
      // 添加模式，重置表单
      setFormData({
        username: '',
        email: '',
        password: '',
        confirmPassword: '',
        role: 'student',
        display_name: '',
      });
    }
    setError(null);
  }, [isOpen, isEditMode, user]);

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isEditMode) {
      // 编辑模式验证
      if (formData.password && !isStrongPassword(formData.password)) {
        setError(passwordPolicyMessage);
        return;
      }
    } else {
      // 添加模式验证
      if (!formData.username.trim()) {
        setError('请输入用户名');
        return;
      }
      if (formData.username.length < 3) {
        setError('用户名至少 3 个字符');
        return;
      }
      if (!formData.email.trim()) {
        setError('请输入邮箱');
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
        setError('请输入有效的邮箱地址');
        return;
      }
      if (!formData.password) {
        setError('请输入密码');
        return;
      }
      if (!isStrongPassword(formData.password)) {
        setError(passwordPolicyMessage);
        return;
      }
      if (formData.password !== formData.confirmPassword) {
        setError('两次输入的密码不一致');
        return;
      }
    }

    setLoading(true);
    try {
      if (isEditMode && user) {
        // 编辑用户
        const updateData: { display_name?: string; password?: string } = {};

        // 只有当值有变化时才更新
        if (formData.display_name !== (user.display_name || '')) {
          updateData.display_name = formData.display_name.trim() || undefined;
        }
        if (formData.password) {
          updateData.password = formData.password;
        }

        const response = await adminUserService.updateUser(user.id, updateData);

        if (response.success) {
          onSuccess();
          onClose();
        } else {
          setError(response.message);
        }
      } else {
        // 创建用户
        const response = await adminUserService.createUser({
          username: formData.username.trim(),
          email: formData.email.trim(),
          password: formData.password,
          role: formData.role,
          display_name: formData.display_name.trim() || undefined,
        });

        if (response.success) {
          setFormData({
            username: '',
            email: '',
            password: '',
            confirmPassword: '',
            role: 'student',
            display_name: '',
          });
          onSuccess();
          onClose();
        } else {
          setError(response.message);
        }
      }
    } catch (err) {
      if (!isAdminRequestCancelled(err)) {
        setError(toAdminAppError(err, isEditMode ? '更新用户失败，请重试' : '创建用户失败，请重试'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setError(null);
      onClose();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={isEditMode ? '编辑用户' : '添加账户'}
      className="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {typeof error === 'string' && (
          <div className="p-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 rounded-lg">
            {error}
          </div>
        )}
        {error && typeof error !== 'string' ? <RequestErrorNotice error={error} /> : null}

        <div>
          <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
            用户名 {!isEditMode && <span className="text-red-500">*</span>}
          </label>
          <Input
            value={formData.username}
            onChange={(e) => handleChange('username', e.target.value)}
            placeholder="请输入用户名"
            disabled={loading || isEditMode}
            className={isEditMode ? 'bg-surface-100 dark:bg-surface-800 cursor-not-allowed' : ''}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
            邮箱 {!isEditMode && <span className="text-red-500">*</span>}
          </label>
          <Input
            type="email"
            value={formData.email}
            onChange={(e) => handleChange('email', e.target.value)}
            placeholder="请输入邮箱"
            disabled={loading || isEditMode}
            className={isEditMode ? 'bg-surface-100 dark:bg-surface-800 cursor-not-allowed' : ''}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
            {isEditMode ? '新密码' : '密码'} {!isEditMode && <span className="text-red-500">*</span>}
          </label>
          <Input
            type="password"
            value={formData.password}
            onChange={(e) => handleChange('password', e.target.value)}
            placeholder={isEditMode ? '留空则不修改密码' : '请输入强密码'}
            disabled={loading}
          />
          {isEditMode && (
            <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
              如需重置密码，请输入新密码；留空则保持原密码不变
            </p>
          )}
        </div>

        {!isEditMode && (
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
              确认密码 <span className="text-red-500">*</span>
            </label>
            <Input
              type="password"
              value={formData.confirmPassword}
              onChange={(e) => handleChange('confirmPassword', e.target.value)}
              placeholder="请再次输入密码"
              disabled={loading}
            />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
            角色 {!isEditMode && <span className="text-red-500">*</span>}
          </label>
          <Select
            value={formData.role}
            onChange={(value) => handleChange('role', value)}
            disabled={loading || isEditMode}
            className={isEditMode ? 'bg-surface-100 dark:bg-surface-800 cursor-not-allowed' : ''}
            options={[
              { value: 'student', label: '学生' },
              { value: 'teacher', label: '教师' },
              { value: 'admin', label: '管理员' },
            ]}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
            显示名称
          </label>
          <Input
            value={formData.display_name}
            onChange={(e) => handleChange('display_name', e.target.value)}
            placeholder="请输入显示名称（可选）"
            disabled={loading}
          />
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="outline" onClick={handleClose} disabled={loading}>
            取消
          </Button>
          <Button type="submit" disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {isEditMode ? '保存中...' : '创建中...'}
              </>
            ) : (
              <>
                {isEditMode ? (
                  <Save className="w-4 h-4 mr-2" />
                ) : (
                  <UserPlus className="w-4 h-4 mr-2" />
                )}
                {isEditMode ? '保存修改' : '创建账户'}
              </>
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
