/**
 * Canvas / Script switch for the centre column (#1037).
 *
 * Both views share the spine, the inspector and the selection — this only
 * changes what the middle shows, so it reads as two views of one object rather
 * than two pages. That's the whole point: the script used to be a separate
 * route that took you out of Scenes.
 */

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { CanvasView } from '@/lib/scenes/scene-selection';
import { FileText, Film } from 'lucide-react';

type CanvasViewToggleProps = {
  view: CanvasView;
  onViewChange: (view: CanvasView) => void;
  /** Progressive reveal (#1091): the canvas has nothing to show until the
   *  first shot preview lands, so the item stays disabled during the split. */
  canvasDisabled?: boolean;
  /** View-scoped action in the right column. The 1fr / auto / 1fr grid keeps
   *  the toggle centred without overlapping this control on a narrow screen. */
  trailing?: React.ReactNode;
};

export const CanvasViewToggle: React.FC<CanvasViewToggleProps> = ({
  view,
  onViewChange,
  canvasDisabled,
  trailing,
}) => (
  <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-2 pt-4 md:px-4">
    <div />
    <ToggleGroup
      type="single"
      value={view}
      // A toggle group fires `''` when the active item is re-clicked; ignore
      // that so the centre column can never end up showing nothing.
      onValueChange={(next) => {
        if (next === 'canvas' || next === 'script') onViewChange(next);
      }}
      variant="outline"
      size="sm"
      spacing={0}
    >
      <ToggleGroupItem
        value="canvas"
        aria-label="Show the canvas"
        disabled={canvasDisabled}
      >
        <Film className="mr-1.5 h-3.5 w-3.5" />
        Canvas
      </ToggleGroupItem>
      <ToggleGroupItem value="script" aria-label="Show the script">
        <FileText className="mr-1.5 h-3.5 w-3.5" />
        Script
      </ToggleGroupItem>
    </ToggleGroup>
    <div className="flex min-w-0 justify-end">{trailing}</div>
  </div>
);
