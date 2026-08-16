import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../libs/utils/cn';
import { animationCombos } from '../../libs/animations';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  showHeader?: boolean;
  ariaLabel?: string;
  stickyHeader?: boolean;
  stickyHeaderContent?: React.ReactNode;
}

let bodyScrollLockCount = 0;
let bodyOverflowBeforeLock = '';

function acquireBodyScrollLock() {
  if (bodyScrollLockCount === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }

  bodyScrollLockCount += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    bodyScrollLockCount -= 1;

    if (bodyScrollLockCount === 0) {
      document.body.style.overflow = bodyOverflowBeforeLock;
      bodyOverflowBeforeLock = '';
    }
  };
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  className,
  showHeader = true,
  ariaLabel,
  stickyHeader = false,
  stickyHeaderContent,
}) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const hasVisibleTitle = showHeader && Boolean(title);

  // Prevent scrolling when modal is open
  useEffect(() => {
    if (!isOpen) return;

    return acquireBodyScrollLock();
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;

    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frame);
      const restoreTarget = restoreFocusRef.current;
      if (restoreTarget && document.contains(restoreTarget)) {
        restoreTarget.focus({ preventScroll: true });
      }
      restoreFocusRef.current = null;
    };
  }, [isOpen]);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;

    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => !element.hasAttribute('hidden') && element.getClientRects().length > 0);

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

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-100 flex items-center justify-center overflow-y-auto overflow-x-hidden p-4">
      {/* Backdrop with gradient */}
      <div
        className="absolute inset-0 bg-surface-900/60 backdrop-blur-md dark:bg-surface-950/80 animate-fade-in motion-reduce:animate-none"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Decorative background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary-500/10 rounded-full blur-[100px]" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-secondary-500/10 rounded-full blur-[100px]" />
      </div>

      {/* Modal Content */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={cn(
          "relative w-full max-w-md transform rounded-3xl bg-white p-8 text-left shadow-2xl border border-surface-100",
          "dark:bg-surface-900 dark:border-surface-700",
          "animate-fade-in animate-scale-in motion-reduce:animate-none",
          className,
          stickyHeader && 'flex min-h-0 flex-col overflow-hidden'
        )}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={hasVisibleTitle ? undefined : ariaLabel || '弹窗'}
        aria-labelledby={hasVisibleTitle ? titleId : undefined}
      >
        {stickyHeader ? (
          <>
            <div className="relative z-10 flex shrink-0 items-start justify-between gap-3 border-b border-surface-200/80 bg-white/95 py-2 backdrop-blur-sm dark:border-surface-700/80 dark:bg-surface-900/95">
              <div className="min-w-0 flex-1 pr-2">
                {showHeader && title ? (
                  <h3 id={titleId} className="truncate text-xl font-semibold leading-6 text-surface-900 dark:text-surface-100">
                    {title}
                  </h3>
                ) : null}
                {stickyHeaderContent ? (
                  <div className="mt-1 min-w-0">
                    {stickyHeaderContent}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className={cn(
                  "mt-0.5 shrink-0 rounded-full p-2 text-surface-400 hover:bg-surface-100 hover:text-surface-600 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:text-surface-500 dark:hover:bg-surface-800 dark:hover:text-surface-300",
                  animationCombos.buttonHover
                )}
                onClick={onClose}
                aria-label="关闭弹窗"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {children}
            </div>
          </>
        ) : (
          <>
            {/* Close button */}
            <div className="pointer-events-none absolute top-4 right-4 z-10">
              <button
                type="button"
                className={cn(
                  "pointer-events-auto rounded-full p-2 text-surface-400 hover:bg-surface-100 hover:text-surface-600 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:text-surface-500 dark:hover:bg-surface-800 dark:hover:text-surface-300",
                  animationCombos.buttonHover
                )}
                onClick={onClose}
                aria-label="关闭弹窗"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Header */}
            {showHeader && title && (
              <div className="mb-6 pr-8">
                <h3 id={titleId} className="text-xl font-semibold leading-6 text-surface-900 dark:text-surface-100">
                  {title}
                </h3>
              </div>
            )}
            {/* Content */}
            <div>{children}</div>
          </>
        )}

        {/* Subtle bottom gradient decoration */}
        <div className="absolute bottom-0 left-0 right-0 h-32 bg-linear-to-t from-surface-50/50 to-transparent rounded-b-3xl pointer-events-none dark:from-surface-800/50" />
      </div>
    </div>,
    document.body
  );
};
