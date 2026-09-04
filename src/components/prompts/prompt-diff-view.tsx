import { computeWordDiff, type WordDiffSegment } from '@/shared/diff/word-diff';
import { cn } from '@/shared/utils';
import { useMemo } from 'react';

type PromptDiffViewProps = {
  before: string;
  after: string;
  className?: string;
};

function assertNever(x: never): never {
  throw new Error(`Unexpected diff segment kind: ${JSON.stringify(x)}`);
}

const renderSegment = (seg: WordDiffSegment, i: number) => {
  switch (seg.kind) {
    case 'eq':
      // eslint-disable-next-line react/no-array-index-key -- diff segments have no stable id
      return <span key={i}>{seg.text}</span>;
    case 'add':
      return (
        <ins
          // eslint-disable-next-line react/no-array-index-key -- diff segments have no stable id
          key={i}
          aria-label="added"
          className="rounded bg-emerald-100 text-emerald-900 no-underline dark:bg-emerald-950 dark:text-emerald-100"
        >
          {seg.text}
        </ins>
      );
    case 'del':
      return (
        <del
          // eslint-disable-next-line react/no-array-index-key -- diff segments have no stable id
          key={i}
          aria-label="removed"
          className="rounded bg-rose-100 text-rose-900 line-through dark:bg-rose-950 dark:text-rose-100"
        >
          {seg.text}
        </del>
      );
    default:
      return assertNever(seg.kind);
  }
};

export const PromptDiffView: React.FC<PromptDiffViewProps> = ({
  before,
  after,
  className,
}) => {
  const segments = useMemo(
    () => computeWordDiff(before, after),
    [before, after]
  );

  return (
    <p
      data-slot="prompt-diff"
      className={cn(
        'whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground',
        className
      )}
    >
      {segments.map(renderSegment)}
    </p>
  );
};
