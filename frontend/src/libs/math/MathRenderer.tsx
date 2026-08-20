import * as React from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { cn } from '../utils/cn';
import { logger } from '../utils/logger';
import { katexStrict } from './katexStrict';

const mathLogger = logger.createContextLogger('MathRenderer');

interface MathRendererProps {
  expression: string;
  block?: boolean;
  className?: string;
}

export const MathRenderer: React.FC<MathRendererProps> = ({ expression, block = false, className }) => {
  const containerRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (containerRef.current) {
      try {
        katex.render(expression, containerRef.current, {
          displayMode: block,
          throwOnError: false,
          output: 'mathml', // Accessibility
          strict: katexStrict,
        });
      } catch (error) {
        mathLogger.error('KaTeX rendering error', {
          expression: expression.substring(0, 50),
          error
        });
        containerRef.current.innerText = expression;
      }
    }
  }, [expression, block]);

  return <span ref={containerRef} className={cn('math-content', className)} />;
};
