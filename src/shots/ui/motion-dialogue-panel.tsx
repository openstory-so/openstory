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
 */

import { formatElementDuration } from '@/cast/element-kind';
import {
  DIALOGUE_CLIP_TOKEN,
  VIDEO_MODEL_VOICE_TOKEN,
  isElementVoiceToken,
} from '@/motion/dialogue-tts';
import type { SequenceElementMinimal } from '@/platform/server/db/schema';
import type {
  DialogueLine,
  MotionDialogue,
} from '@/shots/scene-analysis.schema';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';

/** UI-only: persist as no `voiceToken` so Text to Dialogue still runs. */
const GENERATED_VOICE = '__generated__';

type DialogueClip = {
  url: string;
  durationSeconds: number | null;
};

function voiceLabel(element: SequenceElementMinimal): string {
  const length = formatElementDuration(element.durationSeconds);
  return length ? `${element.token} · ${length}` : element.token;
}

function tokenToPickerValue(voiceToken: string | undefined): string {
  if (!voiceToken || voiceToken === DIALOGUE_CLIP_TOKEN) return GENERATED_VOICE;
  if (voiceToken === VIDEO_MODEL_VOICE_TOKEN) return VIDEO_MODEL_VOICE_TOKEN;
  return voiceToken;
}

/** One value for the shot. Mixed legacy per-line bindings read as Generated. */
function shotPickerValue(lines: readonly DialogueLine[]): string {
  const first = tokenToPickerValue(lines[0]?.voiceToken);
  return lines.every((line) => tokenToPickerValue(line.voiceToken) === first)
    ? first
    : GENERATED_VOICE;
}

function persistToken(value: string): string | undefined {
  if (value === GENERATED_VOICE) return undefined;
  if (value === VIDEO_MODEL_VOICE_TOKEN) return VIDEO_MODEL_VOICE_TOKEN;
  return value;
}

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
}> = ({ dialogue, elements, onChange, disabled, source, clip }) => {
  const lines = dialogue?.presence ? dialogue.lines : [];
  if (lines.length === 0) return null;

  const voices = (elements ?? []).filter((el) => el.kind === 'audio');
  const generatedLabel = (() => {
    const length = formatElementDuration(clip?.durationSeconds ?? null);
    return length ? `Generated · ${length}` : 'Generated';
  })();
  const voiceItems: Record<string, string> = {
    [GENERATED_VOICE]: generatedLabel,
    [VIDEO_MODEL_VOICE_TOKEN]: 'Video model',
    ...Object.fromEntries(voices.map((el) => [el.token, voiceLabel(el)])),
  };

  const value = shotPickerValue(lines);
  const boundElement = voices.find((el) => el.token === value);
  const elementToken = isElementVoiceToken(
    value === GENERATED_VOICE || value === VIDEO_MODEL_VOICE_TOKEN
      ? undefined
      : value
  );
  const orphaned = elements !== undefined && elementToken && !boundElement;
  const playbackUrl =
    value === GENERATED_VOICE
      ? (clip?.url ?? null)
      : (boundElement?.imageUrl ?? null);

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
              value={orphaned ? GENERATED_VOICE : value}
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
              </SelectContent>
            </Select>
          )}
          {orphaned && (
            <p className="text-xs text-warning">
              {value} was deleted — pick another source, or this shot won't
              render.
            </p>
          )}
          {playbackUrl ? (
            // oxlint-disable-next-line jsx-a11y/media-has-caption -- generated or uploaded take; the transcript is the lines below
            <audio
              controls
              preload="none"
              src={playbackUrl}
              className="w-full"
              aria-label="Shot dialogue audio"
            />
          ) : null}
        </div>
      )}
      <ul className="flex flex-col gap-2 rounded-md border p-3">
        {lines.map((line, index) => (
          <li
            key={`${line.character}-${index}`}
            className="flex flex-col gap-1.5"
          >
            <p className="text-sm">
              <span className="font-medium">
                {line.character || 'Narrator'}
              </span>
              {line.tone && (
                <span className="text-muted-foreground"> · {line.tone}</span>
              )}
            </p>
            <p className="text-sm text-muted-foreground">“{line.line}”</p>
          </li>
        ))}
      </ul>
      {!onChange && source === 'prompt' && (
        <p className="text-xs text-muted-foreground">
          This model generates its own voices — it takes no audio reference.
        </p>
      )}
    </div>
  );
};
