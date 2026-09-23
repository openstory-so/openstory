/**
 * The dialogue an audio-capable video model will be told to speak (#1559).
 *
 * The lines are the shot's dialogue node (`shot_dialogue_versions`; the
 * script only seeds it), edited in place through the `lines` slot (#1773). Audio is one choice
 * for the whole shot (#1554): the generated take, a user-uploaded audio
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
  dialogueModelLabel,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/shadcn/alert-dialog';
import { Badge } from '@/ui/shadcn/badge';
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
import { Input } from '@/ui/shadcn/input';
import { Textarea } from '@/ui/shadcn/textarea';
import { Check, ChevronDown, Loader2, Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';

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
  /** The model the recording ran on (`ttsModel` of its turns). */
  model: string;
  createdAt: Date | string;
  /** False once the shot's lines or voices moved — it cannot be used. */
  matchesCurrentLines: boolean;
  /** Why it no longer matches: the words moved, or only the voice did. */
  mismatch: 'lines' | 'voice' | null;
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

/**
 * Who speaks the lines when it is not the generated reading (#1773): the
 * reading is then not in use, so it can be neither out of date nor worth
 * regenerating. Null on Generated.
 */
export function shotSpokenByNote(
  lines: readonly DialogueLine[]
): string | null {
  const value = shotPickerValue(lines);
  if (lines.length === 0 || value === GENERATED_VOICE) return null;
  return value === VIDEO_MODEL_VOICE_TOKEN
    ? 'Video model speaks the lines'
    : `${value} speaks the lines`;
}

/** One row of the editor: the line it started as (null = added here). */
type EditorRow = { key: number; line: DialogueLine | null };

const toRows = (lines: readonly DialogueLine[]): EditorRow[] =>
  lines.map((line, index) => ({ key: index, line }));

/**
 * The shot's lines, editable in place (#1773): character, words, tone. Reads
 * as the plain list until Edit. Save hands back the whole set; each line keeps
 * its voice binding, and an added line takes the shot's current audio source.
 */
export const DialogueLinesEditor: React.FC<{
  lines: readonly DialogueLine[];
  onSave: (lines: DialogueLine[]) => void;
  saving?: boolean;
  /** Label for the Edit button, e.g. "Edit lines for shot 3". */
  label?: string;
}> = ({ lines, onSave, saving, label = 'Edit lines' }) => {
  const [rows, setRows] = useState<EditorRow[] | null>(null);
  const [nextKey, setNextKey] = useState(lines.length);
  const editing = rows !== null;

  if (!editing) {
    return (
      <div className="flex flex-col gap-2">
        {lines.length > 0 ? (
          <DialogueLineList lines={lines} />
        ) : (
          <p className="text-sm text-muted-foreground">No lines</p>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          aria-label={label}
          onClick={() => {
            setRows(toRows(lines));
            setNextKey(lines.length);
          }}
        >
          <Pencil className="h-3 w-3" aria-hidden />
          Edit
        </Button>
      </div>
    );
  }

  const shotToken = lines[0]?.voiceToken;
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = (name: string) => form.getAll(name).map(String);
    const [characters, words, tones] = [
      read('character'),
      read('line'),
      read('tone'),
    ];
    const next = rows.flatMap((row, index) => {
      const text = (words[index] ?? '').trim();
      if (!text) return [];
      const base = row.line ?? { voiceToken: shotToken };
      return [
        {
          ...base,
          character: (characters[index] ?? '').trim(),
          line: text,
          tone: (tones[index] ?? '').trim(),
        },
      ];
    });
    onSave(next);
    setRows(null);
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {rows.map((row, index) => (
          <li key={row.key} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Input
                name="character"
                defaultValue={row.line?.character ?? ''}
                placeholder="Character"
                aria-label={`Line ${index + 1} character`}
                autoComplete="off"
              />
              <Input
                name="tone"
                defaultValue={row.line?.tone ?? ''}
                placeholder="Tone"
                aria-label={`Line ${index + 1} tone`}
                autoComplete="off"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove line ${index + 1}`}
                onClick={() =>
                  setRows(rows.filter((other) => other.key !== row.key))
                }
              >
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <Textarea
              name="line"
              defaultValue={row.line?.line ?? ''}
              placeholder="What they say"
              aria-label={`Line ${index + 1} words`}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={2}
            />
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setRows([...rows, { key: nextKey, line: null }]);
            setNextKey(nextKey + 1);
          }}
        >
          <Plus className="h-3 w-3" aria-hidden />
          Add line
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRows(null)}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </form>
  );
};

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
  onDiscard: (reading: ShotDialogueReading) => void;
  usingId?: string | null;
}> = ({ reading, onUse, onDiscard, usingId }) => {
  const recordedAt = new Date(reading.createdAt).toLocaleString();
  const facts = [
    recordedAt,
    formatElementDuration(reading.toSeconds - reading.fromSeconds),
    reading.source === 'context' ? 'Generated with another shot' : null,
    reading.mismatch === 'voice'
      ? 'Voice changed since'
      : reading.mismatch === 'lines'
        ? 'Lines changed since'
        : null,
  ].filter(Boolean);
  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{dialogueModelLabel(reading.model)}</Badge>
          {facts.join(' · ')}
        </span>
        <div className="flex items-center gap-1">
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
          <Button
            size="sm"
            variant="ghost"
            disabled={usingId != null}
            aria-label={`Discard reading from ${recordedAt}`}
            onClick={() => onDiscard(reading)}
          >
            Discard
          </Button>
        </div>
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
 * only when there is something to pick or the current one went stale;
 * `collapsible` (under the video) it always holds its one row, so the block
 * does not move when the list lands.
 */
export const ShotReadingsList: React.FC<{
  readings: ShotDialogueReading[];
  onUse: (readingId: string) => void;
  onDiscard: (readingId: string) => void;
  usingId?: string | null;
  collapsible?: boolean;
}> = ({ readings, onUse, onDiscard, usingId, collapsible }) => {
  const [pendingDiscard, setPendingDiscard] =
    useState<ShotDialogueReading | null>(null);
  const rows = (
    <>
      <ul className="flex flex-col gap-3">
        {readings.map((reading) => (
          <ReadingRow
            key={reading.id}
            reading={reading}
            onUse={onUse}
            onDiscard={setPendingDiscard}
            usingId={usingId}
          />
        ))}
      </ul>
      <AlertDialog
        open={pendingDiscard !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDiscard(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this reading?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDiscard?.selected
                ? 'It is the shot’s current audio. The next render records a new one.'
                : 'It leaves this list. The recording it came from is kept.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDiscard) onDiscard(pendingDiscard.id);
                setPendingDiscard(null);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
  // A lone current reading says nothing new — unless it no longer matches
  // (the voice or the lines moved), which is the one fact worth a row.
  if (readings.every((r) => r.selected && r.matchesCurrentLines)) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <span className="text-xs font-medium">Readings</span>
      {rows}
    </div>
  );
};

/** A dialogue recording in flight for this shot (#1657). */
export type ShotDialogueClaimRow = {
  id: string;
  /** False once the user acted: it still records, but will not take over. */
  willBecomeCurrent: boolean;
};

/**
 * "Generating…" — one row per recording in flight, with the same way out every
 * other generation has. Cancel does not stop the run (it records the scene for
 * other shots too); it stops the reading from becoming this shot's audio.
 */
export const ShotRecordingsInFlight: React.FC<{
  claims: ShotDialogueClaimRow[];
  onCancel: (claimId: string) => void;
  cancellingId?: string | null;
}> = ({ claims, onCancel, cancellingId }) => {
  if (claims.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" aria-live="polite">
      {claims.map((claim) => (
        <li
          key={claim.id}
          className="flex min-h-8 items-center justify-between gap-2"
        >
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2
              className="h-3 w-3 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            {claim.willBecomeCurrent
              ? 'Generating…'
              : 'Generating… will not replace the current audio'}
          </span>
          {claim.willBecomeCurrent ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={cancellingId != null}
              onClick={() => onCancel(claim.id)}
            >
              {cancellingId === claim.id ? 'Cancelling…' : 'Cancel'}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
};

/** One authored version of a shot's lines, as the history list shows it. */
export type ShotDialogueVersionRow = {
  id: string;
  source: 'prompt' | 'user-edit';
  createdAt: Date | string;
  selected: boolean;
  lines: readonly { character: string; line: string }[];
  /** Same words as the version before it: only the audio source moved (#1773). */
  voiceOnly: boolean;
};

const DIALOGUE_VERSION_SOURCE_LABELS = {
  prompt: 'From the script',
  'user-edit': 'Edited',
} as const;

/**
 * Every set of lines this shot has held (#1657), newest first, with a way
 * back. Hidden until there is something to go back to.
 */
export const ShotDialogueHistory: React.FC<{
  versions: ShotDialogueVersionRow[];
  onUse: (versionId: string) => void;
  usingId?: string | null;
}> = ({ versions, onUse, usingId }) => {
  if (versions.length < 2) return null;
  return (
    <section
      className="flex flex-col gap-2 rounded-md border p-3"
      aria-label="Dialogue history"
    >
      <span className="text-xs font-medium">History</span>
      <ul className="flex flex-col gap-1">
        {versions.map((version) => {
          const created = new Date(version.createdAt);
          const said =
            version.lines.length === 0
              ? 'No lines'
              : version.lines.map((line) => `“${line.line}”`).join(' ');
          return (
            <li
              key={version.id}
              className="flex min-h-8 items-center justify-between gap-2"
              aria-current={version.selected ? 'true' : undefined}
            >
              <div className="flex min-w-0 flex-col">
                <p className="text-xs font-medium">
                  {version.voiceOnly
                    ? 'Audio source changed'
                    : DIALOGUE_VERSION_SOURCE_LABELS[version.source]}{' '}
                  <time
                    dateTime={created.toISOString()}
                    className="font-normal text-muted-foreground"
                  >
                    {created.toLocaleString()}
                  </time>
                </p>
                <p className="truncate text-xs text-muted-foreground">{said}</p>
              </div>
              {version.selected ? (
                <span className="flex items-center gap-1 text-xs font-medium">
                  <Check className="h-3 w-3" aria-hidden />
                  Current
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={usingId != null}
                  aria-label={`Use lines from ${created.toLocaleString()}`}
                  onClick={() => onUse(version.id)}
                >
                  {usingId === version.id ? 'Using…' : 'Use'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
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
  /** The lines, editable (#1773) — a slot in place of the read-only list. */
  lineEditor?: React.ReactNode;
}> = ({
  dialogue,
  elements,
  onChange,
  disabled,
  source,
  clip,
  shotSeconds,
  readings,
  lineEditor,
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
        {lineEditor ?? <DialogueLineList lines={lines} />}
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
