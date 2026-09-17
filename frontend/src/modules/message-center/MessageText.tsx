import { MarkdownContent } from '@/components/chat/MarkdownContent';

export function MessageText({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words text-left [&_p]:whitespace-pre-wrap [&_li]:whitespace-pre-wrap [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_a]:text-inherit">
      <MarkdownContent content={text} />
    </div>
  );
}
