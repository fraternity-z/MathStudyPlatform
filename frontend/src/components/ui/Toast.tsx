/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { cn } from '../../libs/utils/cn';
import { animationDuration } from '../../libs/animations';

/**
 * Toast 类型定义
 */
export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

/**
 * Toast 样式配置（模块级常量，避免重复创建）
 */
const TOAST_ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle className="w-5 h-5" />,
  error: <AlertCircle className="w-5 h-5" />,
  info: <Info className="w-5 h-5" />,
  warning: <AlertTriangle className="w-5 h-5" />,
};

const TOAST_COLORS: Record<ToastType, string> = {
  success: 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100',
  error: 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-900 dark:text-red-100',
  info: 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-900 dark:text-blue-100',
  warning: 'bg-yellow-50 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800 text-yellow-900 dark:text-yellow-100',
};

const TOAST_ICON_COLORS: Record<ToastType, string> = {
  success: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-red-600 dark:text-red-400',
  info: 'text-blue-600 dark:text-blue-400',
  warning: 'text-yellow-600 dark:text-yellow-400',
};

/**
 * Toast 数据接口
 */
export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
  duration?: number;
  action?: ToastAction;
  dedupeKey?: string;
}

export type ToastOptions = Omit<Toast, 'id'>;

/**
 * Toast Context 接口
 */
interface ToastActionsContextType {
  addToast: (toast: ToastOptions) => string;
  removeToast: (id: string) => void;
}

const ToastActionsContext = createContext<ToastActionsContextType | undefined>(undefined);
const ToastStateContext = createContext<Toast[] | undefined>(undefined);

/**
 * useToast Hook
 *
 * 用于在组件中触发 Toast 通知
 *
 * @example
 * ```tsx
 * const { toast } = useToast();
 *
 * toast({
 *   type: 'success',
 *   title: '保存成功',
 *   description: '您的更改已保存',
 *   duration: 3000
 * });
 * ```
 */
export const useToast = () => {
  const actions = useContext(ToastActionsContext);
  if (!actions) {
    throw new Error('useToast must be used within ToastProvider');
  }

  const toast = useCallback((options: ToastOptions) => {
    return actions.addToast(options);
  }, [actions]);

  return { toast, removeToast: actions.removeToast };
};

const useToastState = (): Toast[] => {
  const toasts = useContext(ToastStateContext);
  if (!toasts) {
    throw new Error('useToastState must be used within ToastProvider');
  }
  return toasts;
};

/**
 * ToastProvider - Toast 上下文提供者
 *
 * 需要包裹在应用的根组件中
 */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastsRef = useRef<Toast[]>([]);

  const addToast = useCallback((toast: ToastOptions): string => {
    if (toast.dedupeKey !== undefined) {
      const duplicate = toastsRef.current.find(
        (activeToast) => activeToast.dedupeKey === toast.dedupeKey
      );
      if (duplicate) return duplicate.id;
    }

    const id = Math.random().toString(36).substring(2, 9);
    const newToast: Toast = {
      ...toast,
      id,
      duration: toast.duration ?? animationDuration.slow * 6 // 默认 3000ms
    };
    const nextToasts = [...toastsRef.current, newToast];
    toastsRef.current = nextToasts;
    setToasts(nextToasts);
    return id;
  }, []);

  const removeToast = useCallback((id: string) => {
    const nextToasts = toastsRef.current.filter((toast) => toast.id !== id);
    toastsRef.current = nextToasts;
    setToasts(nextToasts);
  }, []);

  const actions = useMemo(() => ({ addToast, removeToast }), [addToast, removeToast]);

  return (
    <ToastActionsContext.Provider value={actions}>
      <ToastStateContext.Provider value={toasts}>
        {children}
        <ToastContainer />
      </ToastStateContext.Provider>
    </ToastActionsContext.Provider>
  );
};

/**
 * ToastContainer - Toast 容器组件
 *
 * 负责渲染所有 Toast 通知
 */
const ToastContainer: React.FC = () => {
  const toasts = useToastState();

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
};

/**
 * ToastItem - 单个 Toast 通知组件
 */
const ToastItem: React.FC<{ toast: Toast }> = ({ toast }) => {
  const { removeToast } = useToast();
  const [isExiting, setIsExiting] = useState(false);
  const removalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startExit = useCallback(() => {
    if (removalTimerRef.current !== null) return;
    setIsExiting(true);
    removalTimerRef.current = setTimeout(() => {
      removalTimerRef.current = null;
      removeToast(toast.id);
    }, animationDuration.normal);
  }, [removeToast, toast.id]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (toast.duration && toast.duration > 0) {
      timer = setTimeout(startExit, toast.duration);
    }
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      if (removalTimerRef.current !== null) {
        clearTimeout(removalTimerRef.current);
        removalTimerRef.current = null;
      }
    };
  }, [toast.duration, startExit]);

  const handleClose = startExit;

  const handleAction = () => {
    startExit();
    toast.action?.onClick();
  };

  return (
    <div
      className={cn(
        "pointer-events-auto w-96 max-w-[calc(100vw-2rem)] rounded-lg border shadow-lg p-4",
        "transition-all duration-300",
        TOAST_COLORS[toast.type],
        isExiting ? "opacity-0 translate-x-full" : "opacity-100 translate-x-0 animate-slide-in-right"
      )}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <div className={cn("shrink-0 mt-0.5", TOAST_ICON_COLORS[toast.type])}>
          {TOAST_ICONS[toast.type]}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm mb-1">{toast.title}</h3>
          {toast.description && (
            <p className="break-words text-sm opacity-90">{toast.description}</p>
          )}
          {toast.action && (
            <button
              type="button"
              onClick={handleAction}
              className="mt-2 inline-flex min-h-8 items-center rounded-md border border-current/25 px-2.5 py-1 text-sm font-medium transition-colors hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-1 dark:hover:bg-white/10"
            >
              {toast.action.label}
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={handleClose}
          className="shrink-0 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-1"
          aria-label="关闭通知"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
