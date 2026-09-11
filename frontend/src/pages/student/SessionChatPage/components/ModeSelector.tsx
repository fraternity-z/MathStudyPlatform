import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../../../libs/utils/cn';
import type { ChatMode } from '@/modules/session/types';
import type { ModeConfig } from '../constants.tsx';

interface ModeSelectorProps {
  modes: ModeConfig[];
  currentMode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  disabled?: boolean;
}

export const ModeSelector = React.memo<ModeSelectorProps>(({ modes, currentMode, onModeChange, disabled }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const activeMode = useMemo(
    () => modes.find((mode) => mode.id === currentMode) ?? modes[0],
    [modes, currentMode]
  );

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  const handleSelect = (mode: ModeConfig) => {
    if (disabled) return;
    onModeChange(mode.id);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      {/* 胶囊按钮：图标 + 文字 + 小三角 */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
        className={cn(
          'inline-flex items-center gap-2 px-4 py-2 rounded-full border transition-colors duration-150',
          'bg-emerald-50 text-emerald-600 border-emerald-100',
          'hover:bg-emerald-100 hover:border-emerald-200',
          'dark:bg-emerald-900/15 dark:text-emerald-300 dark:border-emerald-800',
          'dark:hover:bg-emerald-900/30',
          'disabled:opacity-60 disabled:cursor-not-allowed'
        )}
      >
        <div className="inline-flex items-center justify-center">
          <span className="text-current">{activeMode.icon}</span>
        </div>
        <span className="text-sm font-medium leading-none">{activeMode.name}</span>
        <ChevronDown
          className={cn(
            'ml-1 h-3 w-3 text-current transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>

      {/* 三个学习入口 */}
      {open && (
        <div className="absolute z-20 mt-3 w-[640px] max-w-[90vw] rounded-2xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 shadow-lg">
          <div className="px-4 py-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {modes.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => handleSelect(mode)}
                  className={cn(
                    'relative p-4 rounded-xl border-2 transition-all duration-200 text-left',
                    'hover:shadow-md hover:scale-[1.02] active:scale-[0.98]',
                    disabled && 'opacity-50 cursor-not-allowed hover:scale-100',
                    currentMode === mode.id
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 shadow-sm'
                      : 'border-surface-200 dark:border-surface-700 hover:border-primary-300 dark:hover:border-primary-700'
                  )}
                >
                  {currentMode === mode.id && (
                    <div className="absolute top-2 right-2 w-2 h-2 bg-primary-500 rounded-full" />
                  )}

                  <div
                    className={cn(
                      'mb-2 p-2 rounded-lg inline-flex',
                      currentMode === mode.id ? mode.bgColor : 'bg-surface-100 dark:bg-surface-700'
                    )}
                  >
                    <span className={currentMode === mode.id ? mode.color : 'text-surface-500'}>
                      {mode.icon}
                    </span>
                  </div>

                  <div>
                    <div
                      className={cn(
                        'font-semibold text-sm mb-0.5',
                        currentMode === mode.id
                          ? 'text-primary-700 dark:text-primary-300'
                          : 'text-surface-900 dark:text-surface-100'
                      )}
                    >
                      {mode.name}
                    </div>
                    <div className="text-xs text-surface-500 dark:text-surface-400 leading-tight">
                      {mode.description}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

ModeSelector.displayName = 'ModeSelector';
