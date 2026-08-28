import { createHighlighter } from '@tanstack/highlight/core';
import { json } from '@tanstack/highlight/languages/json';
import { plaintext } from '@tanstack/highlight/languages/plaintext';
import { shell } from '@tanstack/highlight/languages/shell';
import { ts } from '@tanstack/highlight/languages/ts';
import { createTanStackMarkdownHighlighter } from '@tanstack/highlight/markdown';
import { createThemeCss } from '@tanstack/highlight/theme';
import { githubDarkTheme } from '@tanstack/highlight/themes/github-dark';
import type { CodeHighlighter } from '@tanstack/markdown';

/**
 * Languages that appear as fences in the published docs corpus
 * (`content-collections.ts` include). `bash`/`sh`/`zsh` alias to `shell`;
 * `typescript` aliases to `ts`. Mermaid fences are intercepted before
 * highlight. Unknown langs fall back to escaped plaintext.
 *
 * Bundle: highlight core + these four defs is ~6 KB gzip vs the previous
 * shiki + unified/rehype pipeline (hundreds of KB, plus a Workerd-hostile
 * WASM engine we had already replaced with the JS regex engine).
 */
const docsHighlighter = createHighlighter({
  languages: [plaintext, shell, ts, json],
});

export const highlightDocsCode: CodeHighlighter =
  createTanStackMarkdownHighlighter(docsHighlighter);

export const docsHighlightCss = `${createThemeCss({
  light: githubDarkTheme,
  lightSelector: '.markdown-renderer',
  codeBlockSelector: '.markdown-renderer pre.tm-code',
  lineNumbersSelector: '.markdown-renderer .tm-code--line-numbers',
})}

.markdown-renderer .heading-anchor {
  margin-inline-start: 0.4em;
  text-decoration: none;
  opacity: 0.45;
}

.markdown-renderer .heading-anchor:hover,
.markdown-renderer .heading-anchor:focus-visible {
  opacity: 1;
}

.markdown-renderer .th-line--highlighted {
  background: color-mix(in srgb, var(--th-token) 10%, transparent);
}
`;
