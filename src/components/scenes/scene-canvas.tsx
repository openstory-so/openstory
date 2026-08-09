import { ScenePlayer } from '@/components/motion/scene-player';
import { CanvasMediaStage } from '@/components/scenes/canvas-media-stage';
import { ShotMediaDropZone } from '@/components/scenes/shot-media-drop-zone';
import { StartingFrameVariants } from '@/components/scenes/starting-frame-variants';
import { SequencePlayer } from '@/components/theatre/sequence-player';
import { useSequenceExport } from '@/components/theatre/use-sequence-export';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
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
import { Download, Film, Link, Loader2, Share2 } from 'lucide-react';
import { usePostHog } from '@posthog/react';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import type { ExportProgress } from '@/lib/sequence-player/export';

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
  progressMessage?: string;
  retry?: { attempt: number; maxAttempts?: number };
  onSelectShot?: (shotId: string) => void;
  /** Scene-level image model (#909) used to generate starting-frame variants. */
  sceneImageModel?: TextToImageModel;
  /** Shots with an in-flight scene-variants generation (#882). */
  regeneratingSceneVariants?: Set<string>;
  onGenerateSceneVariantsStart?: (shotId: string) => void;
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

const TheatreShareOverlay: React.FC<{ sequence: Sequence }> = ({
  sequence,
}) => {
  const posthog = usePostHog();
  const sequenceExport = useSequenceExport(sequence);
  const shareUrl = sequenceExport.latestExportUrl;

  const handleCopyShareUrl = useCallback(async () => {
    if (!shareUrl) {
      toast.error('Export an MP4 first to get a shareable URL.');
      return;
    }
    try {
      const absoluteUrl = new URL(shareUrl, window.location.origin).href;
      await navigator.clipboard.writeText(absoluteUrl);
      toast.success('Video URL copied');
      posthog.capture('video_url_copied', { sequence_id: sequence.id });
    } catch (err) {
      toast.error('Failed to copy URL');
      posthog.captureException(err);
    }
  }, [shareUrl, sequence.id, posthog]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 bg-black/50 text-white hover:bg-black/70"
          aria-label="Share"
        >
          <Share2 className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void handleCopyShareUrl()}>
          <Link className="h-4 w-4" />
          Copy latest export URL
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={sequenceExport.start}
          disabled={sequenceExport.isRunning}
        >
          {sequenceExport.isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {sequenceExport.isRunning
            ? formatExportProgress(sequenceExport.progress)
            : 'Export as MP4'}
        </DropdownMenuItem>
        {shareUrl && (
          <DropdownMenuItem
            onClick={() => {
              const a = document.createElement('a');
              a.href = shareUrl;
              a.download = `${sequence.title || 'sequence'}_openstory.mp4`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            }}
          >
            <Download className="h-4 w-4" />
            Download last export
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
}) => {
  const scope = selectionScope(selection);
  const scopedShots = useMemo(
    () => (shots ? selectionShots(selection, shots) : []),
    [selection, shots]
  );

  const playbackScenes = useMemo(() => {
    return scopedShots
      .map((f) => f.video?.url)
      .filter((url): url is string => Boolean(url))
      .map((videoUrl, orderIndex) => ({ orderIndex, videoUrl }));
  }, [scopedShots]);

  const setMusicEnabled = useSetSequenceMusic(sequence?.id ?? '');

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
    const frameOverlay =
      selectedShot && sceneImageModel ? (
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
        overlayActions={
          scope === 'sequence' ? (
            <TheatreShareOverlay sequence={sequence} />
          ) : undefined
        }
      />
    </CanvasMediaStage>
  );
};
