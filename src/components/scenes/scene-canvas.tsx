import { ScenePlayer } from '@/components/motion/scene-player';
import { CanvasMediaStage } from '@/components/scenes/canvas-media-stage';
import { ShotMediaDropZone } from '@/components/scenes/shot-media-drop-zone';
import { StartingFrameVariants } from '@/components/scenes/starting-frame-variants';
import { formatExportProgress } from '@/components/scenes/sequence-export-actions';
import { SequencePlayer } from '@/components/theatre/sequence-player';
import type { SequenceExportState } from '@/components/theatre/use-sequence-export';
import { Skeleton } from '@/components/ui/skeleton';
import type { SceneWithScript } from '@/hooks/use-scenes';
import { useSetSequenceMusic } from '@/hooks/use-sequences';
import type { TabValue } from '@/components/scenes/scene-script-prompts';
import type { TextToImageModel } from '@/lib/ai/models';
import type { AspectRatio } from '@/shared/constants/aspect-ratios';
import {
  selectionScope,
  selectionShots,
  type SceneSelection,
} from '@/lib/scenes/scene-selection';
import type { ShotView } from '@/lib/shots/shot-view';
import type { Sequence } from '@/types/database';
import { Film } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { theatrePlaybackMode } from '@/shared/sequence-player/theatre-playback-mode';
import { toPlaybackScenes } from '@/shared/sequence-player/playback-scenes';

type SceneCanvasProps = {
  selection: SceneSelection;
  shots?: ShotView[];
  /** Scenes the shots belong to — the player reads the displayed shot's title. */
  scenes?: SceneWithScript[];
  /** Shots query failure — shown instead of an indefinite skeleton. */
  loadError?: Error | null;
  playerShots?: ShotView[];
  sequence?: Sequence;
  aspectRatio: AspectRatio;
  selectedTab?: TabValue;
  overrideImageUrl?: string | null;
  overrideVideoUrl?: string | null;
  badgeMessage?: string | null;
  modelMismatchLabel?: string | null;
  /** Quiet stale chip for the displayed image (#1077). */
  staleLabel?: string | null;
  progressMessage?: React.ReactNode;
  retry?: { attempt: number; maxAttempts?: number };
  onSelectShot?: (shotId: string) => void;
  /** Scene-level image model (#909) used to generate starting-frame variants. */
  sceneImageModel?: TextToImageModel;
  /** Shots with an in-flight scene-variants generation (#882). */
  regeneratingSceneVariants?: Set<string>;
  onGenerateSceneVariantsStart?: (shotId: string) => void;
  /**
   * First pipeline run still in flight — hide variants / stale chrome until
   * the sequence has something to act on (#1286).
   */
  firstRunActive?: boolean;
  sequenceExport: SequenceExportState;
};

export const SceneCanvas: React.FC<SceneCanvasProps> = ({
  selection,
  shots,
  scenes,
  loadError,
  playerShots,
  sequence,
  aspectRatio,
  selectedTab,
  overrideImageUrl,
  overrideVideoUrl,
  badgeMessage,
  modelMismatchLabel,
  staleLabel,
  progressMessage,
  retry,
  onSelectShot,
  sceneImageModel,
  regeneratingSceneVariants,
  onGenerateSceneVariantsStart,
  firstRunActive = false,
  sequenceExport,
}) => {
  const scope = selectionScope(selection);
  const scopedShots = useMemo(
    () => (shots ? selectionShots(selection, shots) : []),
    [selection, shots]
  );

  const playbackScenes = useMemo(
    () => toPlaybackScenes(scopedShots),
    [scopedShots]
  );

  const setMusicEnabled = useSetSequenceMusic(sequence?.id ?? '');
  const [previewLive, setPreviewLive] = useState(false);
  const [canTransmux, setCanTransmux] = useState<boolean | null>(null);
  const playbackMode = theatrePlaybackMode({
    freshExportUrl: sequenceExport.freshExportUrl,
    serverExportAvailable: sequenceExport.serverExportAvailable,
    canTransmux,
    previewLive,
    playCutFailed: sequenceExport.playCutFailed,
  });

  useEffect(() => {
    setPreviewLive(false);
    setCanTransmux(null);
  }, [sequence?.id, sequence?.includeMusic, sequence?.musicUrl]);

  const ensureCut = sequenceExport.ensureCut;
  const canExportCut = sequenceExport.canExport;
  useEffect(() => {
    if (playbackMode !== 'wait-for-cut') return;
    if (!canExportCut) return;
    ensureCut();
  }, [playbackMode, canExportCut, ensureCut]);

  if (loadError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <p
          role="alert"
          className="max-w-md text-center text-sm text-destructive"
        >
          Failed to load shots: {loadError.message}
        </p>
      </div>
    );
  }

  if (!shots) {
    return (
      <CanvasMediaStage aspectRatio={aspectRatio}>
        <Skeleton className="h-full w-full rounded-lg" />
      </CanvasMediaStage>
    );
  }

  if (scope === 'shot' && selection.shotId) {
    const shotId = selection.shotId;
    const selectedShot = shots.find((s) => s.id === shotId);
    const stillUrl = selectedShot?.image?.url;
    const frameOverlay =
      selectedShot && sceneImageModel && stillUrl && !firstRunActive ? (
        <StartingFrameVariants
          shot={selectedShot}
          sequenceId={selectedShot.sequenceId}
          imageModel={sceneImageModel}
          aspectRatio={aspectRatio}
          generating={regeneratingSceneVariants?.has(shotId) ?? false}
          onGenerateStart={() => onGenerateSceneVariantsStart?.(shotId)}
        />
      ) : undefined;
    const player = (
      <ScenePlayer
        shots={playerShots}
        scenes={scenes}
        selectedShotId={selection.shotId}
        aspectRatio={aspectRatio}
        onSelectShot={onSelectShot}
        selectedTab={selectedTab}
        overrideImageUrl={overrideImageUrl}
        overrideVideoUrl={overrideVideoUrl}
        badgeMessage={badgeMessage}
        modelMismatchLabel={modelMismatchLabel}
        staleLabel={staleLabel}
        progressMessage={progressMessage}
        retry={retry}
        posterUrl={sequence?.posterUrl ?? undefined}
        className="h-full max-h-none w-full"
        wrapperClassName="h-full w-full"
        frameOverlay={frameOverlay}
      />
    );
    return (
      <CanvasMediaStage aspectRatio={aspectRatio}>
        {selectedShot ? (
          <ShotMediaDropZone
            sequenceId={selectedShot.sequenceId}
            shotId={shotId}
            aspectRatio={aspectRatio}
          >
            {player}
          </ShotMediaDropZone>
        ) : (
          player
        )}
      </CanvasMediaStage>
    );
  }

  if (playbackScenes.length === 0) {
    // No video to play yet — fall back to a still of the selection's first
    // shot (#1091). ScenePlayer owns the image ladder (final thumbnail → fast
    // preview) plus the generating/failed overlays, so early scenes show
    // something the moment their first preview lands.
    const stillShot =
      scopedShots.find((s) => s.image?.url || s.previewThumbnailUrl) ??
      scopedShots[0];
    if (stillShot) {
      return (
        <CanvasMediaStage aspectRatio={aspectRatio}>
          <ScenePlayer
            shots={playerShots}
            scenes={scenes}
            selectedShotId={stillShot.id}
            aspectRatio={aspectRatio}
            progressMessage={progressMessage}
            posterUrl={sequence?.posterUrl ?? undefined}
            className="h-full max-h-none w-full"
            wrapperClassName="h-full w-full"
          />
        </CanvasMediaStage>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 py-16">
        <Film className="h-8 w-8 text-muted-foreground" />
        <p className="text-muted-foreground">No scenes ready to play yet</p>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          Generate motion for your shots to preview playback here.
        </p>
      </div>
    );
  }

  if (!sequence) {
    return null;
  }

  return (
    <CanvasMediaStage aspectRatio={aspectRatio}>
      <SequencePlayer
        scenes={playbackScenes}
        musicUrl={scope === 'sequence' ? (sequence.musicUrl ?? null) : null}
        musicLoudnessGainDb={null}
        musicEnabled={scope === 'sequence' ? sequence.includeMusic : false}
        onMusicEnabledChange={(enabled) => setMusicEnabled.mutate(enabled)}
        aspectRatio={aspectRatio}
        className="h-full max-h-none w-full"
        playSource="theatre"
        sequenceId={sequence.id}
        posterUrl={scopedShots[0]?.image?.url ?? sequence.posterUrl}
        cachedVideoUrl={
          scope !== 'sequence'
            ? null
            : !sequenceExport.isCacheResolved
              ? undefined
              : playbackMode === 'native'
                ? sequenceExport.freshExportUrl
                : null
        }
        cutPending={playbackMode === 'wait-for-cut'}
        cutPendingLabel={
          sequenceExport.isRunning
            ? formatExportProgress(sequenceExport.progress)
            : undefined
        }
        onPreviewLive={() => setPreviewLive(true)}
        onPrepared={(meta) => setCanTransmux(meta.canTransmux)}
      />
    </CanvasMediaStage>
  );
};
