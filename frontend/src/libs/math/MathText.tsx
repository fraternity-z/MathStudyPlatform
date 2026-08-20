import * as React from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { cn } from '../utils/cn';
import { katexStrict } from './katexStrict';

type MathTextSegment =
  | { type: 'text'; value: string }
  | { type: 'math'; value: string; block: boolean };

interface MathTextProps {
  children: string;
  className?: string;
}

const splitMathText = (text: string): MathTextSegment[] => {
  const segments: MathTextSegment[] = [];
  let cursor = 0;
  let textStart = 0;

  const appendText = (end: number) => {
    if (end > textStart) {
      segments.push({ type: 'text', value: text.slice(textStart, end) });
    }
  };

  while (cursor < text.length) {
    if (text.startsWith('$$', cursor)) {
      const end = text.indexOf('$$', cursor + 2);
      if (end === -1) {
        cursor += 2;
        continue;
      }

      appendText(cursor);
      segments.push({ type: 'math', value: text.slice(cursor + 2, end), block: true });
      cursor = end + 2;
      textStart = cursor;
      continue;
    }

    if (text[cursor] === '$') {
      const end = text.indexOf('$', cursor + 1);
      if (end > cursor + 1) {
        appendText(cursor);
        segments.push({ type: 'math', value: text.slice(cursor + 1, end), block: false });
        cursor = end + 1;
        textStart = cursor;
        continue;
      }
    }

    cursor += 1;
  }

  appendText(text.length);
  return segments;
};

const MathSegment: React.FC<{ expression: string; block: boolean }> = ({ expression, block }) => {
  const containerRef = React.useRef<HTMLSpanElement | HTMLDivElement>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.classList.remove('math-error');
    container.textContent = '';

    try {
      katex.render(expression.trim(), container, {
        displayMode: block,
        throwOnError: false,
        output: 'htmlAndMathml',
        strict: katexStrict,
        trust: false,
      });
    } catch {
      container.classList.add('math-error');
      container.textContent = expression;
    }
  }, [expression, block]);

  if (block) {
    return <div ref={containerRef as React.RefObject<HTMLDivElement>} className="math-block my-2" />;
  }

  return <span ref={containerRef as React.RefObject<HTMLSpanElement>} className="math-inline" />;
};

/**
 * MathText 组件 - 渲染混合文本和 LaTeX 公式的内容
 *
 * 支持两种格式：
 * - 行内公式：$...$
 * - 块级公式：$$...$$
 *
 * @example
 * <MathText>求极限 $\lim_{x \to 0} \frac{\sin x}{x}$</MathText>
 */
export const MathText: React.FC<MathTextProps> = ({ children, className }) => {
  const segments = React.useMemo(() => splitMathText(children), [children]);

  return (
    <div className={cn('math-text', className)}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <React.Fragment key={`text-${index}`}>{segment.value}</React.Fragment>;
        }

        return (
          <MathSegment
            key={`math-${index}`}
            expression={segment.value}
            block={segment.block}
          />
        );
      })}
    </div>
  );
};

export default MathText;
