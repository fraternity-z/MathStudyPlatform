import React, { useCallback, useState, useEffect } from 'react';
import { AdminLayout } from '@/modules/admin/components/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/Tabs';
import {
  Database,
  Save,
  Key,
  AlertCircle,
  CheckCircle,
  UserPlus,
  GraduationCap,
  BookOpen,
  Loader2,
  Download,
  Upload,
  HardDrive,
  Activity,
  RefreshCw,
} from 'lucide-react';
import { authService } from '@/modules/auth/services/authService';
import { useAuth } from '@/modules/auth/hooks/useAuth';
import { passwordSchema } from '@/libs/validation';
import {
  systemSettingService,
  type RegistrationSettings,
  type GeneralSettings,
  type ExportableTable,
  type DataImportResponse,
  type DatabaseMonitorResponse,
} from '@/modules/admin/services/systemSettingService';
import { base64ToBlob, downloadBlob } from '@/libs/utils/download';
import { useSerialPolling } from '@/hooks/useSerialPolling';
import { EmailSettingsPanel } from '@/modules/email/components/EmailSettingsPanel';
import { StorageSettingsCard } from '@/modules/admin/components/StorageSettingsCard';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';
import { isAdminRequestCancelled, toAdminAppError } from '@/modules/admin/utils/errorFeedback';

type SettingsFeedbackError = string | AppError;

const SettingsErrorNotice: React.FC<{
  error: SettingsFeedbackError;
  onRetry?: () => void;
}> = ({ error, onRetry }) => typeof error === 'string' ? (
  <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
    <AlertCircle className="h-4 w-4 shrink-0" />
    <span className="text-sm">{error}</span>
  </div>
) : (
  <RequestErrorNotice error={error} onRetry={onRetry} onRefresh={onRetry} />
);

export const SystemSettingsPage: React.FC = () => {
  return (
    <AdminLayout>
      <div className="container mx-auto max-w-7xl">
        {/* 页面标题 */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-2">系统设置</h1>
          <p className="text-surface-500 dark:text-surface-400">配置系统参数和功能选项</p>
        </div>

        <Tabs defaultValue="general" className="space-y-6">
          <TabsList className="max-w-full justify-start overflow-x-auto">
            <TabsTrigger value="general">常规设置</TabsTrigger>
            <TabsTrigger value="email">邮件设置</TabsTrigger>
            <TabsTrigger value="storage">存储设置</TabsTrigger>
            <TabsTrigger value="database">数据库</TabsTrigger>
            <TabsTrigger value="security">安全设置</TabsTrigger>
          </TabsList>

          {/* 常规设置 Tab */}
          <TabsContent value="general" className="space-y-6">
            {/* 注册控制 */}
            <RegistrationControlCard />

            {/* 基本信息 */}
            <GeneralInfoCard />
          </TabsContent>

          <TabsContent value="email">
            <EmailSettingsPanel />
          </TabsContent>

          <TabsContent value="storage">
            <StorageSettingsCard />
          </TabsContent>

          {/* 数据库 Tab */}
          <TabsContent value="database" className="space-y-6">
            <SanitizedDataExchangeCard />
            <DatabaseMonitorCard />
          </TabsContent>

          {/* 安全设置 Tab */}
          <TabsContent value="security" className="space-y-6">
            {/* 修改密码卡片 */}
            <ChangePasswordCard />
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
};

// 注册控制卡片组件
const RegistrationControlCard: React.FC = () => {
  const [settings, setSettings] = useState<RegistrationSettings>({
    allow_student: true,
    allow_teacher: true,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<SettingsFeedbackError | null>(null);
  const [success, setSuccess] = useState('');

  // 加载配置
  const loadSettings = useCallback(async (signal?: AbortSignal) => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await systemSettingService.getRegistrationSettings(signal);
        if (signal?.aborted) return;
        setSettings(data);
      } catch (loadError) {
        if (signal?.aborted || isAdminRequestCancelled(loadError)) return;
        setError(toAdminAppError(loadError, '加载注册配置失败'));
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadSettings(controller.signal);
    return () => controller.abort();
  }, [loadSettings]);

  // 切换开关
  const handleToggle = async (type: 'student' | 'teacher') => {
    setError(null);
    setSuccess('');
    setIsSaving(true);

    const newSettings = {
      ...settings,
      [type === 'student' ? 'allow_student' : 'allow_teacher']:
        type === 'student' ? !settings.allow_student : !settings.allow_teacher,
    };

    try {
      const updated = await systemSettingService.updateRegistrationSettings(newSettings);
      setSettings(updated);
      setSuccess('注册配置已更新');
      setTimeout(() => setSuccess(''), 3000);
    } catch (saveError) {
      if (!isAdminRequestCancelled(saveError)) {
        setError(toAdminAppError(saveError, '更新注册配置失败'));
      }
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2">
            <UserPlus className="w-5 h-5" />
            注册控制
          </CardTitle>
          <CardDescription>控制学生和教师的注册功能</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-surface-400" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl flex items-center gap-2">
          <UserPlus className="w-5 h-5" />
          注册控制
        </CardTitle>
        <CardDescription>控制学生和教师的注册功能</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 错误提示 */}
        {error ? <SettingsErrorNotice error={error} onRetry={() => void loadSettings()} /> : null}

        {/* 成功提示 */}
        {success && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span className="text-sm">{success}</span>
          </div>
        )}

        {/* 学生注册开关 */}
        <div className="flex items-center justify-between p-4 rounded-lg bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary-50 dark:bg-primary-900/50">
              <GraduationCap className="w-5 h-5 text-primary-600 dark:text-primary-400" />
            </div>
            <div>
              <div className="font-medium text-surface-900 dark:text-surface-100">学生注册</div>
              <div className="text-sm text-surface-500 dark:text-surface-400">
                {settings.allow_student ? '允许新学生注册账号' : '已暂停学生注册'}
              </div>
            </div>
          </div>
          <Button
            variant={settings.allow_student ? 'primary' : 'outline'}
            size="sm"
            onClick={() => handleToggle('student')}
            disabled={isSaving}
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : settings.allow_student ? (
              '已开启'
            ) : (
              '已关闭'
            )}
          </Button>
        </div>

        {/* 教师注册开关 */}
        <div className="flex items-center justify-between p-4 rounded-lg bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/50">
              <BookOpen className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <div className="font-medium text-surface-900 dark:text-surface-100">教师注册</div>
              <div className="text-sm text-surface-500 dark:text-surface-400">
                {settings.allow_teacher ? '允许新教师注册账号' : '已暂停教师注册'}
              </div>
            </div>
          </div>
          <Button
            variant={settings.allow_teacher ? 'primary' : 'outline'}
            size="sm"
            onClick={() => handleToggle('teacher')}
            disabled={isSaving}
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : settings.allow_teacher ? (
              '已开启'
            ) : (
              '已关闭'
            )}
          </Button>
        </div>

        {/* 提示信息 */}
        <div className="text-xs text-surface-400 dark:text-surface-500 mt-2">
          关闭注册后，对应角色的用户将无法在注册页面创建新账号。已有账号不受影响。
        </div>
      </CardContent>
    </Card>
  );
};

// 基本信息卡片组件
const GeneralInfoCard: React.FC = () => {
  const [settings, setSettings] = useState<GeneralSettings>({
    system_name: '',
    system_description: '',
    system_version: '',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<SettingsFeedbackError | null>(null);
  const [success, setSuccess] = useState('');

  // 加载配置
  const loadSettings = useCallback(async (signal?: AbortSignal) => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await systemSettingService.getGeneralSettings(signal);
        if (signal?.aborted) return;
        setSettings(data);
      } catch (loadError) {
        if (signal?.aborted || isAdminRequestCancelled(loadError)) return;
        setError(toAdminAppError(loadError, '加载基本信息失败'));
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadSettings(controller.signal);
    return () => controller.abort();
  }, [loadSettings]);

  // 保存
  const handleSave = async () => {
    setError(null);
    setSuccess('');

    if (!settings.system_name.trim()) {
      setError('系统名称不能为空');
      return;
    }

    setIsSaving(true);
    try {
      const updated = await systemSettingService.updateGeneralSettings({
        system_name: settings.system_name,
        system_description: settings.system_description,
      });
      setSettings(updated);
      setSuccess('基本信息已更新');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      if (!isAdminRequestCancelled(err)) setError(toAdminAppError(err, '更新基本信息失败'));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">基本信息</CardTitle>
          <CardDescription>配置系统的基本信息</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-surface-400" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">基本信息</CardTitle>
        <CardDescription>配置系统的基本信息</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 错误提示 */}
        {error ? <SettingsErrorNotice error={error} onRetry={() => void loadSettings()} /> : null}

        {/* 成功提示 */}
        {success && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span className="text-sm">{success}</span>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-surface-900 dark:text-surface-100 mb-2">
            系统名称
          </label>
          <Input
            value={settings.system_name}
            onChange={(e) => setSettings({ ...settings, system_name: e.target.value })}
            placeholder="数学学习平台"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-surface-900 dark:text-surface-100 mb-2">
            系统描述
          </label>
          <Input
            value={settings.system_description}
            onChange={(e) => setSettings({ ...settings, system_description: e.target.value })}
            placeholder="基于多智能体协作的高等数学教育生态系统"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-surface-900 dark:text-surface-100 mb-2">
            系统版本
          </label>
          <Input value={settings.system_version} disabled />
        </div>

        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              保存中...
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-2" />
              保存
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
};

// 修改密码卡片组件
const ChangePasswordCard: React.FC = () => {
  const { handleLogout, isLoggingOut } = useAuth('/admin');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<SettingsFeedbackError | null>(null);
  const [success, setSuccess] = useState('');

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess('');

    const passwordResult = passwordSchema.safeParse(newPassword);
    if (!passwordResult.success) {
      setError(passwordResult.error.issues[0]?.message ?? '新密码不符合安全策略');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }

    setIsLoading(true);

    try {
      const response = await authService.changePassword({
        old_password: oldPassword,
        new_password: newPassword,
      });

      setSuccess(response.message);
      // 清空表单
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await handleLogout();
    } catch (err) {
      if (!isAdminRequestCancelled(err)) {
        setError(toAdminAppError(err, '密码修改失败，请稍后重试'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl flex items-center gap-2">
          <Key className="w-5 h-5" />
          修改密码
        </CardTitle>
        <CardDescription>更新您的管理员账户密码</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleChangePassword} className="space-y-4">
          {/* 错误提示 */}
          {error ? <SettingsErrorNotice error={error} /> : null}

          {/* 成功提示 */}
          {success && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="w-4 h-4 shrink-0" />
              <span className="text-sm">{success}</span>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-surface-900 dark:text-surface-100 mb-2">
              当前密码
            </label>
            <Input
              type="password"
              placeholder="请输入当前密码"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-surface-900 dark:text-surface-100 mb-2">
              新密码
            </label>
            <Input
              type="password"
              placeholder="请输入强密码"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-surface-900 dark:text-surface-100 mb-2">
              确认新密码
            </label>
            <Input
              type="password"
              placeholder="请再次输入新密码"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>

          <Button type="submit" disabled={isLoading || isLoggingOut}>
            <Key className="w-4 h-4 mr-2" />
            {isLoading ? '修改中...' : '修改密码'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

// 脱敏数据交换卡片组件
const SanitizedDataExchangeCard: React.FC = () => {
  const [exportableTables, setExportableTables] = useState<ExportableTable[]>([]);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isLoadingTables, setIsLoadingTables] = useState(true);
  const [error, setError] = useState<SettingsFeedbackError | null>(null);
  const [success, setSuccess] = useState('');
  const [importResult, setImportResult] = useState<DataImportResponse | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const loadTables = useCallback(async (signal?: AbortSignal) => {
      setIsLoadingTables(true);
      setError(null);
      try {
        const data = await systemSettingService.getExportableTables(signal);
        if (signal?.aborted) return;
        setExportableTables(data.tables);
        setSelectedTables(new Set(data.tables.map((t) => t.name)));
      } catch (loadError) {
        if (signal?.aborted || isAdminRequestCancelled(loadError)) return;
        setError(toAdminAppError(loadError, '加载表列表失败'));
      } finally {
        if (!signal?.aborted) setIsLoadingTables(false);
      }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadTables(controller.signal);
    return () => controller.abort();
  }, [loadTables]);

  const toggleTable = (name: string) => {
    setSelectedTables((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedTables.size === exportableTables.length) {
      setSelectedTables(new Set());
    } else {
      setSelectedTables(new Set(exportableTables.map((t) => t.name)));
    }
  };

  const handleExport = async () => {
    if (selectedTables.size === 0) {
      setError('请至少选择一张表');
      return;
    }
    setError(null);
    setSuccess('');
    setImportResult(null);
    setIsExporting(true);
    try {
      const result = await systemSettingService.exportData([...selectedTables]);
      const blob = base64ToBlob(result.content, 'application/json');
      downloadBlob(blob, result.filename, 'sanitized_data_export.json');
      setSuccess(`脱敏数据导出成功，共 ${result.total_records} 条记录`);
      setTimeout(() => setSuccess(''), 5000);
    } catch (err) {
      if (!isAdminRequestCancelled(err)) setError(toAdminAppError(err, '脱敏数据导出失败'));
    } finally {
      setIsExporting(false);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setSuccess('');
    setImportResult(null);
    setIsImporting(true);
    try {
      const result = await systemSettingService.importData(file);
      setImportResult(result);
      if (result.success) {
        setSuccess(`交换完成：${result.total_imported} 条已写入，${result.total_skipped} 条已跳过`);
      } else if (result.total_failed > 0) {
        setError(`交换完成但有 ${result.total_failed} 条数据未写入，请查看明细`);
      } else {
        setError('交换完成但存在未处理的数据，请查看明细');
      }
    } catch (err) {
      if (!isAdminRequestCancelled(err)) setError(toAdminAppError(err, '脱敏数据导入失败'));
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  if (isLoadingTables) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2">
            <HardDrive className="w-5 h-5" />
            脱敏数据交换
          </CardTitle>
          <CardDescription>在已有基础数据的环境间交换所选业务数据</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-surface-400" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl flex items-center gap-2">
          <HardDrive className="w-5 h-5" />
          脱敏数据交换
        </CardTitle>
        <CardDescription>在已有基础数据的环境间交换所选业务数据</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <p className="text-sm leading-5">
            导出内容已脱敏，不包含完整用户账号、管理员账号、敏感字段及全部业务数据，不能用于空库完整恢复。
            目标库需预先具备关联账号和基础数据；完整备份与恢复请按部署文档使用 pg_dump / pg_restore。
          </p>
        </div>
        {error ? <SettingsErrorNotice error={error} onRetry={() => void loadTables()} /> : null}
        {success && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span className="text-sm">{success}</span>
          </div>
        )}

        {/* 表选择区域 */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-medium text-surface-900 dark:text-surface-100">
              选择要导出的数据表
            </label>
            <Button variant="ghost" size="sm" onClick={toggleAll}>
              {selectedTables.size === exportableTables.length ? '取消全选' : '全选'}
            </Button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {exportableTables.map((table) => (
              <label
                key={table.name}
                className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                  selectedTables.has(table.name)
                    ? 'bg-primary-50 dark:bg-primary-900/20 border-primary-300 dark:border-primary-700'
                    : 'bg-surface-50 dark:bg-surface-800 border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedTables.has(table.name)}
                  onChange={() => toggleTable(table.name)}
                  className="rounded border-surface-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-sm text-surface-700 dark:text-surface-300">{table.display_name}</span>
              </label>
            ))}
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-3">
          <Button onClick={handleExport} disabled={isExporting || selectedTables.size === 0}>
            {isExporting ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Download className="w-4 h-4 mr-2" />
            )}
            {isExporting ? '导出中...' : '导出脱敏数据'}
          </Button>
          <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={isImporting}>
            {isImporting ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Upload className="w-4 h-4 mr-2" />
            )}
            {isImporting ? '导入中...' : '导入交换文件'}
          </Button>
          <input ref={fileInputRef} type="file" accept=".json" onChange={handleImport} className="hidden" />
        </div>

        {/* 导入结果 */}
        {importResult && (
          <div className="p-4 rounded-lg bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
            <h4 className="text-sm font-medium text-surface-900 dark:text-surface-100 mb-3">数据交换结果</h4>
            <div className="space-y-1.5">
              {Object.entries(importResult.table_results).map(([table, result]) => (
                <div key={table} className="flex items-center justify-between text-sm">
                  <span className="text-surface-600 dark:text-surface-400">{table}</span>
                  <span className="text-surface-500 dark:text-surface-400">
                    已写入 {result.imported} / 已跳过 {result.skipped} / 未写入 {result.failed}
                  </span>
                </div>
              ))}
            </div>
            {importResult.errors.length > 0 && (
              <div className="mt-3 text-xs text-red-500 dark:text-red-400 space-y-1">
                {importResult.errors.map((err, i) => (
                  <div key={i}>{err}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// 数据库监控卡片组件
const DatabaseMonitorCard: React.FC = () => {
  const [monitorData, setMonitorData] = useState<DatabaseMonitorResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const loadMonitor = useCallback(async (showRefreshing = false, signal?: AbortSignal) => {
    if (showRefreshing) setIsRefreshing(true);
    try {
      const data = await systemSettingService.getDatabaseMonitor(signal);
      if (signal?.aborted) return;
      setMonitorData(data);
      setError(null);
    } catch (loadError) {
      if (signal?.aborted || isAdminRequestCancelled(loadError)) return;
      setError(toAdminAppError(loadError, '加载监控数据失败'));
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  const pollMonitor = useCallback((signal: AbortSignal) => loadMonitor(false, signal), [loadMonitor]);
  useSerialPolling(pollMonitor, 30_000);

  const healthColor = {
    healthy: 'text-emerald-600 dark:text-emerald-400',
    degraded: 'text-amber-600 dark:text-amber-400',
    unhealthy: 'text-red-600 dark:text-red-400',
  };

  const healthBg = {
    healthy: 'bg-emerald-100 dark:bg-emerald-900/30',
    degraded: 'bg-amber-100 dark:bg-amber-900/30',
    unhealthy: 'bg-red-100 dark:bg-red-900/30',
  };

  const healthLabel = {
    healthy: '健康',
    degraded: '降级',
    unhealthy: '异常',
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2">
            <Activity className="w-5 h-5" />
            数据库监控
          </CardTitle>
          <CardDescription>实时查看数据库运行状态</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-surface-400" />
        </CardContent>
      </Card>
    );
  }

  if (error && !monitorData) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2">
            <Activity className="w-5 h-5" />
            数据库监控
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RequestErrorNotice
            error={error}
            onRetry={() => void loadMonitor(true)}
            onRefresh={() => void loadMonitor(true)}
          />
        </CardContent>
      </Card>
    );
  }

  if (!monitorData) return null;

  const { overview, connection_pool: pool, tables, health_status: health } = monitorData;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-xl flex items-center gap-2">
              <Activity className="w-5 h-5" />
              数据库监控
              <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${healthBg[health]} ${healthColor[health]}`}>
                {healthLabel[health]}
              </span>
            </CardTitle>
            <CardDescription>实时查看数据库运行状态（每 30 秒自动刷新）</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => loadMonitor(true)} disabled={isRefreshing}>
            <RefreshCw className={`w-4 h-4 mr-1 ${isRefreshing ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error ? (
          <RequestErrorNotice
            error={error}
            onRetry={() => void loadMonitor(true)}
            onRefresh={() => void loadMonitor(true)}
          />
        ) : null}
        {/* 数据库概览 */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800">
            <div className="text-xs text-surface-500 dark:text-surface-400 mb-1">数据库</div>
            <div className="text-sm font-medium text-surface-900 dark:text-surface-100">{overview.database_name}</div>
          </div>
          <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800">
            <div className="text-xs text-surface-500 dark:text-surface-400 mb-1">数据库大小</div>
            <div className="text-sm font-medium text-surface-900 dark:text-surface-100">{overview.database_size}</div>
          </div>
          <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800">
            <div className="text-xs text-surface-500 dark:text-surface-400 mb-1">PostgreSQL 版本</div>
            <div className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">{overview.postgres_version}</div>
          </div>
          <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800">
            <div className="text-xs text-surface-500 dark:text-surface-400 mb-1">运行时间</div>
            <div className="text-sm font-medium text-surface-900 dark:text-surface-100">{overview.uptime}</div>
          </div>
          <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800">
            <div className="text-xs text-surface-500 dark:text-surface-400 mb-1">活跃连接</div>
            <div className="text-sm font-medium text-surface-900 dark:text-surface-100">
              {overview.active_connections} / {overview.max_connections}
            </div>
          </div>
        </div>

        {/* 连接池状态 */}
        <div>
          <h4 className="text-sm font-medium text-surface-900 dark:text-surface-100 mb-3 flex items-center gap-2">
            <Database className="w-4 h-4" />
            连接池状态
          </h4>
          <div className="p-4 rounded-lg bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-surface-600 dark:text-surface-400">使用率</span>
              <span className="text-sm font-medium text-surface-900 dark:text-surface-100">{pool.usage_percent}%</span>
            </div>
            <div className="w-full h-2 bg-surface-200 dark:bg-surface-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  pool.usage_percent > 90 ? 'bg-red-500' : pool.usage_percent > 70 ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(pool.usage_percent, 100)}%` }}
              />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-xs">
              <div>
                <span className="text-surface-500 dark:text-surface-400">池大小</span>
                <span className="ml-1 font-medium text-surface-700 dark:text-surface-300">{pool.pool_size}</span>
              </div>
              <div>
                <span className="text-surface-500 dark:text-surface-400">使用中</span>
                <span className="ml-1 font-medium text-surface-700 dark:text-surface-300">{pool.checked_out}</span>
              </div>
              <div>
                <span className="text-surface-500 dark:text-surface-400">空闲</span>
                <span className="ml-1 font-medium text-surface-700 dark:text-surface-300">{pool.checked_in}</span>
              </div>
              <div>
                <span className="text-surface-500 dark:text-surface-400">溢出</span>
                <span className="ml-1 font-medium text-surface-700 dark:text-surface-300">{pool.overflow} / {pool.max_overflow}</span>
              </div>
            </div>
          </div>
        </div>

        {/* 表统计 */}
        <div>
          <h4 className="text-sm font-medium text-surface-900 dark:text-surface-100 mb-3">数据表统计</h4>
          <div className="overflow-x-auto rounded-lg border border-surface-200 dark:border-surface-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-50 dark:bg-surface-800 border-b border-surface-200 dark:border-surface-700">
                  <th className="text-left px-4 py-2.5 font-medium text-surface-600 dark:text-surface-400">表名</th>
                  <th className="text-right px-4 py-2.5 font-medium text-surface-600 dark:text-surface-400">行数</th>
                  <th className="text-right px-4 py-2.5 font-medium text-surface-600 dark:text-surface-400">数据大小</th>
                  <th className="text-right px-4 py-2.5 font-medium text-surface-600 dark:text-surface-400">索引大小</th>
                  <th className="text-right px-4 py-2.5 font-medium text-surface-600 dark:text-surface-400">总大小</th>
                </tr>
              </thead>
              <tbody>
                {tables.map((t) => (
                  <tr key={t.table_name} className="border-b border-surface-100 dark:border-surface-800 last:border-0">
                    <td className="px-4 py-2 text-surface-900 dark:text-surface-100">
                      {t.display_name}
                      <span className="ml-1.5 text-xs text-surface-400">({t.table_name})</span>
                    </td>
                    <td className="px-4 py-2 text-right text-surface-600 dark:text-surface-400">{t.row_count.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-surface-600 dark:text-surface-400">{t.table_size}</td>
                    <td className="px-4 py-2 text-right text-surface-600 dark:text-surface-400">{t.index_size}</td>
                    <td className="px-4 py-2 text-right font-medium text-surface-700 dark:text-surface-300">{t.total_size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
