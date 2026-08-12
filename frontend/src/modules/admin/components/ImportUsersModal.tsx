import React, { useState, useRef } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import {
  Upload,
  Download,
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
  FileText,
} from 'lucide-react';
import { adminUserService } from '@/modules/admin/services/adminUserService';
import { downloadBlob } from '@/libs/utils/download';
import type { UserImportResponse, UserImportResult } from '@/modules/admin/types/adminUsers';

interface ImportUsersModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const ImportUsersModal: React.FC<ImportUsersModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<UserImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (!selectedFile.name.endsWith('.csv')) {
        setError('请选择 CSV 格式的文件');
        setFile(null);
        return;
      }
      setFile(selectedFile);
      setError(null);
      setResult(null);
    }
  };

  const handleDownloadTemplate = () => {
    const csvContent = '用户名,邮箱,密码,角色,显示名称';
    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'users_import_template.csv');
  };

  const handleImport = async () => {
    if (!file) {
      setError('请先选择文件');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await adminUserService.importUsers(file);
      setResult(response);
      if (response.created > 0) {
        onSuccess();
      }
    } catch (err) {
      setError('导入失败，请检查文件格式后重试');
      console.error('导入失败:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setFile(null);
      setResult(null);
      setError(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      onClose();
    }
  };

  const renderResultIcon = (item: UserImportResult) => {
    if (item.success) {
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    }
    return <XCircle className="w-4 h-4 text-red-500" />;
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="导入用户" className="max-w-2xl">
      <div className="space-y-4">
        {/* 说明 */}
        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-blue-500 mt-0.5" />
            <div className="text-sm text-blue-700 dark:text-blue-300">
              <p className="font-medium mb-1">导入说明</p>
              <ul className="list-disc list-inside space-y-1 text-blue-600 dark:text-blue-400">
                <li>支持 CSV 格式文件</li>
                <li>必填字段：用户名、邮箱、密码</li>
                <li>角色可选值：student（学生）、teacher（教师）、admin（管理员）</li>
                <li>已存在的用户名或邮箱将被跳过</li>
              </ul>
            </div>
          </div>
        </div>

        {/* 下载模板 */}
        <div className="flex items-center justify-between p-4 border border-surface-200 dark:border-surface-700 rounded-lg">
          <div className="flex items-center gap-3">
            <FileText className="w-5 h-5 text-surface-400" />
            <span className="text-sm text-surface-600 dark:text-surface-400">
              下载导入模板
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={handleDownloadTemplate}>
            <Download className="w-4 h-4 mr-2" />
            下载模板
          </Button>
        </div>

        {/* 文件选择 */}
        <div className="border-2 border-dashed border-surface-300 dark:border-surface-600 rounded-lg p-6">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            className="hidden"
            id="csv-file-input"
          />
          <label
            htmlFor="csv-file-input"
            className="flex flex-col items-center cursor-pointer"
          >
            <Upload className="w-10 h-10 text-surface-400 mb-3" />
            {file ? (
              <div className="text-center">
                <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
                  {file.name}
                </p>
                <p className="text-xs text-surface-500 mt-1">
                  {(file.size / 1024).toFixed(2)} KB
                </p>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-sm text-surface-600 dark:text-surface-400">
                  点击选择 CSV 文件
                </p>
                <p className="text-xs text-surface-400 mt-1">或拖拽文件到此处</p>
              </div>
            )}
          </label>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="p-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 rounded-lg">
            {error}
          </div>
        )}

        {/* 导入结果 */}
        {result && (
          <div className="space-y-3">
            {/* 统计 */}
            <div className="grid grid-cols-4 gap-3">
              <div className="p-3 bg-surface-100 dark:bg-surface-800 rounded-lg text-center">
                <div className="text-lg font-bold text-surface-700 dark:text-surface-300">
                  {result.total}
                </div>
                <div className="text-xs text-surface-500">总数</div>
              </div>
              <div className="p-3 bg-green-50 dark:bg-green-900/20 rounded-lg text-center">
                <div className="text-lg font-bold text-green-600 dark:text-green-400">
                  {result.created}
                </div>
                <div className="text-xs text-green-600 dark:text-green-400">成功</div>
              </div>
              <div className="p-3 bg-orange-50 dark:bg-orange-900/20 rounded-lg text-center">
                <div className="text-lg font-bold text-orange-600 dark:text-orange-400">
                  {result.skipped}
                </div>
                <div className="text-xs text-orange-600 dark:text-orange-400">跳过</div>
              </div>
              <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg text-center">
                <div className="text-lg font-bold text-red-600 dark:text-red-400">
                  {result.failed}
                </div>
                <div className="text-xs text-red-600 dark:text-red-400">失败</div>
              </div>
            </div>

            {/* 详细结果 */}
            {result.details.length > 0 && (
              <div className="max-h-48 overflow-y-auto border border-surface-200 dark:border-surface-700 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-surface-50 dark:bg-surface-800 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left text-surface-600 dark:text-surface-400">
                        行号
                      </th>
                      <th className="px-3 py-2 text-left text-surface-600 dark:text-surface-400">
                        用户名
                      </th>
                      <th className="px-3 py-2 text-left text-surface-600 dark:text-surface-400">
                        状态
                      </th>
                      <th className="px-3 py-2 text-left text-surface-600 dark:text-surface-400">
                        消息
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.details.map((item, index) => (
                      <tr
                        key={index}
                        className="border-t border-surface-100 dark:border-surface-700"
                      >
                        <td className="px-3 py-2 text-surface-600 dark:text-surface-400">
                          {item.row}
                        </td>
                        <td className="px-3 py-2 text-surface-700 dark:text-surface-300">
                          {item.username}
                        </td>
                        <td className="px-3 py-2">{renderResultIcon(item)}</td>
                        <td className="px-3 py-2 text-surface-600 dark:text-surface-400">
                          {item.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex justify-end gap-3 pt-4">
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            {result ? '关闭' : '取消'}
          </Button>
          {!result && (
            <Button onClick={handleImport} disabled={loading || !file}>
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  导入中...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  开始导入
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};
