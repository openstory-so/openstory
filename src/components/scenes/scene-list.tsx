import { MusicModelSelector } from '@/components/model/music-model-selector';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useCreateScene, useReorderScenes } from '@/hooks/use-scene-structure';
import { DEFAULT_MUSIC_MODEL, type AudioModel } from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { SceneWithScript } from '@/hooks/use-scenes';
import type { ShotVariant } from '@/lib/db/schema';
import { errorMessage } from '@/lib/errors';
import type { SceneSelection } from '@/lib/scenes/scene-selection';
import type { SequenceSegment } from '@/lib/scenes/scene-segments';
import type { ShotView } from '@/lib/shots/shot-view';
import { cn } from '@/lib/utils';
import { Loader2, Plus, Video } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SceneGroup } from './scene-group';
import { SceneListItem } from './scene-list-item';

export type BatchGenerateMotionArgs = {
  includeMusic: boolean;
  musicModel: AudioModel;
  /** Lets the user suppress model-emitted audio (sfx/dialogue/ambient) for the
   *  batch. The flag is honored only by models that produce audio — non-audio
   *  models ignore it downstream during motion-prompt assembly. */
  generateAudio: boolean;
};

type SceneListProps = {
  sequenceId: string;
  shots?: ShotView[] | undefined;
  scenes?: SceneWithScript[] | undefined;
  /** Render segments (#986) — bracket the shots sharing one video per scene. */
  segments?: SequenceSegment[] | undefined;
  /** Shots/scenes query failure — shown instead of the list (never skeletons). */
  loadError?: Error | null;
  /** Segments query failure — brackets/stale badges are missing, say so. */
  segmentsError?: Error | null;
  selection: SceneSelection;
  aspectRatio: AspectRatio;
  onSelectScene: (sceneId: string, additive: boolean) => void;
  onSelectShot: (shotId: string) => void;
  onClearSelection: () => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  onBatchGenerateMotion?: (args: BatchGenerateMotionArgs) => Promise<void>;
  musicPromptsReady: boolean;
  hideBatchButton?: boolean;
  divergentVariants?: ShotVariant[];
  onCompareDivergent?: (variant: ShotVariant) => void;
  initialMusicModel?: AudioModel;
  modelMissingShotIds?: Set<string>;
  modelMissingLabel?: string | null;
  /** Shots with stale prompts/image in the in-focus scene (#1077) — amber dots. */
  staleShotIds?: Set<string>;
};

const SceneListComponent: React.FC<SceneListProps> = ({
  sequenceId,
  shots,
  scenes,
  segments,
  loadError,
  segmentsError,
  selection,
  aspectRatio,
  onSelectScene,
  onSelectShot,
  onClearSelection,
  regeneratingImages,
  regeneratingMotion,
  onBatchGenerateMotion,
  musicPromptsReady,
  hideBatchButton = false,
  divergentVariants,
  onCompareDivergent,
  initialMusicModel,
  modelMissingShotIds,
  modelMissingLabel,
  staleShotIds,
}) => {
  const divergentByShotId = useMemo(() => {
    const map = new Map<string, ShotVariant>();
    for (const v of divergentVariants ?? []) {
      // Image variant is what surfaces on the card. Other variant types
      // live on their respective tabs per the spec's surfacing matrix.
      if (v.variantType !== 'image') continue;
      if (!map.has(v.shotId)) map.set(v.shotId, v);
    }
    return map;
  }, [divergentVariants]);

  const createScene = useCreateScene(sequenceId);
  const reorderScenes = useReorderScenes(sequenceId);

  // Scene order lives in the scenes array; a ref keeps a stale closure in a
  // memoized child operating on the CURRENT order (same pattern as shots).
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const handleMoveScene = useCallback(
    (sceneId: SceneWithScript['id'], direction: 'up' | 'down') => {
      const ids = (scenesRef.current ?? []).map((s) => s.id);
      const index = ids.indexOf(sceneId);
      const swapWith = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || swapWith < 0 || swapWith >= ids.length) return;
      const next = [...ids];
      const a = next[index];
      const b = next[swapWith];
      if (a === undefined || b === undefined) return;
      next[index] = b;
      next[swapWith] = a;
      reorderScenes.mutate(next, {
        onError: (error) =>
          toast.error('Failed to reorder scenes', {
            description: errorMessage(error),
          }),
      });
    },
    [reorderScenes]
  );

  const handleAddScene = () => {
    createScene.mutate(undefined, {
      onSuccess: ({ scene }) => {
        onSelectScene(scene.id, false);
      },
      onError: (error) =>
        toast.error('Failed to add scene', {
          description: errorMessage(error),
        }),
    });
  };

  const [isGenerating, setIsGenerating] = useState(false);
  const [includeMusic, setIncludeMusic] = useState(true);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [musicModel, setMusicModel] = useState<AudioModel>(
    initialMusicModel ?? DEFAULT_MUSIC_MODEL
  );

  // Sync local selection when the sequence's saved model changes from outside
  // (e.g. after generation completes and the workflow persists the new model).
  const prevInitialMusicRef = useRef(initialMusicModel);
  if (initialMusicModel && initialMusicModel !== prevInitialMusicRef.current) {
    prevInitialMusicRef.current = initialMusicModel;
    setMusicModel(initialMusicModel);
  }

  const totalShots = shots?.length ?? 0;

  // Shots that need to be kicked off (not already generating). 'cancelled'
  // is user-initiated (#1108 Phase 4): deliberately eligible for a
  // user-driven batch generate, never auto-retried.
  const notStartedShots = useMemo(() => {
    if (!shots) return [];
    return shots.filter(
      (f) =>
        (f.videoStatus === 'pending' ||
          f.videoStatus === 'failed' ||
          f.videoStatus === 'cancelled') &&
        f.frame.imageStatus === 'completed'
    );
  }, [shots]);

  const hasGeneratingShots = useMemo(() => {
    if (!shots) return false;
    return shots.some(
      (f) =>
        f.videoStatus === 'generating' && f.frame.imageStatus === 'completed'
    );
  }, [shots]);

  // Check if all eligible shots have motion prompts ready
  const motionPromptsReady = useMemo(() => {
    if (!notStartedShots.length) return true;
    return notStartedShots.every((f) => f.motionPrompt?.fullPrompt);
  }, [notStartedShots]);

  const handleGenerateMotion = async () => {
    if (!onBatchGenerateMotion || notStartedShots.length === 0) return;

    setIsGenerating(true);
    try {
      await onBatchGenerateMotion({
        includeMusic,
        musicModel,
        generateAudio,
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const isMotionInProgress = regeneratingMotion.size > 0 || hasGeneratingShots;
  const showButton =
    !hideBatchButton && notStartedShots.length > 0 && !isMotionInProgress;
  const isButtonDisabled =
    isGenerating ||
    notStartedShots.length === 0 ||
    !motionPromptsReady ||
    (includeMusic && !musicPromptsReady);

  const shotsBySceneId = useMemo(() => {
    const map = new Map<string, ShotView[]>();
    for (const shot of shots ?? []) {
      if (!shot.sceneId) continue;
      const list = map.get(shot.sceneId) ?? [];
      list.push(shot);
      map.set(shot.sceneId, list);
    }
    return map;
  }, [shots]);

  // Shots without a scene row (sequences predating the scenes table) still
  // render — dropping them would silently hide selectable shots.
  const unassignedShots = useMemo(
    () => (shots ?? []).filter((shot) => !shot.sceneId),
    [shots]
  );

  const groupedScenes = useMemo(() => {
    if (!scenes?.length) return [];
    return scenes.map((scene) => ({
      scene,
      shots: shotsBySceneId.get(scene.id) ?? [],
    }));
  }, [scenes, shotsBySceneId]);

  const isLoading = shots === undefined || scenes === undefined;

  const segmentsById = useMemo(() => {
    const map = new Map<string, SequenceSegment>();
    for (const segment of segments ?? []) map.set(segment.id, segment);
    return map;
  }, [segments]);

  const isWholeSequence = selection.sceneIds.length === 0 && !selection.shotId;

  return (
    <div className="flex h-full w-[280px] lg:w-[360px] flex-col rounded-lg border bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Scenes
        </h2>
      </div>

      <button
        type="button"
        onClick={onClearSelection}
        title={
          isWholeSequence
            ? 'Whole sequence selected'
            : 'Show the whole sequence (Esc zooms out one level at a time)'
        }
        className={cn(
          'border-b px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/40',
          isWholeSequence && 'bg-primary/5 font-medium text-primary'
        )}
      >
        Whole sequence
      </button>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-3 p-4">
          {loadError && (
            <p role="alert" className="text-sm text-destructive">
              Failed to load scenes: {loadError.message}
            </p>
          )}

          {!loadError && segmentsError && (
            <p role="alert" className="text-xs text-destructive">
              Failed to load video segments: {segmentsError.message}
            </p>
          )}

          {!loadError &&
            isLoading &&
            [1, 2, 3].map((i) => (
              <div
                key={`scene-skeleton-${i}`}
                className="h-20 animate-pulse rounded-lg border bg-muted/40"
              />
            ))}

          {!loadError &&
            !isLoading &&
            groupedScenes.length === 0 &&
            unassignedShots.length === 0 && (
              <p className="text-sm text-muted-foreground">No scenes yet.</p>
            )}

          {groupedScenes.map(({ scene, shots: sceneShots }, index) => (
            <SceneGroup
              key={scene.id}
              scene={scene}
              shots={sceneShots}
              sequenceId={sequenceId}
              segmentsById={segmentsById}
              isSceneSelected={selection.sceneIds.includes(scene.id)}
              selectedShotId={selection.shotId}
              aspectRatio={aspectRatio}
              onSelectScene={onSelectScene}
              onSelectShot={onSelectShot}
              onClearSelection={onClearSelection}
              isFirst={index === 0}
              isLast={index === groupedScenes.length - 1}
              onMoveScene={handleMoveScene}
              regeneratingImages={regeneratingImages}
              regeneratingMotion={regeneratingMotion}
              divergentByShotId={divergentByShotId}
              onCompareDivergent={onCompareDivergent}
              modelMissingShotIds={modelMissingShotIds}
              modelMissingLabel={modelMissingLabel}
              staleShotIds={staleShotIds}
            />
          ))}

          {unassignedShots.map((shot) => {
            const divergent = divergentByShotId.get(shot.id);
            return (
              <SceneListItem
                key={shot.id}
                shot={shot}
                aspectRatio={aspectRatio}
                isActive={shot.id === selection.shotId}
                onSelect={() => onSelectShot(shot.id)}
                variant="horizontal"
                isRegeneratingImage={regeneratingImages.has(shot.id)}
                isRegeneratingMotion={regeneratingMotion.has(shot.id)}
                divergentVariantId={divergent?.id}
                onCompareDivergent={
                  divergent ? () => onCompareDivergent?.(divergent) : undefined
                }
                modelMissing={
                  !!modelMissingLabel &&
                  (modelMissingShotIds?.has(shot.id) ?? false)
                }
                modelMissingLabel={modelMissingLabel}
                isStale={staleShotIds?.has(shot.id) ?? false}
              />
            );
          })}

          {!loadError && !isLoading && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddScene}
              disabled={createScene.isPending}
            >
              {createScene.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              {createScene.isPending ? 'Adding scene…' : 'Add scene'}
            </Button>
          )}
        </div>
      </ScrollArea>

      {/* Sticky footer with Generate Motion button */}
      {showButton && (
        <div className="sticky bottom-0 border-t bg-background p-4 flex flex-col gap-3">
          {includeMusic && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Music model</span>
              <MusicModelSelector
                selectedModel={musicModel}
                onModelChange={setMusicModel}
                disabled={isGenerating || isMotionInProgress}
              />
            </div>
          )}
          <Button
            variant="default"
            className="w-full"
            onClick={() => void handleGenerateMotion()}
            disabled={isButtonDisabled}
          >
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating…
              </>
            ) : !motionPromptsReady ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Writing motion prompts…
              </>
            ) : includeMusic && !musicPromptsReady ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Composing music…
              </>
            ) : (
              <>
                <Video className="mr-2 h-4 w-4" />
                Generate {notStartedShots.length} / {totalShots}{' '}
                {totalShots === 1 ? 'shot' : 'shots'}
              </>
            )}
          </Button>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={includeMusic}
              onCheckedChange={(checked) => setIncludeMusic(checked === true)}
              disabled={!musicPromptsReady}
            />
            <span>
              Also generate music
              {!musicPromptsReady && (
                <span className="text-xs ml-1">(preparing…)</span>
              )}
            </span>
          </label>
          <label
            htmlFor="batch-generate-audio"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Checkbox
              id="batch-generate-audio"
              checked={generateAudio}
              onCheckedChange={(checked) => setGenerateAudio(checked === true)}
            />
            <span>Include SFX &amp; dialogue (when the model supports it)</span>
          </label>
        </div>
      )}
    </div>
  );
};

// Custom equality check to prevent unnecessary re-renders during polling.
// Relies on TanStack Query's structural sharing to preserve object references.
const areEqual = (
  prevProps: SceneListProps,
  nextProps: SceneListProps
): boolean => {
  if (
    prevProps.sequenceId !== nextProps.sequenceId ||
    prevProps.selection !== nextProps.selection ||
    prevProps.scenes !== nextProps.scenes ||
    prevProps.segments !== nextProps.segments ||
    prevProps.loadError !== nextProps.loadError ||
    prevProps.segmentsError !== nextProps.segmentsError ||
    prevProps.aspectRatio !== nextProps.aspectRatio ||
    prevProps.musicPromptsReady !== nextProps.musicPromptsReady ||
    prevProps.hideBatchButton !== nextProps.hideBatchButton ||
    prevProps.initialMusicModel !== nextProps.initialMusicModel ||
    prevProps.modelMissingLabel !== nextProps.modelMissingLabel ||
    prevProps.modelMissingShotIds !== nextProps.modelMissingShotIds
  ) {
    return false;
  }

  if (
    prevProps.regeneratingImages !== nextProps.regeneratingImages ||
    prevProps.regeneratingMotion !== nextProps.regeneratingMotion
  ) {
    return false;
  }

  if (
    prevProps.onBatchGenerateMotion !== nextProps.onBatchGenerateMotion ||
    prevProps.onCompareDivergent !== nextProps.onCompareDivergent ||
    prevProps.onSelectScene !== nextProps.onSelectScene ||
    prevProps.onSelectShot !== nextProps.onSelectShot ||
    prevProps.onClearSelection !== nextProps.onClearSelection
  ) {
    return false;
  }

  if (prevProps.divergentVariants !== nextProps.divergentVariants) {
    return false;
  }

  // TanStack Query's structural sharing keeps the array reference stable when
  // the contents are unchanged, so reference equality is sufficient.
  if (prevProps.shots === nextProps.shots) {
    return true;
  }
  if (!prevProps.shots || !nextProps.shots) {
    return false;
  }
  if (prevProps.shots.length !== nextProps.shots.length) {
    return false;
  }
  for (let i = 0; i < prevProps.shots.length; i++) {
    if (prevProps.shots[i] !== nextProps.shots[i]) {
      return false;
    }
  }

  return true;
};

export const SceneList = memo(SceneListComponent, areEqual);
