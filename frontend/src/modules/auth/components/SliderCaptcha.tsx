import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Check, GripVertical, RefreshCw, ShieldCheck } from 'lucide-react';
import { authService, type LoginCaptchaChallenge } from '@/modules/auth/services/authService';
import {
  formatAppErrorDescription,
  isRequestCancelled,
  toAppError,
} from '@/libs/http/apiClient';
import { cn } from '@/libs/utils/cn';

type CaptchaStatus = 'loading' | 'ready' | 'verifying' | 'verified' | 'error';

interface SliderCaptchaProps {
  onTokenChange: (token: string | null) => void;
  resetKey?: number;
  disabled?: boolean;
  className?: string;
}

const sliderThumbSize = 44;
const errorFeedbackDuration = 250;

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function SliderCaptcha({ onTokenChange, resetKey = 0, disabled = false, className }: SliderCaptchaProps) {
  const [challenge, setChallenge] = useState<LoginCaptchaChallenge | null>(null);
  const [position, setPosition] = useState(0);
  const [status, setStatus] = useState<CaptchaStatus>('loading');
  const [message, setMessage] = useState('正在加载安全验证');
  const trackRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef(0);
  const dragRef = useRef<{ pointerX: number; position: number } | null>(null);
  const requestSequenceRef = useRef(0);

  const loadChallenge = useCallback(async (preserveErrorFeedback = false) => {
    const requestSequence = ++requestSequenceRef.current;
    onTokenChange(null);
    dragRef.current = null;
    if (!preserveErrorFeedback) {
      setChallenge(null);
      setPosition(0);
      positionRef.current = 0;
      setStatus('loading');
      setMessage('正在加载安全验证');
    }

    let nextChallenge: LoginCaptchaChallenge | null = null;
    let loadError: unknown;
    try {
      nextChallenge = await authService.getLoginCaptcha();
    } catch (error) {
      loadError = error;
    }
    if (preserveErrorFeedback) {
      await waitFor(errorFeedbackDuration);
    }
    if (requestSequence !== requestSequenceRef.current) return;

    setPosition(0);
    positionRef.current = 0;
    if (loadError || !nextChallenge) {
      if (isRequestCancelled(loadError)) return;
      setChallenge(null);
      setStatus('error');
      setMessage(formatAppErrorDescription(toAppError(loadError, '安全验证加载失败')));
      return;
    }
    setChallenge(nextChallenge);
    setStatus('ready');
    setMessage('请完成安全验证');
  }, [onTokenChange]);

  useEffect(() => {
    const initialLoadTimer = window.setTimeout(() => {
      void loadChallenge();
    }, 0);
    return () => {
      window.clearTimeout(initialLoadTimer);
      requestSequenceRef.current += 1;
    };
  }, [loadChallenge, resetKey]);

  const maximum = challenge ? challenge.width - challenge.piece_width : 0;
  const progress = maximum > 0 ? position / maximum : 0;

  const updatePosition = useCallback((nextPosition: number) => {
    if (!challenge) return;
    const next = Math.min(maximum, Math.max(0, Math.round(nextPosition)));
    positionRef.current = next;
    setPosition(next);
  }, [challenge, maximum]);

  const verify = useCallback(async () => {
    if (!challenge || status !== 'ready' || disabled) return;
    const requestSequence = requestSequenceRef.current;
    setStatus('verifying');
    setMessage('正在校验');
    try {
      const result = await authService.verifyLoginCaptcha(challenge.captcha_id, positionRef.current);
      if (requestSequence !== requestSequenceRef.current) return;
      onTokenChange(result.captcha_token);
      setStatus('verified');
      setMessage('验证通过');
    } catch (error) {
      if (requestSequence !== requestSequenceRef.current) return;
      if (isRequestCancelled(error)) return;
      onTokenChange(null);
      setStatus('error');
      setMessage(formatAppErrorDescription(toAppError(error, '验证未通过，正在刷新')));
      void loadChallenge(true);
    }
  }, [challenge, disabled, loadChallenge, onTokenChange, status]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!challenge || status !== 'ready' || disabled) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { pointerX: event.clientX, position: positionRef.current };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !challenge || status !== 'ready') return;
    const trackWidth = trackRef.current?.getBoundingClientRect().width ?? 0;
    const travel = Math.max(1, trackWidth - sliderThumbSize);
    const delta = (event.clientX - dragRef.current.pointerX) * (maximum / travel);
    updatePosition(dragRef.current.position + delta);
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    void verify();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!challenge || status !== 'ready' || disabled) return;
    const step = event.shiftKey ? 10 : 2;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        event.preventDefault();
        updatePosition(positionRef.current - step);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        event.preventDefault();
        updatePosition(positionRef.current + step);
        break;
      case 'Home':
        event.preventDefault();
        updatePosition(0);
        break;
      case 'End':
        event.preventDefault();
        updatePosition(maximum);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        void verify();
        break;
    }
  };

  const interactive = Boolean(challenge) && status === 'ready' && !disabled;
  const thumbLeft = `calc(${progress * 100}% - ${progress * sliderThumbSize}px)`;

  return (
    <div className={cn('space-y-2', className)} data-testid="slider-captcha">
      <div className="flex min-h-5 items-center justify-between gap-3 text-xs">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 font-medium',
            status === 'verified' ? 'text-emerald-700 dark:text-emerald-300' : 'text-surface-600 dark:text-surface-300',
            status === 'error' && 'text-red-600 dark:text-red-400',
          )}
          role="status"
          aria-live="polite"
        >
          {status === 'verified' ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
          {message}
        </span>
        <button
          type="button"
          onClick={() => void loadChallenge()}
          disabled={disabled || status === 'loading' || status === 'verifying'}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-surface-500 transition-colors hover:bg-surface-100 hover:text-secondary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary-500/40 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-surface-800 dark:hover:text-secondary-300"
          aria-label="刷新验证码"
          title="刷新验证码"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', status === 'loading' && 'animate-spin')} aria-hidden="true" />
        </button>
      </div>

      <div className="relative aspect-2/1 w-full overflow-hidden rounded-md border border-surface-200 bg-surface-100 dark:border-surface-700 dark:bg-surface-800">
        {challenge ? (
          <>
            <img src={challenge.background_image} alt="滑块验证码背景" className="h-full w-full select-none object-cover" draggable={false} />
            <img
              src={challenge.piece_image}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="pointer-events-none absolute select-none drop-shadow-[0_2px_3px_rgba(0,0,0,0.45)]"
              style={{
                left: `${(position / challenge.width) * 100}%`,
                top: `${(challenge.piece_y / challenge.height) * 100}%`,
                width: `${(challenge.piece_width / challenge.width) * 100}%`,
                height: `${(challenge.piece_height / challenge.height) * 100}%`,
              }}
            />
            {status === 'verified' ? (
              <div className="absolute inset-0 flex items-center justify-center bg-emerald-950/35 text-white backdrop-blur-[1px]">
                <Check className="h-8 w-8" aria-hidden="true" />
              </div>
            ) : null}
          </>
        ) : (
          <div className="absolute inset-0 animate-pulse bg-surface-200 dark:bg-surface-700" aria-hidden="true" />
        )}
      </div>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={interactive ? 0 : -1}
        aria-label="滑块验证码"
        aria-valuemin={0}
        aria-valuemax={maximum}
        aria-valuenow={position}
        aria-valuetext={status === 'verified' ? '验证通过' : `${Math.round(progress * 100)}%`}
        aria-disabled={!interactive}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onKeyDown={handleKeyDown}
        className={cn(
          'relative h-11 touch-none select-none overflow-hidden rounded-md border border-surface-200 bg-surface-100 outline-none dark:border-surface-700 dark:bg-surface-800',
          interactive ? 'cursor-grab focus-visible:ring-2 focus-visible:ring-secondary-500/50 active:cursor-grabbing' : 'cursor-not-allowed opacity-70',
        )}
      >
        <div className={cn('absolute inset-y-0 left-0 bg-secondary-100 dark:bg-secondary-900/40', status === 'verified' && 'bg-emerald-100 dark:bg-emerald-900/40')} style={{ width: `${progress * 100}%` }} />
        <div
          className={cn(
            'absolute top-0 flex h-[42px] w-11 items-center justify-center rounded-sm border bg-white text-secondary-700 shadow-sm transition-colors dark:bg-surface-900 dark:text-secondary-300',
            status === 'verified' ? 'border-emerald-500 text-emerald-700 dark:text-emerald-300' : 'border-surface-300 dark:border-surface-600',
          )}
          style={{ left: thumbLeft }}
        >
          {status === 'verified' ? <Check className="h-4 w-4" aria-hidden="true" /> : <GripVertical className="h-4 w-4" aria-hidden="true" />}
        </div>
      </div>
    </div>
  );
}
