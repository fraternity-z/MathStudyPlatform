/**
 * 渠道卡片组件
 *
 * 显示单个 AI 渠道（提供商）的信息，支持展开查看模型列表
 */

import React, { useState } from 'react';
import {
  Brain,
  ChevronDown,
  ChevronUp,
  Edit,
  Trash2,
  Power,
  PowerOff,
  Zap,
  ExternalLink,
  Loader2,
  CheckCircle,
  XCircle,
  Gauge,
  Scale,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import type { LLMProvider, LLMModel, ProviderTestResult } from '@/modules/ai-config/types/aiConfig';
import {
  getAdminErrorDescription,
  isAdminRequestCancelled,
  toAdminAppError,
} from '@/modules/admin/utils/errorFeedback';

interface ChannelCardProps {
  provider: LLMProvider;
  models: LLMModel[];
  onEdit: (provider: LLMProvider) => void;
  onDelete: (provider: LLMProvider) => void | Promise<void>;
  onToggleActive: (provider: LLMProvider) => void | Promise<void>;
  onTestConnection: (provider: LLMProvider, modelId?: string) => Promise<ProviderTestResult>;
  onSetDefaultModel?: (modelId: string) => void | Promise<void>;
}

export const ChannelCard: React.FC<ChannelCardProps> = ({
  provider,
  models,
  onEdit,
  onDelete,
  onToggleActive,
  onTestConnection,
  onSetDefaultModel,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const providerCode = provider.code === 'openai-responses' ? 'openai' : provider.code;

  // 测试连接
  const handleTestConnection = async (modelId?: string) => {
    setIsTesting(true);
    setTestingModelId(modelId || null);
    setTestResult(null);
    try {
      const result = await onTestConnection(provider, modelId);
      setTestResult(result);
    } catch (error) {
      if (isAdminRequestCancelled(error)) return;
      const appError = toAdminAppError(error, '测试连接失败');
      setTestResult({
        success: false,
        message: getAdminErrorDescription(appError),
        latency_ms: 0,
      });
    } finally {
      setIsTesting(false);
      setTestingModelId(null);
    }
  };

  // 获取状态徽章
  const getStatusBadge = () => {
    if (provider.is_active) {
      return <Badge variant="success">运行中</Badge>;
    }
    return <Badge variant="default">已禁用</Badge>;
  };

  // 获取提供商图标颜色
  const getProviderColor = () => {
    const colors: Record<string, string> = {
      openai: 'text-emerald-600 dark:text-emerald-400',
      deepseek: 'text-blue-600 dark:text-blue-400',
      qwen: 'text-orange-600 dark:text-orange-400',
      anthropic: 'text-purple-600 dark:text-purple-400',
      zhipu: 'text-red-600 dark:text-red-400',
      moonshot: 'text-yellow-600 dark:text-yellow-400',
    };
    return colors[providerCode] || 'text-primary-600 dark:text-primary-400';
  };

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {/* 主要信息区域 */}
        <div className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-start space-x-4 flex-1">
              {/* 图标 */}
              <div className="p-3 bg-surface-100 dark:bg-surface-700 rounded-lg">
                <Brain className={`w-6 h-6 ${getProviderColor()}`} />
              </div>

              {/* 信息 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="text-lg font-semibold text-surface-900 dark:text-surface-100 truncate">
                    {provider.name}
                  </h3>
                  {getStatusBadge()}
                  <Badge variant="default" className="text-xs">
                    {providerCode}
                  </Badge>
                </div>

                <div className="text-sm text-surface-500 dark:text-surface-400 mb-2">
                  {provider.description || '暂无描述'}
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                  <div className="flex items-center gap-1 text-surface-500 dark:text-surface-400">
                    <ExternalLink className="w-4 h-4" />
                    <span className="font-mono text-xs truncate max-w-[200px]">
                      {provider.base_url}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-surface-500 dark:text-surface-400">
                    <Brain className="w-4 h-4" />
                    <span>{models.length} 个模型</span>
                  </div>
				  <div
					className="flex items-center gap-1 text-surface-500 dark:text-surface-400"
					title="数值越大越先参与调度"
				  >
					<Gauge className="h-4 w-4" />
					<span>优先级 {provider.priority}</span>
				  </div>
				  <div
					className="flex items-center gap-1 text-surface-500 dark:text-surface-400"
					title="同优先级渠道的相对选择权重"
				  >
					<Scale className="h-4 w-4" />
					<span>权重 {provider.weight}</span>
				  </div>
                </div>

                {/* 测试结果 */}
                {testResult && (
                  <div
                    className={`mt-3 p-2 rounded-lg text-sm flex items-center gap-2 ${
                      testResult.success
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400'
                        : 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400'
                    }`}
                  >
                    {testResult.success ? (
                      <CheckCircle className="w-4 h-4" />
                    ) : (
                      <XCircle className="w-4 h-4" />
                    )}
                    <span>{testResult.message}</span>
                    {testResult.success && (
                      <span className="text-xs opacity-75">({testResult.latency_ms}ms)</span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 操作按钮 */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleTestConnection()}
                disabled={isTesting}
              >
                {isTesting && !testingModelId ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Zap className="w-4 h-4" />
                )}
              </Button>
              <Button variant="outline" size="sm" onClick={() => onEdit(provider)}>
                <Edit className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onToggleActive(provider)}
                className={
                  provider.is_active
                    ? 'text-orange-600 dark:text-orange-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                }
              >
                {provider.is_active ? (
                  <PowerOff className="w-4 h-4" />
                ) : (
                  <Power className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onDelete(provider)}
                className="text-red-600 dark:text-red-400"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* 展开/收起按钮 */}
          {models.length > 0 && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="mt-3 flex items-center gap-1 text-sm text-primary-600 dark:text-primary-400 hover:underline"
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="w-4 h-4" />
                  收起模型列表
                </>
              ) : (
                <>
                  <ChevronDown className="w-4 h-4" />
                  查看 {models.length} 个模型
                </>
              )}
            </button>
          )}
        </div>

        {/* 模型列表（展开时显示） */}
        {isExpanded && models.length > 0 && (
          <div className="border-t border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-900 p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {models.map((model) => (
                <div
                  key={model.id}
                  className="flex items-center justify-between p-3 bg-white dark:bg-surface-800 rounded-lg border border-surface-200 dark:border-surface-700"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-surface-900 dark:text-surface-100 truncate">
                        {model.name}
                      </span>
                      {model.is_default && (
                        <Badge variant="success" className="text-xs">
                          默认
                        </Badge>
                      )}
                      {!model.is_active && (
                        <Badge variant="default" className="text-xs">
                          禁用
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-surface-500 dark:text-surface-400 font-mono truncate">
                      {model.model_id}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleTestConnection(model.model_id)}
                      disabled={isTesting}
                      title="测试此模型"
                    >
                      {isTesting && testingModelId === model.model_id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Zap className="w-3 h-3" />
                      )}
                    </Button>
                    {!model.is_default && onSetDefaultModel && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onSetDefaultModel(model.id)}
                        title="设为默认"
                      >
                        <CheckCircle className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default ChannelCard;
