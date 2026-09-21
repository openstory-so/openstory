import { useEffect, useRef, useState } from 'react';
import { Images, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import type { AspectRatio } from '@/models/aspect-ratios';
import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/ui/shadcn/dialog';
import type { SceneSelection } from '@/shots/ui/scene-selection';
import { AnimaticPlayback } from './animatic-playback';
import {
  animaticLines,
  animaticSceneId,
  orderAnimaticShots,
  type AnimaticShot,
} from './animatic-shots';

function AnimaticPlayer({
  shots,
  aspectRatio,
}: {
  shots: readonly AnimaticShot[];
  aspectRatio: AspectRatio;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const playback = useRef<AnimaticPlayback | null>(null);
  const [state, setState] = useState({
    shotIndex: 0,
    clipIndex: 0,
    playing: false,
    finished: false,
    error: null as string | null,
  });
  const [failedImages, setFailedImages] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  useEffect(() => {
    if (!audioRef.current) return;
    const controller = new AnimaticPlayback(shots, audioRef.current, setState);
    playback.current = controller;
    controller.play();
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      if (
        event.code === 'Space' ||
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight'
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (event.code === 'Space') playback.current?.toggle();
        else playback.current?.step(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      controller.dispose();
      playback.current = null;
    };
  }, [shots]);
  const shot = shots[state.shotIndex];
  if (!shot) return <p>No shots in this scene yet.</p>;
  const preview = shot.previewThumbnailUrl;
  const imageUrl =
    preview && !failedImages.has(preview) ? preview : shot.image?.url;
  const lines = animaticLines(shot, state.clipIndex);
  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* Hard cuts deliberately have no animation, including under reduced motion. */}
      <div
        className="flex max-h-[55vh] items-center justify-center overflow-hidden rounded-lg bg-muted"
        style={{ aspectRatio: aspectRatio.replace(':', '/') }}
      >
        {imageUrl && !failedImages.has(imageUrl) ? (
          <img
            src={imageUrl}
            alt={`Shot ${state.shotIndex + 1}`}
            className="h-full w-full object-contain"
            onError={() =>
              setFailedImages((failed) => new Set([...failed, imageUrl]))
            }
          />
        ) : (
          <p className="text-muted-foreground">
            No image available for this shot
          </p>
        )}
      </div>
      {/* The recorded lines are rendered as a transcript immediately below. */}
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} preload="auto" />
      <div className="flex max-h-32 flex-col gap-1 overflow-y-auto text-sm">
        {lines.map((line, index) => (
          <p key={index}>
            {line.character && <strong>{line.character}: </strong>}
            {line.text}
          </p>
        ))}
        {!shot.audioClips?.length && (
          <p className="text-muted-foreground">
            No recorded dialogue · holding for{' '}
            {(shot.durationMs ?? 3000) / 1000}s
          </p>
        )}
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div className="flex items-center justify-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Previous shot"
          disabled={state.shotIndex === 0}
          onClick={() => playback.current?.step(-1)}
        >
          <SkipBack />
        </Button>
        <Button
          aria-label={
            state.playing
              ? 'Pause animatic'
              : state.finished
                ? 'Replay animatic'
                : 'Play animatic'
          }
          onClick={() => playback.current?.toggle()}
        >
          {state.playing ? <Pause /> : <Play />}
          {state.playing ? 'Pause' : state.finished ? 'Replay' : 'Play'}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Next shot"
          disabled={state.shotIndex === shots.length - 1}
          onClick={() => playback.current?.step(1)}
        >
          <SkipForward />
        </Button>
        <span className="text-sm text-muted-foreground">
          Shot {state.shotIndex + 1} of {shots.length}
        </span>
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Space to play or pause · Arrow keys to step shots
      </p>
    </div>
  );
}

export function AnimaticDialog({
  shots,
  scenes,
  selection,
  aspectRatio,
}: {
  shots: readonly AnimaticShot[];
  scenes: readonly { id: string }[];
  selection: SceneSelection;
  aspectRatio: AspectRatio;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<'scene' | 'sequence'>('sequence');
  // Snapshot the playlist on open: background query refreshes must not restart playback.
  const [playlist, setPlaylist] = useState<AnimaticShot[]>([]);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [scopedShots, setScopedShots] = useState<AnimaticShot[]>([]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          const ordered = orderAnimaticShots(
            shots,
            scenes.map((scene) => scene.id)
          );
          const selectedScene = animaticSceneId(selection, ordered);
          setPlaylist(ordered);
          setSceneId(selectedScene ?? ordered[0]?.sceneId ?? null);
          setScope(selectedScene ? 'scene' : 'sequence');
          setScopedShots(
            selectedScene
              ? ordered.filter((shot) => shot.sceneId === selectedScene)
              : ordered
          );
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={!shots.length}
          title="Play storyboard stills with recorded dialogue"
        >
          <Images />
          Animatic
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[95dvh] overflow-y-auto sm:max-w-3xl motion-reduce:animate-none">
        <DialogTitle>Animatic</DialogTitle>
        <DialogDescription>
          Preview the story with stills and recorded dialogue.
        </DialogDescription>
        <fieldset className="flex gap-2" aria-label="Animatic scope">
          <Button
            variant={scope === 'scene' ? 'secondary' : 'ghost'}
            disabled={!sceneId}
            aria-pressed={scope === 'scene'}
            onClick={() => {
              setScope('scene');
              setScopedShots(
                playlist.filter((shot) => shot.sceneId === sceneId)
              );
            }}
          >
            This scene
          </Button>
          <Button
            variant={scope === 'sequence' ? 'secondary' : 'ghost'}
            aria-pressed={scope === 'sequence'}
            onClick={() => {
              setScope('sequence');
              setScopedShots(playlist);
            }}
          >
            Whole sequence
          </Button>
        </fieldset>
        {open && (
          <AnimaticPlayer
            key={scope}
            shots={scopedShots}
            aspectRatio={aspectRatio}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
