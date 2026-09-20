/**
 * The dialogue an audio-capable video model will be told to speak (#1559).
 *
 * Lines are READ-ONLY: they come from the script. Audio is one choice for
 * the whole shot (#1554): the generated take, a user-uploaded audio
 * element, or the video model inventing the voices. Per-line binding was
 * the old grain; the take is a conversation, not a character.
 *
 * Before the shot has a motion prompt the caller hands in the scene's own
 * lines instead (#1585). Voice binding waits for the prompt row it is
 * stored on, so `onChange` is null then.
 *
 * `ShotDialogueBlock` is the same lines + audio + readings, read-only and
 * compact, for under the shot's video (#1657).
 */

import { formatElementDuration } from '@/cast/element-kind';
import {
  GENERATED_VOICE,
  VIDEO_MODEL_VOICE_TOKEN,
  orphanedVoiceTokens,
  persistToken,
  shotPickerValue,
} from '@/motion/dialogue-tts';
import { dialogueExceedsShotDuration } from '@/motion/resolve-shot-duration';
import type { SequenceElementMinimal } from '@/platform/server/db/schema';
import type {
  DialogueLine,
  MotionDialogue,
} from '@/shots/scene-analysis.schema';
import { Button } from '@/ui/shadcn/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/shadcn/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
import { Check, ChevronDown } from 'lucide-react';

type DialogueClip = {
  url: string;
  durationSeconds: number | null;
};

/**
 * One reading of this shot's lines (#1657): a time range of a recording.
 * The whole recording is the file; the range rides the URL as a media
 * fragment, so one file serves every shot it spoke.
 */
export type ShotDialogueReading = {
  id: string;
  /** `context`: spoken while recording another shot, never adopted here. */
  source: 'recorded' | 'context';
  selected: boolean;
  fromSeconds: number;
  toSeconds: number;
  recordingUrl: string;
  createdAt: Date | string;
  /** False once the shot's lines or voices moved — it cannot be used. */
  matchesCurrentLines: boolean;
};

function voiceLabel(element: SequenceElementMinimal): string {
  const length = formatElementDuration(element.durationSeconds);
  return length ? `${element.token} · ${length}` : element.token;
}

/** What the shot's one audio choice plays: the generated clip or a bound element. */
function shotPlayback(
  lines: readonly DialogueLine[],
  voices: SequenceElementMinimal[],
  clip: DialogueClip | null | undefined
) {
  const value = shotPickerValue(lines);
  const bound = voices.find((el) => el.token === value);
  const generated = value === GENERATED_VOICE;
  return {
    value,
    url: generated ? (clip?.url ?? null) : (bound?.imageUrl ?? null),
    seconds: generated
      ? (clip?.durationSeconds ?? null)
      : (bound?.durationSeconds ?? null),
  };
}

const DialogueLineList: React.FC<{
  lines: readonly DialogueLine[];
  /** One row per line: "CHARACTER — line · tone". */
  compact?: boolean;
}> = ({ lines, compact }) => (
  <ul className={compact ? 'flex flex-col gap-1' : 'flex flex-col gap-2'}>
    {lines.map((line, index) =>
      compact ? (
        <li key={`${line.character}-${index}`} className="text-sm">
          <span className="font-medium">{line.character || 'Narrator'}</span>
          {' — '}
          {line.line}
          {line.tone && (
            <span className="text-muted-foreground"> · {line.tone}</span>
          )}
        </li>
      ) : (
        <li
          key={`${line.character}-${index}`}
          className="flex flex-col gap-1.5"
        >
          <p className="text-sm">
            <span className="font-medium">{line.character || 'Narrator'}</span>
            {line.tone && (
              <span className="text-muted-foreground"> · {line.tone}</span>
            )}
          </p>
          <p className="text-sm text-muted-foreground">“{line.line}”</p>
        </li>
      )
    )}
  </ul>
);

const ShotAudio: React.FC<{ url: string }> = ({ url }) => (
  // oxlint-disable-next-line jsx-a11y/media-has-caption -- generated or uploaded take; the transcript is the lines beside it
  <audio
    controls
    preload="none"
    src={url}
    className="w-full"
    aria-label="Shot dialogue audio"
  />
);

const ReadingRow: React.FC<{
  reading: ShotDialogueReading;
  onUse: (readingId: string) => void;
  usingId?: string | null;
}> = ({ reading, onUse, usingId }) => {
  const recordedAt = new Date(reading.createdAt).toLocaleString();
  const facts = [
    recordedAt,
    formatElementDuration(reading.toSeconds - reading.fromSeconds),
    reading.source === 'context' ? 'Recorded with another shot' : null,
    reading.matchesCurrentLines ? null : 'Lines changed since',
  ].filter(Boolean);
  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {facts.join(' · ')}
        </span>
        {reading.selected ? (
          <span className="flex items-center gap-1 text-xs font-medium">
            <Check className="h-3 w-3" aria-hidden />
            Current
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={usingId != null || !reading.matchesCurrentLines}
            aria-label={`Use reading from ${recordedAt}`}
            onClick={() => onUse(reading.id)}
          >
            {usingId === reading.id ? 'Using…' : 'Use'}
          </Button>
        )}
      </div>
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- a reading of the lines shown beside it */}
      <audio
        controls
        preload="none"
        src={`${reading.recordingUrl}#t=${reading.fromSeconds},${reading.toSeconds}`}
        className="w-full"
        aria-label={`Reading from ${recordedAt}`}
      />
    </li>
  );
};

/**
 * This shot's readings, newest first. Boxed (the prompt editor) it shows
 * only when there is something to pick; `collapsible` (under the video) it
 * always holds its one row, so the block does not move when the list lands.
 */
export const ShotReadingsList: React.FC<{
  readings: ShotDialogueReading[];
  onUse: (readingId: string) => void;
  usingId?: string | null;
  collapsible?: boolean;
}> = ({ readings, onUse, usingId, collapsible }) => {
  const rows = (
    <ul className="flex flex-col gap-3">
      {readings.map((reading) => (
        <ReadingRow
          key={reading.id}
          reading={reading}
          onUse={onUse}
          usingId={usingId}
        />
      ))}
    </ul>
  );
  if (collapsible) {
    if (readings.length === 0) {
      return (
        <p className="flex h-8 items-center text-xs text-muted-foreground">
          No readings yet
        </p>
      );
    }
    return (
      <Collapsible className="flex flex-col gap-2">
        <CollapsibleTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="group h-8 justify-between"
          >
            Readings · {readings.length}
            <ChevronDown
              className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              aria-hidden
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>{rows}</CollapsibleContent>
      </Collapsible>
    );
  }
  if (readings.every((reading) => reading.selected)) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <span className="text-xs font-medium">Readings</span>
      {rows}
    </div>
  );
};

/** Lines, the current audio, then the readings — read-only, under the video. */
export const ShotDialogueBlock: React.FC<{
  dialogue: MotionDialogue | null | undefined;
  elements: SequenceElementMinimal[] | undefined;
  clip?: DialogueClip | null;
  /** The readings list — a slot, so this stays presentational. */
  readings?: React.ReactNode;
}> = ({ dialogue, elements, clip, readings }) => {
  const lines = dialogue?.presence ? dialogue.lines : [];
  if (lines.length === 0) return null;
  const voices = (elements ?? []).filter((el) => el.kind === 'audio');
  const { url } = shotPlayback(lines, voices, clip);
  return (
    <section aria-label="Shot dialogue" className="flex flex-col gap-2">
      <DialogueLineList lines={lines} compact />
      {url ? <ShotAudio url={url} /> : null}
      {readings}
    </section>
  );
};

export const MotionDialoguePanel: React.FC<{
  dialogue: MotionDialogue | null | undefined;
  elements: SequenceElementMinimal[] | undefined;
  /** Null while the model takes no audio at all — the lines still show. */
  onChange: ((next: MotionDialogue) => void) | null;
  disabled?: boolean;
  /** Where the lines come from: the shot's motion prompt, or the scene script before one exists. */
  source: 'prompt' | 'script';
  /** References-stage take for this shot, when one exists. */
  clip?: DialogueClip | null;
  /** Shot duration in seconds — noted only when the take is longer. */
  shotSeconds?: number;
  /** This shot's readings list (#1657) — a slot, so the panel stays presentational. */
  readings?: React.ReactNode;
}> = ({
  dialogue,
  elements,
  onChange,
  disabled,
  source,
  clip,
  shotSeconds,
  readings,
}) => {
  const lines = dialogue?.presence ? dialogue.lines : [];
  if (lines.length === 0) return null;

  const voices = (elements ?? []).filter((el) => el.kind === 'audio');
  const generatedLabel = (() => {
    const length = formatElementDuration(clip?.durationSeconds ?? null);
    return length ? `Generated · ${length}` : 'Generated';
  })();
  const {
    value,
    url: playbackUrl,
    seconds: audioSeconds,
  } = shotPlayback(lines, voices, clip);
  const orphans =
    elements === undefined
      ? []
      : orphanedVoiceTokens(lines, new Set(voices.map((el) => el.token)));
  const voiceItems: Record<string, string> = {
    [GENERATED_VOICE]: generatedLabel,
    [VIDEO_MODEL_VOICE_TOKEN]: 'Video model',
    ...Object.fromEntries(voices.map((el) => [el.token, voiceLabel(el)])),
    ...Object.fromEntries(
      orphans.map((token) => [token, `${token} (deleted)`])
    ),
  };
  const dialogueLonger = dialogueExceedsShotDuration(audioSeconds, shotSeconds);

  const setShotVoice = (next: string) => {
    if (!onChange) return;
    const voiceToken = persistToken(next);
    onChange({
      presence: true,
      lines: lines.map((line) => ({ ...line, voiceToken })),
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">Dialogue</span>
        <span className="text-xs text-muted-foreground">
          {source === 'prompt'
            ? 'Appended to the prompt at render'
            : 'From the script — bind audio once the motion prompt exists'}
        </span>
      </div>
      {(onChange || playbackUrl) && (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          {onChange && (
            <Select
              value={value}
              items={voiceItems}
              onValueChange={(next) => {
                if (typeof next === 'string') setShotVoice(next);
              }}
              disabled={disabled}
            >
              <SelectTrigger
                size="sm"
                className="w-full"
                aria-label="Shot audio"
              >
                <SelectValue placeholder="Generated" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={GENERATED_VOICE}>
                  {generatedLabel}
                </SelectItem>
                <SelectItem value={VIDEO_MODEL_VOICE_TOKEN}>
                  Video model
                </SelectItem>
                {voices.map((el) => (
                  <SelectItem key={el.id} value={el.token}>
                    <span>{voiceLabel(el)}</span>
                  </SelectItem>
                ))}
                {orphans.map((token) => (
                  <SelectItem key={token} value={token}>
                    <span>{token} (deleted)</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {orphans.length > 0 && (
            <p className="text-xs text-warning">
              {orphans.join(', ')} was deleted — pick another source, or this
              shot won't render.
            </p>
          )}
          {dialogueLonger && audioSeconds != null && shotSeconds != null && (
            <p className="text-xs text-muted-foreground">
              Dialogue is {formatElementDuration(audioSeconds)} — this shot is{' '}
              {formatElementDuration(shotSeconds)}. Generate will stretch the
              shot to cover it.
            </p>
          )}
          {playbackUrl ? <ShotAudio url={playbackUrl} /> : null}
        </div>
      )}
      <div className="rounded-md border p-3">
        <DialogueLineList lines={lines} />
      </div>
      {readings}
      {!onChange && source === 'prompt' && (
        <p className="text-xs text-muted-foreground">
          This model generates its own voices — it takes no audio reference.
        </p>
      )}
    </div>
  );
};
