import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { RequestErrorNotice } from '@/components/feedback';
import { toAppError, type AppError } from '@/libs/http/appError';
import { sessionService } from '../services/sessionService';
import { STUDY_STEPS, studyService, type StudyFoundation, type StudyProgress } from '../study';

interface StudyPanelProps {
  sessionId: string | null;
  suggestedTopic?: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onPrompt: (prompt: string) => void;
  onPractice: (topic: string) => void;
}

export function StudyPanel({ sessionId, suggestedTopic, disabled, onBusyChange, onPrompt, onPractice }: StudyPanelProps) {
  const navigate = useNavigate();
  const [progress, setProgress] = useState<StudyProgress | null>(null);
  const [topic, setTopic] = useState(suggestedTopic ?? '');
  const [foundation, setFoundation] = useState<StudyFoundation>('beginner');
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const requestVersion = useRef(0);

  useEffect(() => () => { mounted.current = false; requestVersion.current += 1; }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!sessionId) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const result = await studyService.get(sessionId, signal);
      if (mounted.current && !signal?.aborted && requestVersion.current === version) setProgress(result);
    } catch (cause) {
      if (mounted.current && !signal?.aborted && requestVersion.current === version) setError(toAppError(cause, '学习进度加载失败'));
    } finally {
      if (mounted.current && !signal?.aborted && requestVersion.current === version) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const save = async () => {
    if (disabled || inFlight.current || loading) return;
    inFlight.current = true;
    setSaving(true);
    onBusyChange(true);
    setError(null);
    let target = sessionId;
    try {
      if (!target) target = (await sessionService.createSession(topic.trim(), 'study')).session_id;
      const result = progress
        ? await studyService.next(target, progress.revision)
        : await studyService.start(target, topic.trim(), foundation);
      if (mounted.current) setProgress(result);
    } catch (cause) {
      if (mounted.current) {
        // A timeout may have committed the update. Reload before any further action.
        if (target && sessionId) await refresh();
        setError(toAppError(cause, '保存学习安排失败，请刷新后重试'));
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setSaving(false);
        onBusyChange(false);
        // Keep an already-created session accessible even if initialization failed.
        if (!sessionId && target) navigate(`/session/${target}`);
      }
    }
  };

  const complete = progress && progress.step >= STUDY_STEPS.length;
  return (
    <section aria-label="知识学习安排" className="max-h-[45dvh] shrink-0 overflow-y-auto border-b border-surface-200 bg-white px-4 py-3 dark:border-surface-700 dark:bg-surface-800">
      {loading ? <p className="text-sm text-surface-500">正在恢复学习进度…</p> : progress ? (
        <>
          <p className="text-sm font-medium">{progress.topic} · {complete ? '本轮已完成' : `${progress.step + 1}/5 ${STUDY_STEPS[progress.step]}`}</p>
          <ol className="my-2 flex flex-wrap gap-2 text-xs text-surface-500">
            {STUDY_STEPS.map((step, index) => <li key={step} aria-current={index === progress.step ? 'step' : undefined} className={index === progress.step ? 'font-semibold text-primary-600' : ''}>{index < progress.step ? '✓ ' : `${index + 1}. `}{step}</li>)}
          </ol>
          <p className="mb-2 text-xs text-surface-500">进度由你确认保存，不代表测评成绩。理解检查时先作答，获得反馈后再继续。</p>
          <div className="flex flex-wrap gap-2">
            {!complete && <>
              <Button size="sm" disabled={disabled || saving || Boolean(error)} onClick={() => onPrompt(`请开始本环节「${STUDY_STEPS[progress.step]}」，围绕已保存的学习主题讲解；如果是理解检查，请先出一个问题等我回答。`)}>开始本环节</Button>
              <Button size="sm" variant="outline" disabled={disabled || saving || Boolean(error)} onClick={() => onPrompt('我还没有理解当前环节，请换一种讲法，先不要进入下一环节。')}>换种讲法</Button>
              <Button size="sm" variant="outline" disabled={disabled || saving || Boolean(error)} onClick={() => void save()}>{saving ? '保存中…' : progress.step === 4 ? '确认完成本轮' : '我已理解，下一环节'}</Button>
            </>}
            <Button size="sm" variant="outline" disabled={disabled || saving} onClick={() => onPractice(progress.topic)}>进入习题练习</Button>
          </div>
        </>
      ) : !error ? (
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="flex flex-wrap items-end gap-3">
          <label className="min-w-48 flex-1 text-sm">学习主题
            <input required maxLength={200} value={topic} onChange={(event) => setTopic(event.target.value)} disabled={disabled || saving} placeholder="例如：复合函数求导" className="mt-1 block w-full rounded-lg border border-surface-300 bg-transparent p-2 dark:border-surface-600" />
          </label>
          <label className="text-sm">已有基础
            <select value={foundation} onChange={(event) => setFoundation(event.target.value as StudyFoundation)} disabled={disabled || saving} className="mt-1 block rounded-lg border border-surface-300 bg-white p-2 dark:border-surface-600 dark:bg-surface-800">
              <option value="beginner">从零开始</option><option value="familiar">有一些基础</option><option value="review">复习巩固</option>
            </select>
          </label>
          <Button type="submit" size="sm" disabled={disabled || saving || !topic.trim()}>{saving ? '保存中…' : '建立五步学习安排'}</Button>
          <p className="w-full text-xs text-surface-500">基础回顾 → 概念理解 → 例题推导 → 理解检查 → 回顾总结。保存后点击“开始本环节”即可学习。</p>
        </form>
      ) : null}
      {error && <RequestErrorNotice error={error} onRetry={() => sessionId ? void refresh() : setError(null)} onRefresh={() => void refresh()} className="mt-2" />}
    </section>
  );
}
