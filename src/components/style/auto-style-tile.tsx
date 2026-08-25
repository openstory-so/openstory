import { cn } from '@/lib/utils';
import { ScrollText } from 'lucide-react';

type AutoStyleTileProps = {
  selected: boolean;
  disabled?: boolean;
  tabIndex: number;
  onSelect: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
};

/**
 * The "Match script" slot in the composer strip (#1213): instead of a library
 * style, the storyboard run derives a style from the script itself. Laid out
 * like a StyleInlineTile (full-bleed still + bottom name strip) so it
 * reads as a peer style; the ScrollText badge + label are the tell (#1279).
 */
export function AutoStyleTile({
  selected,
  disabled = false,
  tabIndex,
  onSelect,
  onKeyDown,
}: AutoStyleTileProps) {
  return (
    <button
      type="button"
      data-style-tile
      onClick={onSelect}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'group relative aspect-square overflow-hidden rounded-lg border-2 whitespace-normal',
        'transition-all duration-200 hover:scale-105 hover:shadow-lg',
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'border-primary shadow-md scale-105'
          : 'border-transparent hover:border-primary/50'
      )}
      aria-label="Match script: derive a style from the script"
      title="Derive a style from the script. It stays with this sequence until you add it to your library."
    >
      <img
        src="/match-script.jpg"
        width={130}
        height={130}
        alt=""
        className="h-full w-full object-cover"
        decoding="async"
      />
      <span
        aria-hidden
        className="absolute left-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"
      >
        <ScrollText className="size-3" />
      </span>
      <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 via-black/60 to-transparent p-2">
        <p className="line-clamp-2 whitespace-normal text-center text-xs font-medium text-white">
          Match script
        </p>
      </div>
      {selected && (
        <div className="pointer-events-none absolute inset-0 bg-primary/10" />
      )}
    </button>
  );
}
