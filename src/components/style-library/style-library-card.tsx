import { StyleHoverPreview } from '@/components/style/style-hover-preview';
import { styleCategoryLabel } from '@/shared/style/style-assets';
import type { Style } from '@/types/database';
import type { FC } from 'react';
import { useCallback } from 'react';

type StyleLibraryCardProps = {
  style: Style;
  onSelect: (style: Style) => void;
};

/**
 * One style tile on the top-level styles page: a hover-to-play preview plus the
 * style name and category. Activating it opens the style detail dialog. Built on
 * a real <button> so keyboard activation and focus semantics come for free.
 */
export const StyleLibraryCard: FC<StyleLibraryCardProps> = ({
  style,
  onSelect,
}) => {
  const handleSelect = useCallback(() => onSelect(style), [onSelect, style]);

  return (
    <button
      type="button"
      onClick={handleSelect}
      aria-label={`${style.name} style details`}
      data-testid={`style-library-card-${style.id}`}
      className="group block w-full overflow-hidden rounded-xl border bg-card text-left shadow-sm transition-all hover:scale-[1.02] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <StyleHoverPreview style={style} className="rounded-t-xl" />
      <div className="flex flex-col gap-0.5 p-3">
        <h3 className="truncate text-sm font-semibold" title={style.name}>
          {style.name}
        </h3>
        <span className="text-xs text-muted-foreground">
          {styleCategoryLabel(style.category)}
        </span>
      </div>
    </button>
  );
};
