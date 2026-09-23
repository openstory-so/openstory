import { ScenePlayer } from '@/motion/ui/scene-player';
import { CanvasMediaStage } from './canvas-media-stage';
import { ShotDialogueUnderVideo } from './shot-dialogue-readings';
import { ShotMediaDropZone } from './shot-media-drop-zone';
import { StartingFrameVariants } from './starting-frame-variants';
import { formatExportProgress } from './sequence-export-actions';
import { SequencePlayer } from '@/sequences/ui/theatre/sequence-player';
import type { SequenceExportState } from '@/sequences/ui/theatre/use-sequence-export';
import { PlaybackShotScrubber } from '@/sequences/ui/theatre/playback-shot-scrubber';
import {
  applySceneDurations,
  playbackSceneCount,
  playbackShotSpans,
  scaleSpansToDuration,
  shotIdAtPlaybackTime,
  spanStartForShot,
} from '@/sequences/ui/theatre/playback-shot-spans';
import { Button } from '@/ui/shadcn/button';
import { Checkbox } from '@/ui/shadcn/checkbox';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip';
import type { SceneWithScript } from './use-scenes';
import { useSetSequenceMusic } from '@/sequences/ui/use-sequences';
import type { TabValue } from './scene-script-prompts';
import type { TextToImageModel } from '@/models/models';
import type { AspectRatio } from '@/models/aspect-ratios';
import {
  playbackMode,
  playbackRangeShots,
  type SceneSelection,
} from './scene-selection';
import type { ShotView } from '@/shots/shot-view';
import type { Sequence } from '@/platform/server/db/schema';
import { Download, Film, Link, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toPlaybackScenes } from '@/sequences/ui/theatre/playback-scenes';

type SceneCanvasProps = {
  selection: SceneSelection;
  shots?: ShotView[];
  /** Scenes the shots belong to — the player reads the displayed shot's title. */
  scenes?: SceneWithScript[];
  /** Shots query failure — shown instead of an indefinite skeleton. */
  loadError?: Error | null;
  sequence?: Sequence;
  aspectRatio: AspectRatio;
  selectedTab?: TabValue;
  overrideImageUrl?: string | null;
  overrideVideoUrl?: string | null;
  badgeMessage?: string | null;
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
  /** Scene-list play button — start the theatre player once it is ready. */
  autoPlay?: boolean;
  onAutoPlayConsumed?: () => void;
  /**
   * Sequence/scene playback moved onto this shot. The player stays mounted;
   * the rail and inspector follow (#1771).
   */
  onPlayingShot?: (shotId: string) => void;
  /** "Play this shot only" / resume the sequence. */
  onPlaybackChange?: (selection: SceneSelection) => void;
};

/**
 * Download + Copy on the theatre player. Icon-only so they fit the existing
 * overlay row (music + mixed-res). Desktop also has a labeled Export menu in
 * the Canvas/Script toggle trailing slot; mobile keeps these overlay icons
 * at the 44px hit target.
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
          <span className="inline-flex">
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 bg-black/50 text-white hover:bg-black/70 md:h-8 md:w-8"
              aria-label={downloadLabel}
              aria-busy={running}
              disabled={pending}
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
  sequence,
  aspectRatio,
  selectedTab,
  overrideImageUrl,
  overrideVideoUrl,
  badgeMessage,
  staleLabel,
  progressMessage,
  retry,
  onSelectShot,
  sceneImageModel,
  regeneratingSceneVariants,
  onGenerateSceneVariantsStart,
  firstRunActive = false,
  sequenceExport,
  autoPlay = false,
  onAutoPlayConsumed,
  onPlayingShot,
  onPlaybackChange,
}) => {
  const mode = playbackMode(selection);
  const rangeShots = useMemo(
    () => (shots ? playbackRangeShots(selection, shots) : []),
    [selection, shots]
  );

  const playbackScenes = useMemo(
    () => toPlaybackScenes(rangeShots, aspectRatio),
    [rangeShots, aspectRatio]
  );

  const setMusicEnabled = useSetSequenceMusic(sequence?.id ?? '');
  const rangeKey = rangeShots
    .map(
      (shot) =>
        `${shot.id}:${shot.video?.url ?? ''}:${shot.image?.url ?? ''}:${shot.durationMs ?? ''}`
    )
    .join('|');
  // Key the clock to the play range so a new cut drops the previous
  // file's durations without an effect.
  const [sceneClock, setSceneClock] = useState<{
    key: string;
    durations: number[];
  } | null>(null);
  const [mediaClock, setMediaClock] = useState<{
    key: string;
    duration: number;
  } | null>(null);
  const [timeClock, setTimeClock] = useState<{ key: string; time: number }>({
    key: rangeKey,
    time: 0,
  });
  const [seek, setSeek] = useState<{ seconds: number; nonce: number } | null>(
    null
  );
  const sceneDurations =
    sceneClock?.key === rangeKey ? sceneClock.durations : null;
  const mediaDuration =
    mediaClock?.key === rangeKey ? mediaClock.duration : null;
  const currentTime = timeClock.key === rangeKey ? timeClock.time : 0;

  const spans = useMemo(() => {
    const base = playbackShotSpans(rangeShots);
    if (sceneDurations && sceneDurations.length === playbackSceneCount(base)) {
      return applySceneDurations(base, sceneDurations);
    }
    if (mediaDuration != null && mediaDuration > 0) {
      return scaleSpansToDuration(base, mediaDuration);
    }
    return base;
  }, [rangeShots, sceneDurations, mediaDuration]);

  const requestSeek = (seconds: number) => {
    setSeek((prev) => ({ seconds, nonce: (prev?.nonce ?? 0) + 1 }));
    setTimeClock({ key: rangeKey, time: seconds });
  };

  const handleTimeUpdate = (time: number) => {
    setTimeClock({ key: rangeKey, time });
    if (mode !== 'continue') return;
    // Ignore the resting playhead at 0 until the cut actually moves, so
    // opening the sequence does not steal the sequence-level inspector.
    if (time < 0.05 && !selection.shotId) return;
    const shotId = shotIdAtPlaybackTime(spans, time);
    if (shotId) onPlayingShot?.(shotId);
  };

  const showShotOnlyToggle =
    mode === 'shot' ? (shots?.length ?? 0) > 1 : rangeShots.length > 1;

  const handleShotOnly = (checked: boolean) => {
    if (!onPlaybackChange || !shots) return;
    if (checked) {
      const shotId = selection.shotId ?? spans[0]?.shotId;
      if (!shotId) return;
      onPlaybackChange({ sceneIds: [], shotId, playback: 'shot' });
      return;
    }
    const shotId = selection.shotId;
    if (!shotId) return;
    const start = spanStartForShot(playbackShotSpans(shots), shotId) ?? 0;
    onPlaybackChange({
      sceneIds: [],
      shotId,
      playback: 'continue',
    });
    requestSeek(start);
  };

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

  if (mode === 'shot' && selection.shotId) {
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
        shots={shots}
        scenes={scenes}
        selectedShotId={selection.shotId}
        aspectRatio={aspectRatio}
        onSelectShot={onSelectShot}
        selectedTab={selectedTab}
        overrideImageUrl={overrideImageUrl}
        overrideVideoUrl={overrideVideoUrl}
        badgeMessage={badgeMessage}
        staleLabel={staleLabel}
        progressMessage={progressMessage}
        retry={retry}
        posterUrl={sequence?.posterUrl ?? undefined}
        sequence={sequence}
        className="h-full max-h-none w-full"
        wrapperClassName="h-full w-full"
        frameOverlay={frameOverlay}
      />
    );
    return (
      <CanvasMediaStage
        aspectRatio={aspectRatio}
        below={
          selectedShot || showShotOnlyToggle ? (
            <div className="flex flex-col gap-3">
              {selectedShot ? (
                <ShotDialogueUnderVideo shot={selectedShot} />
              ) : null}
              {showShotOnlyToggle ? (
                <PlayThisShotOnly checked onCheckedChange={handleShotOnly} />
              ) : null}
            </div>
          ) : undefined
        }
      >
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
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 py-16">
        <Film className="h-8 w-8 text-muted-foreground" />
        <p className="text-muted-foreground">No scenes ready to play yet</p>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          Add shots to preview playback here.
        </p>
      </div>
    );
  }

  if (!sequence) {
    return null;
  }

  const playingWholeSequence =
    mode === 'continue' && selection.sceneIds.length === 0;

  return (
    <CanvasMediaStage
      aspectRatio={aspectRatio}
      footer={
        spans.length > 0 ? (
          <div className="flex flex-col gap-2">
            <PlaybackShotScrubber
              spans={spans}
              currentShotId={
                selection.shotId ?? shotIdAtPlaybackTime(spans, currentTime)
              }
              currentTime={currentTime}
              onSeek={requestSeek}
            />
            {showShotOnlyToggle ? (
              <PlayThisShotOnly
                checked={false}
                onCheckedChange={handleShotOnly}
              />
            ) : null}
          </div>
        ) : undefined
      }
    >
      <SequencePlayer
        scenes={playbackScenes}
        musicUrl={playingWholeSequence ? (sequence.musicUrl ?? null) : null}
        musicLoudnessGainDb={null}
        musicEnabled={playingWholeSequence ? sequence.includeMusic : false}
        onMusicEnabledChange={(enabled) => setMusicEnabled.mutate(enabled)}
        aspectRatio={aspectRatio}
        className="h-full max-h-none w-full"
        playSource="theatre"
        sequenceId={sequence.id}
        autoPlay={autoPlay}
        onAutoPlayConsumed={onAutoPlayConsumed}
        playlistUrl={playingWholeSequence ? sequenceExport.playbackUrl : null}
        overlayActions={
          playingWholeSequence ? (
            <TheatreShareOverlay sequenceExport={sequenceExport} />
          ) : undefined
        }
        seekTo={seek?.seconds ?? null}
        seekNonce={seek?.nonce ?? 0}
        onTimeUpdate={handleTimeUpdate}
        onSceneDurations={(durations) =>
          setSceneClock({ key: rangeKey, durations })
        }
        onDuration={(duration) => setMediaClock({ key: rangeKey, duration })}
      />
    </CanvasMediaStage>
  );
};

const PlayThisShotOnly: React.FC<{
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}> = ({ checked, onCheckedChange }) => (
  <label
    htmlFor="play-this-shot-only"
    className="flex min-h-11 items-center gap-2 self-start text-sm"
  >
    <Checkbox
      id="play-this-shot-only"
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
    />
    Play this shot only
  </label>
);
