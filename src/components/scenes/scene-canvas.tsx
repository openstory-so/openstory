import { ScenePlayer } from '@/components/motion/scene-player';
import { CanvasMediaStage } from '@/components/scenes/canvas-media-stage';
import { ShotMediaDropZone } from '@/components/scenes/shot-media-drop-zone';
import { StartingFrameVariants } from '@/components/scenes/starting-frame-variants';
import { SequencePlayer } from '@/components/theatre/sequence-player';
import {
  useSequenceExport,
  type SequenceExportState,
} from '@/components/theatre/use-sequence-export';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { SceneWithScript } from '@/hooks/use-scenes';
import { useSetSequenceMusic } from '@/hooks/use-sequences';
import type { TabValue } from '@/components/scenes/scene-script-prompts';
import type { TextToImageModel } from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import {
  selectionScope,
  selectionShots,
  type SceneSelection,
} from '@/lib/scenes/scene-selection';
import type { ShotView } from '@/lib/shots/shot-view';
import type { Sequence } from '@/types/database';
import { Download, Film, Link, Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import type { ExportProgress } from '@/lib/sequence-player/export';
import { toPlaybackScenes } from '@/lib/sequence-player/playback-scenes';

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
};

function formatExportProgress(progress: ExportProgress | null): string {
  if (!progress) return 'Exporting…';
  const phaseLabel: Record<ExportProgress['phase'], string> = {
    prepare: 'Preparing',
    video: 'Stitching video',
    music: 'Downloading music',
    dialogue: 'Decoding dialogue',
    mix: 'Mixing audio',
    encode: 'Encoding audio',
    finalize: 'Finalizing',
    upload: 'Uploading',
    commit: 'Saving',
  };
  const label = phaseLabel[progress.phase];
  if (progress.total > 0) {
    const pct = Math.min(
      100,
      Math.round((progress.completed / progress.total) * 100)
    );
    return `${label}… ${pct}%`;
  }
  return `${label}…`;
}

/**
 * Download + Share for the theatre. Both actions treat `sequence_exports` as
 * a content-addressed cache of what the user is looking at: a cached MP4 of
 * the current state is reused, otherwise a new export runs first (#1253).
 */
const TheatreShareOverlay: React.FC<{
  sequenceExport: SequenceExportState;
}> = ({ sequenceExport }) => {
  const running = sequenceExport.isRunning;
  const progressLabel = formatExportProgress(sequenceExport.progress);
  const pending =
    !running && !sequenceExport.canExport && !sequenceExport.freshExportUrl;
  const wait = running
    ? progressLabel
    : pending
      ? `Export · ${sequenceExport.clipsReady} of ${sequenceExport.clipsTotal} clips ready`
      : null;
  const downloadLabel =
    wait ??
    (sequenceExport.freshExportUrl
      ? 'Download MP4'
      : 'Export and download MP4');
  const copyLabel =
    wait ??
    (sequenceExport.freshExportUrl
      ? 'Copy video link'
      : 'Export and copy video link');
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Span so a disabled button still shows the pending-count tooltip. */}
          <span className="inline-flex">
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 bg-black/50 text-white hover:bg-black/70 md:h-8 md:w-8"
              aria-label={downloadLabel}
              aria-busy={running}
              disabled={pending}
              // Stays enabled while running (the actions no-op) so the tooltip
              // can show progress — disabled buttons emit no pointer events.
              onClick={sequenceExport.download}
            >
              {running ? (
                <Loader2 className="h-5 w-5 animate-spin md:h-4 md:w-4" />
              ) : (
                <Download className="h-5 w-5 md:h-4 md:w-4" />
              )}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{downloadLabel}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 bg-black/50 text-white hover:bg-black/70 md:h-8 md:w-8"
              aria-label={copyLabel}
              aria-busy={running}
              disabled={pending}
              onClick={sequenceExport.copyLink}
            >
              {running ? (
                <Loader2 className="h-5 w-5 animate-spin md:h-4 md:w-4" />
              ) : (
                <Link className="h-5 w-5 md:h-4 md:w-4" />
              )}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{copyLabel}</TooltipContent>
      </Tooltip>
    </>
  );
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
  const sequenceExport = useSequenceExport(sequence);

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
            : sequenceExport.isCacheResolved
              ? sequenceExport.freshExportUrl
              : undefined
        }
        overlayActions={
          scope === 'sequence' ? (
            <TheatreShareOverlay sequenceExport={sequenceExport} />
          ) : undefined
        }
      />
    </CanvasMediaStage>
  );
};
