/**
 * ⌘K command palette for the Scenes editor (#986).
 *
 * Jump to any scene or shot, switch inspector facets, set the Look/Motion
 * model at the current scope, or clear the selection — all filterable from
 * one input. Deliberately dependency-free: a Dialog + filtered list.
 */

import { type FacetValue } from '@/components/scenes/scope-inspector';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import {
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  selectScene,
  selectShot,
  type SceneSelection,
} from '@/lib/scenes/selection';
import type { SceneRow } from '@/lib/db/schema';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { cn } from '@/lib/utils';
import { typedEntries } from '@/lib/utils/typed-object';
import { useEffect, useMemo, useRef, useState } from 'react';

type PaletteCommand = {
  id: string;
  group: string;
  label: string;
  keywords: string;
  run: () => void;
};

type SceneCommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shots?: ShotWithImage[];
  scenes?: SceneRow[];
  onSelectionChange: (next: SceneSelection) => void;
  onFacetChange: (facet: FacetValue) => void;
  onSetImageModel: (model: TextToImageModel) => void;
  onSetVideoModel: (model: ImageToVideoModel) => void;
};

const FACETS: Array<{ value: FacetValue; label: string }> = [
  { value: 'cast', label: 'Show Cast' },
  { value: 'locations', label: 'Show Locations' },
  { value: 'elements', label: 'Show Elements' },
  { value: 'music', label: 'Show Music' },
  { value: 'script', label: 'Show Script' },
];

export const SceneCommandPalette: React.FC<SceneCommandPaletteProps> = ({
  open,
  onOpenChange,
  shots,
  scenes,
  onSelectionChange,
  onFacetChange,
  onSetImageModel,
  onSetVideoModel,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const commands = useMemo<PaletteCommand[]>(() => {
    const result: PaletteCommand[] = [
      {
        id: 'scope-sequence',
        group: 'Scope',
        label: 'Whole sequence',
        keywords: 'sequence clear all everything theatre play',
        run: () => onSelectionChange({ sceneIds: [] }),
      },
    ];
    for (const scene of scenes ?? []) {
      result.push({
        id: `scene-${scene.id}`,
        group: 'Scenes',
        label: scene.title ?? `Scene ${scene.orderIndex + 1}`,
        keywords: `scene ${scene.orderIndex + 1} ${scene.location ?? ''}`,
        run: () => onSelectionChange(selectScene(scene.id)),
      });
    }
    for (const shot of shots ?? []) {
      const title =
        shot.metadata?.metadata?.title ?? `Shot ${shot.orderIndex + 1}`;
      result.push({
        id: `shot-${shot.id}`,
        group: 'Shots',
        label: title,
        keywords: `shot ${shot.orderIndex + 1} ${
          shot.metadata?.metadata?.location ?? ''
        }`,
        run: () => onSelectionChange(selectShot(shot.id)),
      });
    }
    for (const facet of FACETS) {
      result.push({
        id: `facet-${facet.value}`,
        group: 'Facets',
        label: facet.label,
        keywords: `facet inspector ${facet.value}`,
        run: () => onFacetChange(facet.value),
      });
    }
    for (const [key, config] of typedEntries(IMAGE_MODELS)) {
      result.push({
        id: `image-model-${key}`,
        group: 'Look model',
        label: `Set Look: ${config.name}`,
        keywords: `image look model ${config.name}`,
        run: () => onSetImageModel(key),
      });
    }
    for (const [key, config] of typedEntries(IMAGE_TO_VIDEO_MODELS)) {
      result.push({
        id: `video-model-${key}`,
        group: 'Motion model',
        label: `Set Motion: ${config.name}`,
        keywords: `video motion model ${config.name}`,
        run: () => onSetVideoModel(key),
      });
    }
    return result;
  }, [
    scenes,
    shots,
    onSelectionChange,
    onFacetChange,
    onSetImageModel,
    onSetVideoModel,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    const terms = q.split(/\s+/);
    return commands.filter((command) => {
      const haystack = `${command.label} ${command.keywords}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [commands, query]);

  // Reset the cursor whenever the palette opens or the result set changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const runCommand = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onOpenChange(false);
    command.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runCommand(filtered[activeIndex]);
    }
  };

  // Keep the active row visible while arrowing through results.
  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  let lastGroup = '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[20%] max-w-lg translate-y-0 gap-0 p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="border-b p-2">
          <Input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the palette exists to receive immediate typing
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a scene or shot, switch facets, set models…"
            aria-label="Search commands"
            className="border-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div
          ref={listRef}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA listbox pattern; native <select> can't render grouped commands
          role="listbox"
          aria-label="Commands"
          className="max-h-80 overflow-y-auto p-2"
        >
          {filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              No matches.
            </p>
          )}
          {filtered.map((command, index) => {
            const showGroup = command.group !== lastGroup;
            lastGroup = command.group;
            return (
              <div key={command.id}>
                {showGroup && (
                  <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {command.group}
                  </div>
                )}
                <button
                  type="button"
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA listbox option; see listbox note above
                  role="option"
                  aria-selected={index === activeIndex}
                  data-active={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runCommand(command)}
                  className={cn(
                    'w-full rounded-md px-2 py-1.5 text-left text-sm',
                    index === activeIndex
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-muted'
                  )}
                >
                  {command.label}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
          <span>
            <Kbd>↑↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> run
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
};
