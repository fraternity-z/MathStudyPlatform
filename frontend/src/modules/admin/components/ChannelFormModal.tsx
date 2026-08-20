import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Boxes,
  ClipboardPaste,
  KeyRound,
  Server,
  Settings,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/apiClient';
import {
  getAllPresetModels,
  getProviderPreset,
  getRelatedModels,
  normalizeProviderPresetCode,
  PROVIDER_PRESETS,
} from '../constants/providerPresets';
import { aiConfigService } from '@/modules/ai-config/services/aiConfigService';
import type {
  CreateProviderWithModelsRequest,
  FetchModelsResponse,
  LLMModel,
  LLMProvider,
  ModelCreateSimple,
  ModelsUpdateResponse,
  ProviderWithModelsResponse,
  UpdateProviderRequest,
} from '@/modules/ai-config/types/aiConfig';
import { ChannelAdvancedSettings } from './ChannelAdvancedSettings';
import { ChannelApiConfig } from './ChannelApiConfig';
import { ChannelBasicFields } from './ChannelBasicFields';
import {
  ChannelEditorSidebar,
  type ChannelEditorSectionId,
  type ChannelEditorSectionStatus,
} from './ChannelEditorSidebar';
import { ChannelFormActions } from './ChannelFormActions';
import { ChannelModelFetchDialog } from './ChannelModelFetchDialog';
import { ChannelModelSelector } from './ChannelModelSelector';
import { ChannelProviderIcon } from './ChannelProviderIcon';
import { ChannelSectionHeader } from './ChannelSectionHeader';
import type { ResolvedChannelModelSelection } from './channelModelCatalog';
import {
  buildBatchChannelName,
  buildModelRequests,
  parseChannelConnectionInfo,
  parseCredentialKeys,
  type CredentialMode,
  type KeyStrategy,
  uniqueTrimmed,
} from './channelFormUtils';
import { isAdminRequestCancelled, toAdminAppError } from '@/modules/admin/utils/errorFeedback';

interface ChannelFormModalProps {
  editingProvider?: LLMProvider | null;
  existingModels?: LLMModel[];
  isOpen: boolean;
  onClose: () => void;
  onFetchModels?: (providerId: string) => Promise<FetchModelsResponse>;
  onSubmit: (data: CreateProviderWithModelsRequest) => Promise<ProviderWithModelsResponse>;
  onUpdate?: (id: string, data: UpdateProviderRequest) => Promise<void>;
  onUpdateModels?: (providerId: string, models: ModelCreateSimple[]) => Promise<ModelsUpdateResponse>;
}

interface ModelFetchSession {
  id: number;
  models: string[];
}

const sectionElementIds: Record<ChannelEditorSectionId, string> = {
  basic: 'channel-editor-basic',
  credentials: 'channel-editor-credentials',
  models: 'channel-editor-models',
  advanced: 'channel-editor-advanced',
};

const requiredSections: ChannelEditorSectionId[] = ['basic', 'credentials', 'models'];
const defaultChannelPriority = 0;
const defaultChannelWeight = 100;
const emptyExistingModels: LLMModel[] = [];
const modelDialogQaFixture = [
  'gpt-5.4-mini',
  'gpt-4o',
  'claude-3-7-sonnet',
  'gemini-2.5-pro',
  'qwen-max',
  'deepseek-chat',
  'glm-4-plus',
  'custom-math-model',
];

export const ChannelFormModal: React.FC<ChannelFormModalProps> = ({
  editingProvider,
  existingModels = emptyExistingModels,
  isOpen,
  onClose,
  onFetchModels,
  onSubmit,
  onUpdate,
  onUpdateModels,
}) => {
  const { toast } = useToast();
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const modelFetchSessionIdRef = useRef(0);
  const [providerType, setProviderType] = useState('openai');
  const [name, setName] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(defaultChannelPriority);
  const [weight, setWeight] = useState(defaultChannelWeight);
  const [credentialMode, setCredentialMode] = useState<CredentialMode>('single');
  const [keyStrategy, setKeyStrategy] = useState<KeyStrategy>('round_robin');
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [modelMapping, setModelMapping] = useState<Record<string, string>>({});
  const [customModel, setCustomModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelFetchSession, setModelFetchSession] = useState<ModelFetchSession | null>(null);
  const [activeSection, setActiveSection] = useState<ChannelEditorSectionId>('basic');
  const [errorSection, setErrorSection] = useState<ChannelEditorSectionId | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [error, setError] = useState<string | AppError | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [batchCreatedCount, setBatchCreatedCount] = useState(0);

  const isEditMode = Boolean(editingProvider);
  const providerPreset = getProviderPreset(providerType);
  const defaultBaseUrl = providerPreset?.defaultBaseUrl ?? '';
  const effectiveBaseUrl = baseUrl.trim() || defaultBaseUrl;
  const credentialKeys = useMemo(() => parseCredentialKeys(apiKey), [apiKey]);
  useEffect(() => {
    if (!isOpen) return;
    if (editingProvider) {
      setProviderType(normalizeProviderPresetCode(editingProvider.code));
      setName(editingProvider.name);
      setIsActive(editingProvider.is_active);
      setBaseUrl(editingProvider.base_url);
      setDescription(editingProvider.description ?? '');
      setPriority(editingProvider.priority ?? defaultChannelPriority);
      setWeight(editingProvider.weight ?? defaultChannelWeight);
      setSelectedModels(existingModels.map((model) => model.name || model.model_id));
      setModelMapping(
        Object.fromEntries(
          existingModels
            .filter((model) => model.name && model.name !== model.model_id)
            .map((model) => [model.name, model.model_id])
        )
      );
    } else {
      setProviderType('openai');
      setName('');
      setIsActive(true);
      setBaseUrl('');
      setDescription('');
      setPriority(defaultChannelPriority);
      setWeight(defaultChannelWeight);
      setSelectedModels([]);
      setModelMapping({});
    }
    setApiKey('');
    setCredentialMode('single');
    setKeyStrategy('round_robin');
    setCustomModel('');
    setAvailableModels([]);
    setModelFetchSession(null);
    setActiveSection('basic');
    setErrorSection(null);
    setError(null);
    setConnectionNotice(null);
    setBatchCreatedCount(0);
  }, [editingProvider, existingModels, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting && !modelFetchSession) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, modelFetchSession, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const credentialComplete = (() => {
    if (!effectiveBaseUrl) return false;
    if (isEditMode && !apiKey.trim()) return true;
    if (credentialMode === 'single') return credentialKeys.length === 1;
    if (credentialMode === 'multi') return credentialKeys.length >= 2;
    return credentialKeys.length >= 1;
  })();

  const statuses: Record<ChannelEditorSectionId, ChannelEditorSectionStatus> = {
    basic: name.trim() ? 'complete' : 'idle',
    credentials: credentialComplete ? 'complete' : 'idle',
    models: selectedModels.length ? 'complete' : 'idle',
    advanced:
      description.trim() || priority !== defaultChannelPriority || weight !== defaultChannelWeight
        ? 'configured'
        : 'idle',
  };
  if (errorSection) statuses[errorSection] = 'error';
  const completedRequiredSections = requiredSections.filter((section) => statuses[section] === 'complete').length;

  const navigateToSection = (section: ChannelEditorSectionId) => {
    setActiveSection(section);
    const target = document.getElementById(sectionElementIds[section]);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const showSectionError = (message: string | AppError, section: ChannelEditorSectionId) => {
    setError(message);
    setErrorSection(section);
    navigateToSection(section);
  };

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const threshold = container.getBoundingClientRect().top + 110;
    let current: ChannelEditorSectionId = 'basic';
    for (const section of Object.keys(sectionElementIds) as ChannelEditorSectionId[]) {
      const element = document.getElementById(sectionElementIds[section]);
      if (element && element.getBoundingClientRect().top <= threshold) current = section;
    }
    setActiveSection(current);
  };

  const handleProviderTypeChange = (value: string) => {
    setProviderType(value);
    setBaseUrl('');
    setAvailableModels([]);
    setModelFetchSession(null);
    setError(null);
    setErrorSection(null);
  };

  const handleCredentialInputChange = (value: string) => {
    setApiKey(value);
  };

  const handleCredentialModeChange = (value: CredentialMode) => {
    setCredentialMode(value);
    setBatchCreatedCount(0);
  };

  const handleFetchModels = async () => {
    if (!isEditMode && (!effectiveBaseUrl || !credentialKeys[0])) {
      showSectionError('请先填写 API 地址和至少一个密钥', 'credentials');
      return;
    }
    setIsFetchingModels(true);
    setError(null);
    setErrorSection(null);
    try {
      const result = import.meta.env.DEV && effectiveBaseUrl === 'https://model-dialog-qa.example'
        ? { success: true, models: modelDialogQaFixture, message: 'QA fixture' }
        : isEditMode && editingProvider && onFetchModels
          ? await onFetchModels(editingProvider.id)
          : await aiConfigService.fetchModelsByCredentials(effectiveBaseUrl, credentialKeys[0]);
      const fetchedModels = uniqueTrimmed(result.models ?? []);
      if (result.success && (fetchedModels.length || selectedModels.length)) {
        modelFetchSessionIdRef.current += 1;
        setModelFetchSession({ id: modelFetchSessionIdRef.current, models: fetchedModels });
      } else {
        showSectionError(result.message || '未从上游获取到模型', 'models');
      }
    } catch (fetchError) {
      if (!isAdminRequestCancelled(fetchError)) {
        showSectionError(
          toAdminAppError(fetchError, '获取模型列表失败，请检查地址和密钥'),
          'models',
        );
      }
    } finally {
      setIsFetchingModels(false);
    }
  };

  const handleSaveFetchedModels = (selection: ResolvedChannelModelSelection) => {
    setSelectedModels(selection.models);
    setModelMapping(selection.mapping);
    setAvailableModels(modelFetchSession?.models ?? []);
    setModelFetchSession(null);
    setError(null);
    setErrorSection(null);
  };

  const addModels = (models: string[]) => {
    setSelectedModels((current) => uniqueTrimmed([...current, ...models]));
  };

  const handleAddCustomModel = () => {
    const model = customModel.trim();
    if (!model) return;
    addModels([model]);
    setCustomModel('');
  };

  const handleRemoveModel = (model: string) => {
    setSelectedModels((current) => current.filter((item) => item !== model));
    setModelMapping((current) => {
      if (!(model in current)) return current;
      const next = { ...current };
      delete next[model];
      return next;
    });
  };

  const handleClearModels = () => {
    setSelectedModels([]);
    setModelMapping({});
  };

  const handlePasteConnectionInfo = async () => {
    setError(null);
    setErrorSection(null);
    try {
      const clipboardText = await navigator.clipboard.readText();
      const parsed = parseChannelConnectionInfo(clipboardText);
      if (!parsed) {
        showSectionError('剪贴板中未检测到有效的连接信息', 'credentials');
        return;
      }
      const parsedProviderCode = normalizeProviderPresetCode(parsed.code ?? '');
      if (parsedProviderCode && PROVIDER_PRESETS.some((preset) => preset.code === parsedProviderCode)) {
        setProviderType(parsedProviderCode);
      }
      if (parsed.baseUrl) setBaseUrl(parsed.baseUrl);
      if (parsed.name) setName(parsed.name);
      if (parsed.models?.length) addModels(parsed.models);
      setApiKey(parsed.apiKeys.join('\n'));
      setCredentialMode(parsed.apiKeys.length > 1 ? 'multi' : 'single');
      setBatchCreatedCount(0);
      setConnectionNotice(`已填入连接信息，识别到 ${parsed.apiKeys.length} 个密钥`);
      navigateToSection('credentials');
    } catch {
      showSectionError('无法读取剪贴板，请检查浏览器权限后重试', 'credentials');
    }
  };

  const validateForm = (): ModelCreateSimple[] | null => {
    if (!name.trim()) {
      showSectionError('请输入渠道名称', 'basic');
      return null;
    }
    if (!effectiveBaseUrl) {
      showSectionError('请输入 API 地址', 'credentials');
      return null;
    }
    if (!isEditMode || apiKey.trim()) {
      if (credentialMode === 'single' && credentialKeys.length !== 1) {
        showSectionError('单密钥模式只能填写一个 API 密钥', 'credentials');
        return null;
      }
      if (credentialMode === 'multi' && credentialKeys.length < 2) {
        showSectionError('多密钥模式至少需要两个不同的 API 密钥', 'credentials');
        return null;
      }
      if (credentialMode === 'batch' && credentialKeys.length < 1) {
        showSectionError('批量添加模式至少需要一个 API 密钥', 'credentials');
        return null;
      }
      if (credentialKeys.length > 100) {
        showSectionError('一次最多支持 100 个 API 密钥', 'credentials');
        return null;
      }
    }
    if (!selectedModels.length) {
      showSectionError('请至少选择一个模型', 'models');
      return null;
    }
    if (!Number.isInteger(priority) || priority < 0 || priority > 1000) {
      showSectionError('优先级必须是 0 到 1000 之间的整数', 'advanced');
      return null;
    }
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
      showSectionError('权重必须是 1 到 1000 之间的整数', 'advanced');
      return null;
    }
    try {
      return buildModelRequests(selectedModels, modelMapping);
    } catch (validationError) {
      showSectionError(
        validationError instanceof Error ? validationError.message : '模型映射无效',
        'models'
      );
      return null;
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setErrorSection(null);
    const models = validateForm();
    if (!models) return;

    const channelName = name.trim();
    const savedChannelCount = credentialMode === 'batch'
      ? batchCreatedCount + credentialKeys.length
      : 1;
    setIsSubmitting(true);
    try {
      if (isEditMode && editingProvider && onUpdate) {
        const update: UpdateProviderRequest = {
          name: name.trim(),
          base_url: effectiveBaseUrl,
          priority,
          weight,
          is_active: isActive,
          description: description.trim(),
        };
        if (apiKey.trim()) {
          if (credentialKeys.length > 1) {
            update.api_keys = credentialKeys;
            update.key_strategy = keyStrategy;
          } else {
            update.api_key = credentialKeys[0];
          }
        }
        await onUpdate(editingProvider.id, update);
        if (onUpdateModels) await onUpdateModels(editingProvider.id, models);
      } else if (credentialMode === 'batch') {
        let created = 0;
        const batchTotal = batchCreatedCount + credentialKeys.length;
        try {
          for (let index = 0; index < credentialKeys.length; index += 1) {
            await onSubmit({
              name: buildBatchChannelName(name, batchCreatedCount + index, batchTotal),
              code: providerType,
              base_url: effectiveBaseUrl,
              api_key: credentialKeys[index],
              priority,
              weight,
              is_active: isActive,
              description: description.trim() || undefined,
              models,
            });
            created += 1;
          }
        } catch (batchError) {
          const appError = toAdminAppError(batchError, '批量创建失败');
          const completed = batchCreatedCount + created;
          if (created > 0) {
            setApiKey(credentialKeys.slice(created).join('\n'));
            setBatchCreatedCount(completed);
          }
          throw {
            ...appError,
            message: `已创建 ${completed}/${batchTotal} 个渠道，重试只会处理剩余密钥。${appError.message}`,
          } satisfies AppError;
        }
      } else {
        await onSubmit({
          name: name.trim(),
          code: providerType,
          base_url: effectiveBaseUrl,
          api_key: credentialKeys[0],
          api_keys: credentialMode === 'multi' ? credentialKeys : undefined,
          key_strategy: credentialMode === 'multi' ? keyStrategy : undefined,
          priority,
          weight,
          is_active: isActive,
          description: description.trim() || undefined,
          models,
        });
      }
      toast({
        type: 'success',
        title: isEditMode ? '渠道配置已更新' : '渠道配置已保存',
        description: savedChannelCount > 1
          ? `${savedChannelCount} 个渠道已保存`
          : `${channelName} 已保存`,
      });
      onClose();
    } catch (submitError) {
      if (!isAdminRequestCancelled(submitError)) {
        setError(toAdminAppError(submitError, '保存渠道失败'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const providerLabel = providerPreset?.name ?? providerType;
  const submitLabel = credentialMode === 'batch' && credentialKeys.length > 1
    ? `创建 ${credentialKeys.length} 个渠道`
    : undefined;

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => !element.hasAttribute('hidden'));
    if (!focusable.length) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (document.activeElement === dialogRef.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-100" role="presentation">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={() => !isSubmitting && onClose()}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        className="absolute inset-y-2 right-2 flex w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border border-surface-200 bg-white text-surface-900 shadow-2xl sm:inset-y-4 sm:right-4 sm:w-[min(calc(100vw-3rem),1600px)] dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-editor-title"
      >
        <header className="shrink-0 border-b border-surface-200 px-5 py-4 sm:px-8 sm:py-5 dark:border-surface-700">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sky-50 text-sky-600 dark:bg-sky-950/60 dark:text-sky-300">
                <ChannelProviderIcon code={providerType} />
              </span>
              <div className="min-w-0">
                <h2 id="channel-editor-title" className="flex flex-wrap items-baseline gap-x-2 text-lg font-semibold sm:text-xl">
                  <span>{isEditMode ? '编辑渠道' : '创建渠道'}</span>
                  <span className="text-sm font-normal text-surface-500 dark:text-surface-400">{providerLabel}</span>
                </h2>
                <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">
                  {isEditMode ? '更新渠道配置，完成后保存更改。' : '通过提供必要信息添加新的渠道。'}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!isEditMode && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handlePasteConnectionInfo}
                  aria-label="粘贴连接信息"
                  title="粘贴连接信息"
                >
                  <ClipboardPaste className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">粘贴连接信息</span>
                </Button>
              )}
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="rounded-md p-2 text-surface-500 transition-colors hover:bg-surface-100 hover:text-surface-900 disabled:opacity-50 dark:hover:bg-surface-800 dark:hover:text-white"
                aria-label="关闭渠道编辑器"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </header>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-5 sm:px-7"
          >
            {(error || connectionNotice) && (
              <div className="mx-auto mb-5 max-w-7xl space-y-3">
                {typeof error === 'string' && (
                  <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                  </div>
                )}
                {error && typeof error !== 'string' ? <RequestErrorNotice error={error} /> : null}
                {connectionNotice && (
                  <div className="rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300">
                    {connectionNotice}
                  </div>
                )}
              </div>
            )}

            <div className="mx-auto grid max-w-[1440px] gap-8 lg:grid-cols-[306px_minmax(0,1fr)] lg:items-start">
              <ChannelEditorSidebar
                activeSection={activeSection}
                completedRequiredSections={completedRequiredSections}
                isActive={isActive}
                onNavigate={navigateToSection}
                providerCode={providerType}
                providerLabel={providerLabel}
                statuses={statuses}
              />

              <main className="min-w-0 space-y-8">
                <section id={sectionElementIds.basic} className="scroll-mt-5 border-b border-surface-200 pb-8 dark:border-surface-700">
                  <ChannelSectionHeader
                    title="基本信息"
                    description="名称、供应商类型和可用状态。"
                    icon={Server}
                    tone="blue"
                  />
                  <div className="mt-5">
                    <ChannelBasicFields
                      isActive={isActive}
                      isEditMode={isEditMode}
                      name={name}
                      onActiveChange={setIsActive}
                      onNameChange={setName}
                      onProviderTypeChange={handleProviderTypeChange}
                      providerType={providerType}
                    />
                  </div>
                </section>

                <section id={sectionElementIds.credentials} className="scroll-mt-5 border-b border-surface-200 pb-8 dark:border-surface-700">
                  <ChannelSectionHeader
                    title="凭证"
                    description="API 访问地址、身份验证与密钥选择策略。"
                    icon={KeyRound}
                    tone="emerald"
                  />
                  <div className="mt-5">
                    <ChannelApiConfig
                      apiKey={apiKey}
                      baseUrl={baseUrl}
                      credentialMode={credentialMode}
                      defaultBaseUrl={defaultBaseUrl}
                      isEditMode={isEditMode}
                      keyStrategy={keyStrategy}
                      onApiKeyChange={handleCredentialInputChange}
                      onBaseUrlChange={setBaseUrl}
                      onCredentialModeChange={handleCredentialModeChange}
                      onKeyStrategyChange={setKeyStrategy}
                    />
                  </div>
                </section>

                <section id={sectionElementIds.models} className="scroll-mt-5 border-b border-surface-200 pb-8 dark:border-surface-700">
                  <ChannelSectionHeader
                    title="模型与分组"
                    description="已发布的模型、快捷填充和模型重映射规则。"
                    icon={Boxes}
                    tone="fuchsia"
                  />
                  <div className="mt-5">
                    <ChannelModelSelector
                      selectedModels={selectedModels}
                      availableModels={availableModels}
                      customModel={customModel}
                      isFetchingModels={isFetchingModels}
                      canFetchModels={isEditMode || Boolean(effectiveBaseUrl && credentialKeys[0])}
                      modelMapping={modelMapping}
                      onFetchModels={handleFetchModels}
                      onClearModels={handleClearModels}
                      onRemoveModel={handleRemoveModel}
                      onCustomModelChange={setCustomModel}
                      onAddCustomModel={handleAddCustomModel}
                      onFillRelatedModels={() => addModels(getRelatedModels(providerType).slice(0, 3))}
                      onFillAllModels={() => addModels(uniqueTrimmed([
                        ...getRelatedModels(providerType),
                        ...(providerType === 'custom' ? getAllPresetModels() : []),
                      ]))}
                      onModelMappingChange={setModelMapping}
                    />
                  </div>
                </section>

                <section id={sectionElementIds.advanced} className="scroll-mt-5 pb-2">
                  <ChannelSectionHeader
                    title="高级设置"
                    description="渠道调度参数和维护备注。"
                    icon={Settings}
                    tone="slate"
                  />
                  <div className="mt-5">
                    <ChannelAdvancedSettings
                      description={description}
                      onDescriptionChange={setDescription}
                      onPriorityChange={setPriority}
                      onWeightChange={setWeight}
                      priority={priority}
                      weight={weight}
                    />
                  </div>
                </section>
              </main>
            </div>
          </div>

          <ChannelFormActions
            isEditMode={isEditMode}
            isSubmitting={isSubmitting}
            onClose={onClose}
            submitLabel={submitLabel}
          />
        </form>
      </div>
      {modelFetchSession ? (
        <ChannelModelFetchDialog
          key={modelFetchSession.id}
          channelName={name.trim() || '未命名渠道'}
          fetchedModels={modelFetchSession.models}
          initialMapping={modelMapping}
          initialModels={selectedModels}
          onClose={() => setModelFetchSession(null)}
          onSave={handleSaveFetchedModels}
        />
      ) : null}
    </div>,
    document.body
  );
};

export default ChannelFormModal;
