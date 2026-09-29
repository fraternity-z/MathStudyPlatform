import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { sessionService } from '@/modules/session/services/sessionService';
import { toAppError } from '@/libs/http/appError';

export function ExerciseHintButton({ exerciseId }: { exerciseId: string }) {
  const navigate = useNavigate();
  const pending = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);

  const openTutor = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError(null);
    try {
      const tutor = await sessionService.prepareExerciseTutor(exerciseId, controller.signal);
      if (!controller.signal.aborted) navigate(`/session/${tutor.session_id}`);
    } catch (cause) {
      if (!controller.signal.aborted) setError(toAppError(cause, '提示暂时不可用，请重试').message);
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setLoading(false);
      }
    }
  };

  return <div className="space-y-2">
    <Button className="w-full" disabled={loading} onClick={() => { void openTutor(); }}>
      <MessageCircle className="mr-2 h-4 w-4" />
      {loading ? '正在打开辅导…' : error ? '重试获取提示' : '给点提示'}
    </Button>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </div>;
}
