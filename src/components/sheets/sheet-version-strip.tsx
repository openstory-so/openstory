import { AppImage } from '@/components/ui/app-image';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

export type SheetVersionThumb = {
  id: string;
  url: string | null;
  selected: boolean;
};

/**
 * Contact-sheet strip under a character/location hero. Hidden when there is
 * nothing to switch between. Selecting a thumb repoints the live sheet.
 *
 * Callers pass versions oldest-first so the row reads left-to-right as
 * v1, v2, … — the same ordinal as shot still / video re-roll chips.
 */
export const SheetVersionStrip: React.FC<{
  versions: SheetVersionThumb[];
  selectingId?: string | null;
  onSelect: (versionId: string) => void;
  label: string;
}> = ({ versions, selectingId, onSelect, label }) => {
  if (versions.length < 2) return null;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <ul className="flex flex-wrap gap-1.5">
        {versions.map((version, index) => {
          const busy = selectingId === version.id;
          const ordinal = index + 1;
          return (
            <li key={version.id} className="shrink-0">
              <button
                type="button"
                onClick={() => {
                  if (!version.selected && version.url) onSelect(version.id);
                }}
                disabled={busy || !version.url}
                aria-current={version.selected ? 'true' : undefined}
                aria-label={`Version ${ordinal}${version.selected ? ', current' : ''}`}
                aria-pressed={version.selected}
                className={cn(
                  'relative block h-16 w-24 overflow-hidden rounded-md border bg-muted',
                  version.selected
                    ? 'border-primary'
                    : 'border-transparent hover:border-border'
                )}
              >
                {version.url ? (
                  <AppImage
                    src={version.url}
                    alt=""
                    width={96}
                    height={64}
                    className="h-full w-full object-cover"
                  />
                ) : null}
                <span className="absolute bottom-0.5 left-0.5 rounded bg-background/80 px-1 text-[10px] font-medium leading-4 text-muted-foreground">
                  v{ordinal}
                </span>
                {busy ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
