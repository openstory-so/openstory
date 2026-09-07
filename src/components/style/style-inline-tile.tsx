import type { Style } from '@/lib/db/schema/libraries';
import { cn } from '@/shared/utils';
import { Info, Sparkles } from 'lucide-react';
import { StyleHoverPreview } from './style-hover-preview';

type StyleInlineTileProps = {
  style: Style;
  selected: boolean;
  disabled?: boolean;
  reasoning?: string;
  recommended?: boolean;
  /** First-paint tiles: eager + high fetch priority so they beat lazy ones. */
  priority?: boolean;
  tabIndex: number;
  /** Single click opens the style detail dialog (#1526). */
  onShowDetails: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
};

export function StyleInlineTile({
  style,
  selected,
  disabled = false,
  reasoning,
  recommended = false,
  priority = false,
  tabIndex,
  onShowDetails,
  onKeyDown,
}: StyleInlineTileProps) {
  return (
    <button
      type="button"
      data-style-tile
      onClick={onShowDetails}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        // whitespace-normal: UA button styles are nowrap (inherited), which
        // defeats line-clamp-2 on the name and truncates mid-word.
        'group relative aspect-square overflow-hidden rounded-lg border-2 whitespace-normal',
        'transition-all duration-200 hover:scale-105 hover:shadow-lg',
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'border-primary shadow-md scale-105'
          : 'border-transparent hover:border-primary/50'
      )}
      aria-label={`View ${style.name} details`}
      title={reasoning}
    >
      <StyleHoverPreview
        style={style}
        priority={priority}
        width={130}
        height={130}
        sizes="65px"
        videoWidth={200}
        className="h-full w-full"
      />
      {recommended && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"
        >
          <Sparkles className="size-3" />
        </span>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 via-black/60 to-transparent p-2">
        <p className="line-clamp-2 whitespace-normal text-center text-xs font-medium text-white">
          {style.name}
        </p>
      </div>
      {selected && (
        <div className="pointer-events-none absolute inset-0 bg-primary/10" />
      )}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute right-1.5 top-1.5 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]',
          selected
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
        )}
      >
        <Info className="size-4" />
      </span>
    </button>
  );
}
