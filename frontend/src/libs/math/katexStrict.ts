import type { StrictFunction } from 'katex';

const RENDERABLE_TYPOGRAPHIC_QUOTES = new Set([
  '\u2018',
  '\u2019',
  '\u201c',
  '\u201d',
]);

/**
 * Chinese and other Unicode prose is renderable by KaTeX, but is not
 * LaTeX-compatible when it appears directly in math mode. Keep other strict
 * diagnostics visible while avoiding a console warning for this supported UI
 * input.
 */
export const katexStrict: StrictFunction = (errorCode, _errorMessage, token) => {
  if (errorCode === 'unicodeTextInMathMode') return 'ignore';

  if (
    errorCode === 'unknownSymbol'
    && RENDERABLE_TYPOGRAPHIC_QUOTES.has(token.text)
  ) {
    return 'ignore';
  }

  return 'warn';
};
