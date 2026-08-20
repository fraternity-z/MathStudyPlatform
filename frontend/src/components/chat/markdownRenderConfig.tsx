/**
 * Markdown 渲染配置（模块级常量）
 *
 * 说明：该文件只导出常量/函数，避免与组件文件混用，
 * 以满足 eslint 的 react-refresh/only-export-components 规则。
 */

import type React from 'react';
import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { normalizeSafeExternalUrl } from '@/libs/utils/safeUrl';
import { katexStrict } from '@/libs/math/katexStrict';

export const REMARK_PLUGINS = [remarkGfm, remarkMath];
export const REHYPE_PLUGINS: PluggableList = [[rehypeKatex, { strict: katexStrict }]];

/**
 * 归一化 AI 输出，让 markdown / KaTeX 可正常渲染。
 *
 * 背景：部分模型会输出 MathJax/LaTeX 分隔符 `\\(...\\)`、`\\[...\\]`，
 * 以及把 `**` 等 markdown 标记转义为 `\\*\\*`。
 *
 * 但 `react-markdown + remark-math` 主要识别 `$...$` / `$$...$$`，
 * 并且 CommonMark 会把 `\\(`、`\\[` 当作“转义字符”，从而导致内容原样显示。
 */
export function normalizeAssistantMarkdown(content: string): string {
  if (!content) return content;

  let out = content;

  // 统一行结束符，便于后续按行处理（react-markdown 可正常解析 \n）。
  out = out.replace(/\r\n/g, '\n');

  // Display math: \[ ... \] -> $$ ... $$ (确保 $$ 在独立行，remark-math 识别更稳定)
  out = out.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, expr) => `$$\n${expr}\n$$`);

  // Inline math: \( ... \) -> $ ... $
  out = out.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, expr) => `$${expr}$`);

  // Unescape markdown emphasis markers that models sometimes escape.
  // Keep this intentionally minimal to avoid touching normal LaTeX commands like \frac, \Delta, ...
  out = out.replace(/\\\*/g, '*');

  // 兼容部分模型/智能体输出“裸 LaTeX”（没有 $...$ / $$...$$ 包裹）的情况。
  // 典型场景：解题步骤中单独一行以 `\frac` / `\begin{...}` / `\left` 开头的公式。
  // 这里做轻量的行级包裹，并跳过 code fence 与已在 $$...$$ 内的内容，避免误伤代码块。
  out = wrapBareLatex(out);

  return out;
}

function wrapBareLatex(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];

  let fence: '```' | '~~~' | null = null;
  let inMathBlock = false;
  let env: { name: string; buffer: string[] } | null = null;

  const splitListPrefix = (line: string): { prefix: string; body: string } => {
    const m = line.match(/^(\s*(?:[-*+]\s+|\d+[.、)]\s+))(.*)$/);
    if (!m) return { prefix: '', body: line };
    return { prefix: m[1], body: m[2] };
  };

  const beginEnvName = (latexLine: string): string | null => {
    const m = latexLine.match(/^\\begin\{([^}]+)\}/);
    return m ? m[1] : null;
  };

  const flushEnv = () => {
    if (!env) return;
    out.push('$$', env.buffer.join('\n'), '$$');
    env = null;
  };

  const processOneLine = (line: string) => {
    const trimmed = line.trim();

    // code fence toggle（只要遇到 fence 就原样输出并切换状态）
    const fenceToken =
      trimmed.startsWith('```') ? '```' : trimmed.startsWith('~~~') ? '~~~' : null;
    if (fenceToken) {
      if (fence === null) fence = fenceToken;
      else if (fence === fenceToken) fence = null;
      out.push(line);
      return;
    }
    if (fence) {
      out.push(line);
      return;
    }

    // 收集多行环境（例如 \begin{cases} ... \end{cases}）
    if (env) {
      env.buffer.push(line);
      if (line.includes(`\\end{${env.name}}`)) flushEnv();
      return;
    }

    // 处理 $$ 分隔符：仅当其独立成行时才切换 math block 状态，避免把“正文里的 $$”误判为分隔符。
    if (trimmed === '$$') {
      inMathBlock = !inMathBlock;
      out.push('$$');
      return;
    }
    if (inMathBlock) {
      out.push(line);
      return;
    }

    const { prefix, body } = splitListPrefix(line);
    const bodyTrimmed = body.trim();

    // 不处理已经包含 $ 的行，避免二次包裹
    if (!bodyTrimmed || bodyTrimmed.includes('$')) {
      out.push(line);
      return;
    }

    // 多行环境起始：仅在“行主体以 \begin{...} 开头”时启用，避免误包裹含中文解释的混合行
    if (!prefix && /^\\begin\{/.test(bodyTrimmed)) {
      const name = beginEnvName(bodyTrimmed);
      if (name) {
        env = { name, buffer: [bodyTrimmed] };
        // 同行闭合：立即 flush
        if (bodyTrimmed.includes(`\\end{${name}}`)) flushEnv();
        return;
      }
    }

    // 裸 LaTeX：行主体以 "\" 开头（可带有列表前缀）
    if (/^\\[A-Za-z]/.test(bodyTrimmed)) {
      if (prefix) {
        // 列表项中用行内公式，避免 block math 在列表里排版异常
        out.push(`${prefix}$${bodyTrimmed}$`);
      } else {
        out.push('$$', bodyTrimmed, '$$');
      }
      return;
    }

    out.push(line);
  };

  for (const line of lines) {
    processOneLine(line);
  }

  // 兜底：环境未闭合时也包裹输出，避免整段文本被识别为普通段落
  if (env) flushEnv();

  return out.join('\n');
}

export const MARKDOWN_COMPONENTS: Record<string, React.FC<Record<string, unknown>>> = {
  // 标题
  h1: ({ children }) => (
    <h1 className="text-xl font-bold mt-4 mb-2 first:mt-0">{children as React.ReactNode}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-lg font-bold mt-3 mb-2 first:mt-0">{children as React.ReactNode}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-semibold mt-2 mb-1 first:mt-0">{children as React.ReactNode}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children as React.ReactNode}</h4>
  ),
  // 段落
  p: ({ children }) => (
    <p className="my-2 first:mt-0 last:mb-0 leading-relaxed">{children as React.ReactNode}</p>
  ),

  // 列表
  ul: ({ children }) => (
    <ul className="my-2 ml-4 list-disc space-y-1">{children as React.ReactNode}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 ml-4 list-decimal space-y-1">{children as React.ReactNode}</ol>
  ),
  li: ({ children }) => (
    <li className="leading-relaxed">{children as React.ReactNode}</li>
  ),

  // 代码
  code: ({ className, children, ...props }) => (
    <code
      className={`rounded bg-surface-100 px-1.5 py-0.5 font-mono text-sm text-primary-600 dark:bg-surface-700 dark:text-primary-400 ${className ?? ''}`}
      {...props}
    >
      {children as React.ReactNode}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 max-w-full overflow-x-auto whitespace-pre rounded-md border border-surface-200 bg-surface-50 p-4 font-mono text-sm leading-5 text-surface-800 dark:border-surface-700 dark:bg-surface-800/70 dark:text-surface-100 [&>code]:block [&>code]:min-w-max [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
      {children as React.ReactNode}
    </pre>
  ),

  // 引用
  blockquote: ({ children }) => (
    <blockquote className="my-2 pl-4 border-l-4 border-primary-300 dark:border-primary-600 text-surface-600 dark:text-surface-400 italic">
      {children as React.ReactNode}
    </blockquote>
  ),

  // 表格
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse border border-surface-200 dark:border-surface-600">
        {children as React.ReactNode}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-surface-100 dark:bg-surface-700">{children as React.ReactNode}</thead>
  ),
  th: ({ children }) => (
    <th className="px-3 py-2 border border-surface-200 dark:border-surface-600 text-left font-semibold">
      {children as React.ReactNode}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2 border border-surface-200 dark:border-surface-600">
      {children as React.ReactNode}
    </td>
  ),

  // 分隔线
  hr: () => (
    <hr className="my-4 border-surface-200 dark:border-surface-600" />
  ),

  // 链接
  a: ({ href, children }) => {
    const safeHref = normalizeSafeExternalUrl(href as string | undefined);
    if (!safeHref) {
      return <span>{children as React.ReactNode}</span>;
    }
    return (
      <a
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-600 dark:text-primary-400 hover:underline"
      >
        {children as React.ReactNode}
      </a>
    );
  },

  // 强调
  strong: ({ children }) => (
    <strong className="font-semibold">{children as React.ReactNode}</strong>
  ),
  em: ({ children }) => (
    <em className="italic">{children as React.ReactNode}</em>
  ),
};
