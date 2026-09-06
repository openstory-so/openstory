import {
  isInternalDocsHref,
  type MarkdownDocument,
} from '@/components/docs/markdown-ast';
import { cn } from '@/shared/utils';
import {
  Markdown,
  type MarkdownComponentProps,
  type MarkdownComponents,
} from '@tanstack/markdown/react';
import { Link } from '@tanstack/react-router';
import { MermaidDiagram } from './mermaid-diagram';
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

const docsHighlightCss = `${createThemeCss({
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

type MarkdownContentProps = {
  document: MarkdownDocument;
  className?: string;
};

function DocsLink({ href, children, ...props }: MarkdownComponentProps<'a'>) {
  if (href && isInternalDocsHref(href)) {
    return (
      <Link to={href} {...props}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}

function DocsImage({ alt = '', ...props }: MarkdownComponentProps<'img'>) {
  return <img {...props} alt={alt} loading="lazy" />;
}

function DocsMermaid({ source }: { source?: string }) {
  return <MermaidDiagram source={source ?? ''} />;
}

const components = {
  a: DocsLink,
  img: DocsImage,
  'mermaid-diagram': DocsMermaid,
} satisfies MarkdownComponents;

export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  document,
  className,
}) => {
  return (
    <div
      className={cn(
        'prose dark:prose-invert markdown-renderer max-w-none',
        className
      )}
    >
      <style>{docsHighlightCss}</style>
      <Markdown
        highlighter={highlightDocsCode}
        headingAnchors={{ content: '#', className: 'heading-anchor' }}
        components={components}
      >
        {document}
      </Markdown>
    </div>
  );
};
