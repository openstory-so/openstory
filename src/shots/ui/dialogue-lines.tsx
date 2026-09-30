/**
 * A shot's lines as every dialogue list shows them (#1802): who says what,
 * with Record and Edit beside each line. The tone shows only while a line is
 * edited. The shot under its video, the Script tab and the list under the
 * sequence player all use it, and all play through `useDialoguePlayer`.
 *
 * Per shot, not per word: a playing shot marks all its lines, because nothing
 * records where a word falls in a clip.
 */

import {
  matchingDialogueClips,
  voicedDialogueLines,
  type VoiceCharacter,
} from '@/motion/dialogue-tts';
import { bytesToBase64 } from '@/platform/base64';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { DialogueLine } from '@/shots/scene-analysis.schema';
import {
  recordShotDialogueLineFn,
  saveShotDialogueFn,
} from '@/shots/shot-dialogue.fn';
import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
import { Textarea } from '@/ui/shadcn/textarea';
import { cn } from '@/ui/utils';
import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  LineTakeButton,
  LineTakeReview,
  type MicTake,
  useMicTake,
} from './line-take-recorder';
import { decodeTake, floatToPcm16, MIC_TAKE_SAMPLE_RATE } from './mic-take';
import { shotSpokenByNote } from './motion-dialogue-panel';
import { segmentKeys } from './use-segments';
import { shotStalenessNamespace } from './use-shot-staleness';
import { shotKeys } from './use-shots';

/**
 * Everything that reads a shot's lines, after they moved (a restore or an
 * edit): its history, which readings match, `shot.dialogue` on the shots list,
 * and the video rendered from the old lines.
 */
export const invalidateLinesMoved = (
  queryClient: QueryClient,
  sequenceId: string,
  shotId: string
) =>
  Promise.all([
    queryClient.invalidateQueries({
      queryKey: shotKeys.dialogueVersions(shotId),
    }),
    queryClient.invalidateQueries({
      queryKey: shotKeys.dialogueSections(shotId),
    }),
    queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) }),
    queryClient.invalidateQueries({ queryKey: segmentKeys.list(sequenceId) }),
    queryClient.invalidateQueries({ queryKey: shotKeys.detail(shotId) }),
    queryClient.invalidateQueries({ queryKey: shotStalenessNamespace }),
  ]);

/**
 * Save one shot's lines (#1773): a `user-edit` version of that shot only —
 * no prompt row, no other shot.
 */
export function useSaveShotLines(sequenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { shotId: string; lines: DialogueLine[] }) =>
      saveShotDialogueFn({ data: { sequenceId, ...input } }),
    onSuccess: (_, input) =>
      invalidateLinesMoved(queryClient, sequenceId, input.shotId),
    onError: (error: Error) =>
      toast.error('Lines not saved', { description: error.message }),
  });
}

/** A line at the mic (#1802), sent on Use; one take at a time on screen. */
export function useLineTake(sequenceId: string): MicTake {
  const queryClient = useQueryClient();
  return useMicTake(async ({ shotId, index }, blob) => {
    try {
      const pcm = floatToPcm16(await decodeTake(blob));
      await recordShotDialogueLineFn({
        data: {
          sequenceId,
          shotId,
          lineIndex: index,
          pcmBase64: bytesToBase64(pcm),
          sampleRate: MIC_TAKE_SAMPLE_RATE,
        },
      });
      await queryClient.invalidateQueries({
        queryKey: shotKeys.dialogueClaims(shotId),
      });
    } catch (error) {
      toast.error('Line not recorded', {
        description: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

/**
 * Which lines take a Record button: a line with a voice, on a shot whose
 * audio is Generated. A take is spliced into the shot's current reading, so a
 * shot with more than one voiced line needs a clip that still matches them —
 * the same rule `recordShotDialogueLineFn` enforces.
 */
export function recordableLines(
  lines: readonly DialogueLine[],
  clips: readonly MotionAudioClip[] | null | undefined,
  characters: readonly VoiceCharacter[]
): Map<number, string | null> {
  if (shotSpokenByNote(lines)) return new Map();
  const voiced = voicedDialogueLines(
    { presence: true, lines: [...lines] },
    characters
  );
  const blockedBecause =
    voiced.length > 1 && matchingDialogueClips(clips, voiced).length === 0
      ? 'Generate dialogue first — a line is recorded into the current reading'
      : null;
  return new Map(voiced.map((line) => [line.index, blockedBecause]));
}

type PlayerClip = { shotId: string; url: string };

/**
 * Plays shots' dialogue clips one after another, off screen. `playingShotId`
 * is the shot being heard, so its lines can be marked.
 */
export function useDialoguePlayer() {
  const [heard, setHeard] = useState<{
    clips: PlayerClip[];
    index: number;
  } | null>(null);
  const clip = heard?.clips[heard.index];
  const next = () =>
    setHeard((h) =>
      h && h.index + 1 < h.clips.length ? { ...h, index: h.index + 1 } : null
    );
  return {
    playingShotId: clip?.shotId,
    play: (clips: PlayerClip[]) => setHeard({ clips, index: 0 }),
    stop: () => setHeard(null),
    audio: clip ? (
      // oxlint-disable-next-line jsx-a11y/media-has-caption -- the lines it speaks are marked on screen
      <audio
        key={`${heard.index}-${clip.url}`}
        src={clip.url}
        autoPlay
        onEnded={next}
        onError={next}
        className="hidden"
      />
    ) : null,
  };
}

export type DialoguePlayer = ReturnType<typeof useDialoguePlayer>;

/** Play dialogue / Stop for a run of clips. `label` names what plays. */
export const PlayDialogueButton: React.FC<{
  player: DialoguePlayer;
  clips: PlayerClip[];
  label: string;
}> = ({ player, clips, label }) => {
  const playing =
    player.playingShotId !== undefined &&
    clips.some((clip) => clip.shotId === player.playingShotId);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={clips.length === 0}
      aria-label={
        playing ? `Stop dialogue for ${label}` : `Play dialogue for ${label}`
      }
      onClick={() => (playing ? player.stop() : player.play(clips))}
    >
      {playing ? 'Stop' : 'Play dialogue'}
    </Button>
  );
};

/** Select value for a line nobody could attribute (an empty `character`). */
const NO_SPEAKER = '__none__';

/** A form field's text; a file (never sent here) reads as empty. */
const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * Who says a line: one of the cast. A speaker no longer in the cast (renamed
 * or removed) stays pickable, so opening the editor never changes a line.
 */
const SpeakerSelect: React.FC<{
  speakers: readonly string[];
  current: string;
  label: string;
}> = ({ speakers, current, label }) => {
  const names =
    current && !speakers.includes(current) ? [...speakers, current] : speakers;
  const items: Record<string, string> = {
    [NO_SPEAKER]: 'Unattributed',
    ...Object.fromEntries(names.map((name) => [name, name])),
  };
  return (
    <Select name="character" defaultValue={current || NO_SPEAKER} items={items}>
      <SelectTrigger className="w-full" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {names.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
        <SelectItem value={NO_SPEAKER}>Unattributed</SelectItem>
      </SelectContent>
    </Select>
  );
};

/** One line, edited in place: speaker, tone, words. */
const LineForm: React.FC<{
  line: DialogueLine | null;
  label: string;
  speakers: readonly string[];
  saving: boolean;
  onSave: (line: Pick<DialogueLine, 'character' | 'line' | 'tone'>) => void;
  /** Null for a line being added. */
  onRemove: (() => void) | null;
  onCancel: () => void;
}> = ({ line, label, speakers, saving, onSave, onRemove, onCancel }) => (
  <form
    className="flex flex-col gap-2 rounded-md border p-3"
    onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      onSave({
        character:
          field(form, 'character') === NO_SPEAKER
            ? ''
            : field(form, 'character'),
        line: field(form, 'line'),
        tone: field(form, 'tone'),
      });
    }}
  >
    <div className="flex items-center gap-2">
      <SpeakerSelect
        speakers={speakers}
        current={line?.character ?? ''}
        label={`${label} character`}
      />
      <Input
        name="tone"
        defaultValue={line?.tone ?? ''}
        placeholder="Tone"
        aria-label={`${label} tone`}
        autoComplete="off"
      />
    </div>
    <Textarea
      name="line"
      defaultValue={line?.line ?? ''}
      placeholder="What they say"
      aria-label={`${label} words`}
      required
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }}
      rows={2}
    />
    <div className="flex items-center justify-between gap-2">
      {onRemove ? (
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  </form>
);

/**
 * One shot's lines. Each save hands back the shot's whole set with one line
 * changed; an added line takes the shot's current audio source.
 */
export const DialogueLineRows: React.FC<{
  shotId: string;
  lines: readonly DialogueLine[];
  /** This shot's audio is playing. */
  active: boolean;
  speakers: readonly string[];
  onSave: (lines: DialogueLine[]) => void;
  saving: boolean;
  /** Null where no line can be recorded here. */
  take: MicTake | null;
  /** Line index → why it cannot be recorded now (null: it can). Absent: no Record. */
  recordable: ReadonlyMap<number, string | null>;
  /** Offer Add line under the lines. */
  canAdd?: boolean;
}> = ({
  shotId,
  lines,
  active,
  speakers,
  onSave,
  saving,
  take,
  recordable,
  canAdd,
}) => {
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const save = (next: DialogueLine[]) => {
    onSave(next);
    setEditing(null);
  };
  return (
    <div className="flex flex-col gap-1">
      {lines.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {lines.map((line, index) => {
            const name = line.character || 'Narrator';
            const ref = { shotId, index };
            if (editing === index) {
              return (
                <li key={`${shotId}-${index}`}>
                  <LineForm
                    line={line}
                    label={`Line ${index + 1}`}
                    speakers={speakers}
                    saving={saving}
                    onSave={(edit) =>
                      save(
                        lines.map((other, at) =>
                          at === index ? { ...other, ...edit } : other
                        )
                      )
                    }
                    onRemove={() => save(lines.filter((_, at) => at !== index))}
                    onCancel={() => setEditing(null)}
                  />
                </li>
              );
            }
            const blockedBecause = recordable.get(index);
            return (
              <li key={`${shotId}-${index}`} className="flex flex-col gap-1">
                <div
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm',
                    active && 'bg-accent'
                  )}
                >
                  <p>
                    <span className="font-medium">{name}</span>{' '}
                    <span className="text-muted-foreground">“{line.line}”</span>
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    {take && blockedBecause !== undefined ? (
                      <LineTakeButton
                        take={take}
                        line={ref}
                        name={name}
                        blockedBecause={blockedBecause}
                      />
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit ${name}'s line`}
                      disabled={editing !== null}
                      onClick={() => setEditing(index)}
                    >
                      Edit
                    </Button>
                  </div>
                </div>
                {take ? (
                  <LineTakeReview take={take} line={ref} name={name} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-2 py-1 text-sm text-muted-foreground">No lines</p>
      )}
      {editing === 'new' ? (
        <LineForm
          line={null}
          label={`Line ${lines.length + 1}`}
          speakers={speakers}
          saving={saving}
          onSave={(added) =>
            save([...lines, { ...added, voiceToken: lines[0]?.voiceToken }])
          }
          onRemove={null}
          onCancel={() => setEditing(null)}
        />
      ) : canAdd ? (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          disabled={editing !== null}
          onClick={() => setEditing('new')}
        >
          Add line
        </Button>
      ) : null}
    </div>
  );
};
