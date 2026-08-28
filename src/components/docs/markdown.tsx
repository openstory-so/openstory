import { docsHighlightCss, highlightDocsCode } from '@/lib/docs/highlight';
import { isInternalDocsHref, type MarkdownDocument } from '@/lib/docs/markdown';
import { cn } from '@/lib/utils';
import {
  Markdown,
  type MarkdownComponentProps,
  type MarkdownComponents,
} from '@tanstack/markdown/react';
import { Link } from '@tanstack/react-router';
import { MermaidDiagram } from './mermaid-diagram';

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
