/**
 * Adaptive canvas (#986) — the center pane of the unified Scenes editor.
 *
 * Renders what the current selection scopes to:
 * - shot selected      → the single-shot `ScenePlayer` (unchanged behaviour)
 * - scene(s) selected  → those scenes' shots stitched and played in order
 * - nothing selected   → whole-sequence playback with music + export
 *   (absorbs the Theatre tab)
 *
 * Multi-shot playback reuses `SequencePlayer`; a filmstrip below the player
 * doubles as the timeline: each covered shot is a segment, the playing one is
 * highlighted, clicking a ready segment seeks to it and clicking an un-ready
 * one selects the shot so it can be fixed.
 */

import { ScenePlayer } from '@/components/motion/scene-player';
import { type TabValue } from '@/components/scenes/scene-script-prompts';
import { SceneThumbnail } from '@/components/scenes/scene-thumbnail';
import {
  SequencePlayer,
  type SequencePlayerControls,
} from '@/components/theatre/sequence-player';
import { useSequenceExport } from '@/components/theatre/use-sequence-export';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSetSequenceMusic } from '@/hooks/use-sequences';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import {
  scopeOf,
  shotsInSelection,
  type SceneSelection,
} from '@/lib/scenes/selection';
import type { SceneInput } from '@/lib/sequence-player/concatenated-video-source';
import type { ExportProgress } from '@/lib/sequence-player/export';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { cn } from '@/lib/utils';
import type { Sequence } from '@/types/database';
import { Download, Link, Loader2, Share2 } from 'lucide-react';
import { usePostHog } from '@posthog/react';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';

/** Shot-scope passthroughs — the existing `ScenePlayer` surface, unchanged. */
type ShotPlayerProps = {
  selectedTab: TabValue;
  overrideImageUrl: string | null;
  overrideVideoUrl: string | null;
  badgeMessage: string | null;
  modelMismatchLabel: string | null;
  progressMessage?: string;
  retry?: { attempt: number; maxAttempts?: number };
  className?: string;
  wrapperClassName?: string;
};

type SequenceCanvasProps = {
  sequence?: Sequence;
  /** Player-remapped shots (viewer-local model pins applied). */
  shots?: ShotWithImage[];
  selection: SceneSelection;
  onSelectShot: (shotId: string) => void;
  aspectRatio: AspectRatio;
  posterUrl?: string;
  shotPlayerProps: ShotPlayerProps;
  /** Shot under the playhead (owned by the parent, echoed to the spine). */
  playingShotId: string | null;
  /** Reports the shot under the playhead during multi-shot playback. */
  onPlayingShotChange: (shotId: string | null) => void;
  /** Imperative playback controls, shared with spine clicks + Space key. */
  controlsRef: React.RefObject<SequencePlayerControls | null>;
};

export const SequenceCanvas: React.FC<SequenceCanvasProps> = ({
  sequence,
  shots,
  selection,
  onSelectShot,
  aspectRatio,
  posterUrl,
  shotPlayerProps,
  playingShotId,
  onPlayingShotChange,
  controlsRef,
}) => {
  const scope = scopeOf(selection);

  const covered = useMemo(
    () => (shots ? shotsInSelection(selection, shots) : []),
    [selection, shots]
  );
  const ready = useMemo(
    () =>
      covered.filter(
        (s): s is (typeof covered)[number] & { videoUrl: string } =>
          s.videoStatus === 'completed' && Boolean(s.videoUrl)
      ),
    [covered]
  );

  if (scope === 'shot' || ready.length === 0) {
    // Shot scope, or nothing playable yet in this scope (e.g. mid-generation):
    // the single-shot player handles stills, progress overlays and retries.
    const fallbackShotId = selection.shotId ?? covered[0]?.id;
    return (
      <ScenePlayer
        shots={shots}
        selectedShotId={fallbackShotId}
        aspectRatio={aspectRatio}
        onSelectShot={onSelectShot}
        posterUrl={posterUrl}
        {...shotPlayerProps}
      />
    );
  }

  if (!sequence) return null;
  return (
    <MultiShotCanvas
      sequence={sequence}
      covered={covered}
      ready={ready}
      scope={scope}
      onSelectShot={onSelectShot}
      aspectRatio={aspectRatio}
      playingShotId={playingShotId}
      onPlayingShotChange={onPlayingShotChange}
      controlsRef={controlsRef}
      wrapperClassName={shotPlayerProps.wrapperClassName}
    />
  );
};

type MultiShotCanvasProps = {
  sequence: Sequence;
  covered: ShotWithImage[];
  ready: Array<ShotWithImage & { videoUrl: string }>;
  scope: 'sequence' | 'scene';
  onSelectShot: (shotId: string) => void;
  aspectRatio: AspectRatio;
  playingShotId: string | null;
  onPlayingShotChange: (shotId: string | null) => void;
  controlsRef: React.RefObject<SequencePlayerControls | null>;
  wrapperClassName?: string;
};

const MultiShotCanvas: React.FC<MultiShotCanvasProps> = ({
  sequence,
  covered,
  ready,
  scope,
  onSelectShot,
  aspectRatio,
  playingShotId,
  onPlayingShotChange,
  controlsRef,
  wrapperClassName,
}) => {
  const setMusicEnabled = useSetSequenceMusic(sequence.id);

  // Keyed by the urls so the engine only re-prepares when the actual playback
  // set changes, not on unrelated shots-list refetches.
  const playbackKey = ready.map((s) => s.videoUrl).join('|');
  const scenes = useMemo<SceneInput[]>(
    () =>
      ready.map((s) => ({ orderIndex: s.orderIndex, videoUrl: s.videoUrl })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity keyed on the playback set
    [playbackKey]
  );

  // Map the player's scene index (over `ready`) back to the shot id.
  const handleActiveSceneChange = useCallback(
    (index: number) => {
      onPlayingShotChange(index >= 0 ? (ready[index]?.id ?? null) : null);
    },
    [ready, onPlayingShotChange]
  );

  const readyIndexByShotId = useMemo(() => {
    const map = new Map<string, number>();
    ready.forEach((s, i) => map.set(s.id, i));
    return map;
  }, [ready]);

  // Sequence music only makes sense across the full sequence — a scene
  // subset would start the track from 0:00 against the wrong shots.
  const musicUrl = scope === 'sequence' ? (sequence.musicUrl ?? null) : null;

  const allReady = ready.length === covered.length;

  return (
    <div className={cn('flex w-full flex-col gap-2', wrapperClassName)}>
      <SequencePlayer
        scenes={scenes}
        musicUrl={musicUrl}
        musicLoudnessGainDb={null}
        musicEnabled={sequence.includeMusic}
        onMusicEnabledChange={(enabled) => setMusicEnabled.mutate(enabled)}
        aspectRatio={aspectRatio}
        overlayActions={
          scope === 'sequence' && allReady ? (
            <ExportMenu sequence={sequence} />
          ) : undefined
        }
        onActiveSceneChange={handleActiveSceneChange}
        controlsRef={controlsRef}
      />

      {!allReady && (
        <p className="text-xs text-muted-foreground">
          Playing {ready.length} of {covered.length} shots — the rest have no
          video yet.
        </p>
      )}

      {/* Filmstrip timeline: one segment per covered shot. */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {covered.map((shot) => {
          const readyIndex = readyIndexByShotId.get(shot.id);
          const isReady = readyIndex !== undefined;
          return (
            <FilmstripSegment
              key={shot.id}
              shot={shot}
              aspectRatio={aspectRatio}
              isReady={isReady}
              isPlaying={shot.id === playingShotId}
              onClick={() => {
                if (readyIndex !== undefined) {
                  controlsRef.current?.seekToScene(readyIndex);
                } else {
                  // Not playable yet — jump to the shot to fix it.
                  onSelectShot(shot.id);
                }
              }}
              onDoubleClick={() => onSelectShot(shot.id)}
            />
          );
        })}
      </div>
    </div>
  );
};

type FilmstripSegmentProps = {
  shot: ShotWithImage;
  aspectRatio: AspectRatio;
  isReady: boolean;
  isPlaying: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
};

const FilmstripSegment: React.FC<FilmstripSegmentProps> = ({
  shot,
  aspectRatio,
  isReady,
  isPlaying,
  onClick,
  onDoubleClick,
}) => {
  const title =
    shot.metadata?.metadata?.title ?? `Scene ${shot.orderIndex + 1}`;
  return (
    <button
      type="button"
      data-shot-id={shot.id}
      data-playing={isPlaying}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        'group relative w-16 shrink-0 overflow-hidden rounded-sm border transition-all',
        'data-[playing=true]:border-primary data-[playing=true]:ring-1 data-[playing=true]:ring-primary',
        'border-transparent hover:border-muted-foreground/40',
        !isReady && 'opacity-40'
      )}
      title={
        isReady
          ? `${title} — click to play from here, double-click to edit`
          : `${title} — no video yet, click to open`
      }
      aria-label={title}
    >
      <SceneThumbnail
        thumbnailUrl={shot.thumbnailUrl}
        previewThumbnailUrl={shot.previewThumbnailUrl}
        thumbnailStatus={shot.thumbnailStatus || undefined}
        alt={title}
        aspectRatio={aspectRatio}
        className="w-full"
      />
    </button>
  );
};

const ExportMenu: React.FC<{ sequence: Sequence }> = ({ sequence }) => {
  const posthog = usePostHog();
  const sequenceExport = useSequenceExport(sequence);
  const shareUrl = sequenceExport.latestExportUrl;

  const handleCopyShareUrl = useCallback(async () => {
    if (!shareUrl) {
      toast.error('Export an MP4 first to get a shareable URL.');
      return;
    }
    try {
      // Stored export URLs are origin-relative (#894) — absolutize against the
      // current origin so the copied link is usable when pasted elsewhere.
      const absoluteUrl = new URL(shareUrl, window.location.origin).href;
      await navigator.clipboard.writeText(absoluteUrl);
      toast.success('Video URL copied');
      posthog.capture('video_url_copied', { sequence_id: sequence.id });
    } catch (err) {
      toast.error('Failed to copy URL');
      posthog.captureException(err);
    }
  }, [shareUrl, sequence.id, posthog]);

  const handleDownloadLatest = useCallback(() => {
    if (!shareUrl) {
      sequenceExport.start();
      return;
    }
    const a = document.createElement('a');
    a.href = shareUrl;
    a.download = `${sequence.title || 'sequence'}_openstory.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    posthog.capture('video_downloaded', { sequence_id: sequence.id });
  }, [shareUrl, sequence.id, sequence.title, posthog, sequenceExport]);

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
          <DropdownMenuItem onClick={handleDownloadLatest}>
            <Download className="h-4 w-4" />
            Download last export
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
