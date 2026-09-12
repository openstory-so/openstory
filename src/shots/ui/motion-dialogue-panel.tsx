/**
 * The dialogue an audio-capable video model will be told to speak (#1559).
 *
 * It was invisible before this: the LLM extracts dialogue into
 * `shot_prompt_versions.dialogue`, `assembleMotionPrompt` appends it at render
 * time, and the prompt box shows only `fullPrompt` — so the only surface a
 * line ever appeared on was the collapsed optimised-prompt preview. A user
 * could not tell whether a line was captured, mis-attributed, or dropped.
 *
 * Lines are READ-ONLY: they come from the script, so the script is where they
 * are fixed, and an editable copy here would be a second source of truth for
 * the same words. The one thing this panel owns is the VOICE — which audio
 * element supplies a character's timbre — because nothing else in the app can
 * express that, and the reference file is useless to the model until a line
 * claims it.
 *
 * Before the shot has a motion prompt the caller hands in the scene's own
 * lines instead (#1585): they exist from the Script stage, so a misattributed
 * speaker is visible before anything downstream is billed. Voice binding
 * waits for the prompt row it is stored on, so `onChange` is null then.
 */

import { formatElementDuration } from '@/cast/element-kind';
import type { SequenceElementMinimal } from '@/platform/server/db/schema';
import type { MotionDialogue } from '@/shots/scene-analysis.schema';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';

/** The sentinel `<SelectItem>` value for "no voice bound" — an empty value is not selectable. */
const NO_VOICE = '__none__';

/** "SARAH_VOICE · 6s" — the token, and how long the file runs when we know. */
function voiceLabel(element: SequenceElementMinimal): string {
  const length = formatElementDuration(element.durationSeconds);
  return length ? `${element.token} · ${length}` : element.token;
}

export const MotionDialoguePanel: React.FC<{
  dialogue: MotionDialogue | null | undefined;
  elements: SequenceElementMinimal[] | undefined;
  /** Null while the model takes no audio at all — the lines still show. */
  onChange: ((next: MotionDialogue) => void) | null;
  disabled?: boolean;
  /** Where the lines come from: the shot's motion prompt, or the scene script before one exists. */
  source?: 'prompt' | 'script';
}> = ({ dialogue, elements, onChange, disabled, source = 'prompt' }) => {
  const lines = dialogue?.presence ? dialogue.lines : [];
  if (lines.length === 0) return null;

  // Only audio elements can carry a voice. A clip or a still in this list
  // would bind to a slot the endpoint rejects.
  const voices = (elements ?? []).filter((el) => el.kind === 'audio');
  const voiceItems: Record<string, string> = {
    [NO_VOICE]: 'Model\u2019s own voice',
    ...Object.fromEntries(voices.map((el) => [el.token, voiceLabel(el)])),
  };

  const setVoice = (index: number, token: string | undefined) => {
    if (!onChange) return;
    onChange({
      presence: true,
      lines: lines.map((line, i) =>
        i === index ? { ...line, voiceToken: token } : line
      ),
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">Dialogue</span>
        <span className="text-xs text-muted-foreground">
          {source === 'prompt'
            ? 'Appended to the prompt at render'
            : 'From the script — bind voices once the motion prompt exists'}
        </span>
      </div>
      <ul className="flex flex-col gap-2 rounded-md border p-3">
        {lines.map((line, index) => {
          // A line can outlive its voice: delete the element and the binding
          // still names it. The picker must never hold a value none of its
          // options has — Base UI then ignores the next pick, which is how a
          // new upload could not be chosen at all (#1559) — so an orphaned
          // binding shows as unbound, and the line says what happened.
          const bound = voices.some((el) => el.token === line.voiceToken);
          // `elements` is undefined until the list loads, and every binding
          // looks deleted until then — which flashed the warning on refresh.
          const orphaned =
            elements !== undefined && Boolean(line.voiceToken) && !bound;
          return (
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
              {orphaned && (
                <p className="text-xs text-warning">
                  {line.voiceToken} was deleted — pick another voice, or this
                  shot won't render.
                </p>
              )}
              {onChange && voices.length > 0 && (
                <Select
                  value={bound ? line.voiceToken : NO_VOICE}
                  // Base UI renders the raw value in the trigger unless it has
                  // labels to map it to — without this it showed `__none__`.
                  items={voiceItems}
                  onValueChange={(value) =>
                    setVoice(
                      index,
                      typeof value === 'string' && value !== NO_VOICE
                        ? value
                        : undefined
                    )
                  }
                  disabled={disabled}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full"
                    aria-label={`Voice for ${line.character || 'Narrator'}`}
                  >
                    <SelectValue placeholder="Model's own voice" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_VOICE}>
                      Model&rsquo;s own voice
                    </SelectItem>
                    {voices.map((el) => (
                      <SelectItem key={el.id} value={el.token}>
                        <span>{voiceLabel(el)}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </li>
          );
        })}
      </ul>
      {onChange && voices.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Upload an audio element to give a character a voice.
        </p>
      )}
      {!onChange && source === 'prompt' && (
        <p className="text-xs text-muted-foreground">
          This model generates its own voices — it takes no audio reference.
        </p>
      )}
    </div>
  );
};
