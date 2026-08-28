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
 */
export const SheetVersionStrip: React.FC<{
  versions: SheetVersionThumb[];
  selectingId?: string | null;
  onSelect: (versionId: string) => void;
  label: string;
}> = ({ versions, selectingId, onSelect, label }) => {
  if (versions.length < 2) return null;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <ul className="flex gap-2 overflow-x-auto p-1">
        {versions.map((version, index) => {
          const busy = selectingId === version.id;
          return (
            <li key={version.id} className="shrink-0 p-0.5">
              <button
                type="button"
                onClick={() => {
                  if (!version.selected && version.url) onSelect(version.id);
                }}
                disabled={busy || !version.url}
                aria-current={version.selected ? 'true' : undefined}
                aria-label={`Version ${index + 1}${version.selected ? ', current' : ''}`}
                className={cn(
                  'relative block h-16 w-24 rounded-md border bg-muted',
                  version.selected
                    ? 'border-primary ring-2 ring-primary'
                    : 'border-transparent hover:border-border'
                )}
              >
                <span className="absolute inset-0 overflow-hidden rounded-[5px]">
                  {version.url ? (
                    <AppImage
                      src={version.url}
                      alt=""
                      width={96}
                      height={64}
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                  {busy ? (
                    <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
