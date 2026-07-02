/**
 * Elements facet (#986)
 * Selection-scoped element list: `elementTags: null` shows every uploaded
 * element (nothing selected); a tag set shows the union referenced across the
 * selected scene(s)/shot by UPPERCASE token.
 */

import { Skeleton } from '@/components/ui/skeleton';
import { useSequenceElements } from '@/hooks/use-sequence-elements';
import type { SequenceElement } from '@/lib/db/schema';
import { matchElementsToScene } from '@/lib/workflows/scene-matching';
import { Link } from '@tanstack/react-router';
import { ImagePlus, Loader2 } from 'lucide-react';

type SceneElementsTabProps = {
  sequenceId: string;
  /** Selection-derived element tokens; `null` = no filter (whole sequence). */
  elementTags: string[] | null;
  /** Covered shots' script extracts — fallback token matching in prose. */
  scriptText?: string;
};

export const SceneElementsTab: React.FC<SceneElementsTabProps> = ({
  sequenceId,
  elementTags,
  scriptText = '',
}) => {
  const { data: elements = [], isLoading } = useSequenceElements(sequenceId);

  let sceneElements: SequenceElement[];
  if (elementTags === null) {
    sceneElements = elements;
  } else {
    const matchedIds = new Set(
      matchElementsToScene(elements, elementTags, scriptText).map((el) => el.id)
    );
    sceneElements = elements.filter((el) => matchedIds.has(el.id));
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="aspect-square rounded-lg" />
        ))}
      </div>
    );
  }

  if (sceneElements.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="rounded-full bg-muted p-4 mb-4">
          <ImagePlus className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <p className="text-sm text-muted-foreground">
          {elementTags === null
            ? 'No elements in this sequence'
            : 'No elements in this selection'}
        </p>
        {elementTags !== null && elementTags.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground/70">
            Looking for: {elementTags.join(', ')}
          </p>
        )}
        <Link
          to="/sequences/$id/elements"
          params={{ id: sequenceId }}
          className="mt-4 text-xs text-primary hover:underline"
        >
          Manage elements
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        <span>Elements</span>
        <span className="text-muted-foreground/50">·</span>
        <span>
          {sceneElements.length} reference
          {sceneElements.length > 1 ? 's' : ''}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {sceneElements.map((el) => (
          <Link
            key={el.id}
            to="/sequences/$id/elements"
            params={{ id: sequenceId }}
            className="group relative block overflow-hidden rounded-lg bg-card"
          >
            <div className="relative aspect-square overflow-hidden bg-muted">
              <img
                src={el.imageUrl}
                alt={el.token}
                className="h-full w-full object-contain transition-transform duration-500 group-hover:scale-105"
              />
              <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 via-black/20 to-transparent p-3">
                <span className="font-mono text-xs font-semibold tracking-wider text-white">
                  {el.token}
                </span>
              </div>
            </div>
            {el.description && (
              <div className="border-t border-border/50 p-3">
                <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {el.description}
                </p>
              </div>
            )}
            {el.visionStatus === 'pending' ||
            el.visionStatus === 'analyzing' ? (
              <div className="absolute top-2 right-2 flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur-sm">
                <Loader2 className="size-2.5 animate-spin" />
                Analyzing
              </div>
            ) : null}
          </Link>
        ))}
      </div>
    </div>
  );
};
