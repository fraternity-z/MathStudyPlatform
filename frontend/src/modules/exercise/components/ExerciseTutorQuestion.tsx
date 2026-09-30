import { MarkdownContent } from '@/components/chat/MarkdownContent';
import type { ExerciseTutorResponse } from '@/modules/session/services/sessionService';

export function ExerciseTutorQuestion({ question }: { question: ExerciseTutorResponse['exercise'] }) {
  return <section aria-label="辅导题目" className="min-w-0 rounded-2xl border border-primary-200 bg-primary-50/50 p-4 text-sm text-surface-800 dark:border-primary-900 dark:bg-primary-950/20 dark:text-surface-200 sm:p-5">
    <p className="mb-2 text-xs font-medium text-primary-600 dark:text-primary-400">本次练习题</p>
    <h2 className="mb-3 break-words font-semibold">{question.title || 'AI 练习题'}</h2>
    <div className="min-w-0 overflow-x-auto wrap-anywhere">
      <MarkdownContent content={question.content} />
    </div>
    {question.options?.length > 0 && <ol aria-label="题目选项" className="mt-4 space-y-2">
      {question.options.map((option, index) => <li key={index} className="flex items-start gap-2">
        <span className="shrink-0 font-medium">{String.fromCharCode(65 + index)}.</span>
        <div className="min-w-0 flex-1 overflow-x-auto wrap-anywhere"><MarkdownContent content={option} /></div>
      </li>)}
    </ol>}
  </section>;
}
