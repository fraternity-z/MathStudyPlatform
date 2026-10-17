import React from 'react';
import { MathRenderer } from '@/libs/math/MathRenderer';
import { MathText } from '@/libs/math/MathText';
import { cn } from '@/libs/utils/cn';

const inlineOrBlockMathRegex = /\$\$?[\s\S]+?\$\$?/;
const latexHintRegex = /\\[a-zA-Z]+|[_^]/;

const normalizeExerciseMathDelimiters = (value: string) =>
  value
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_match, expression: string) => `$$${expression}$$`)
    .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_match, expression: string) => `$${expression}$`);

interface ExerciseMathContentProps {
  value: string;
  className?: string;
  block?: boolean;
}

export const ExerciseMathContent: React.FC<ExerciseMathContentProps> = ({
  value,
  className,
  block = false,
}) => {
  if (!value) return null;

  const normalizedValue = normalizeExerciseMathDelimiters(value);
  let content: React.ReactNode = normalizedValue;

  if (inlineOrBlockMathRegex.test(normalizedValue)) {
    content = <MathText>{normalizedValue}</MathText>;
  } else if (latexHintRegex.test(normalizedValue)) {
    content = (
      <MathRenderer
        expression={normalizedValue}
        block={block}
        className="inline-block"
      />
    );
  }

  return (
    <div className={cn('min-w-0 max-w-full overflow-x-auto [overflow-wrap:anywhere]', className)}>
      <div className="flow-root py-2">{content}</div>
    </div>
  );
};
