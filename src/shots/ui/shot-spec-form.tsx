/**
 * The shot spec (#1929), one form on the Shot tab (#2350): framing, then
 * motion. Saving rebuilds the prompts from the spec for free. A written
 * prompt is replaced only when the user says so.
 */

import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/platform/errors';
import {
  shotSpecEditSchema,
  specKeyframes,
  type ShotKeyframe,
  type ShotSpecEdit,
  type StoredShotSpec,
} from '@/shots/shot-list.schema';
import {
  CAMERA_ANGLES,
  CAMERA_MOVES,
  MOVE_PACINGS,
  SHOT_SIZES,
} from '@/shots/shot-spec-vocabulary';
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
import { Button } from '@/ui/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { MarkdownEditor } from '@/ui/text-editor/markdown-editor';
import type { MentionItem } from './prompt-mention/mention-items';
import { useSequenceMentionItems } from './use-mention-items';
import { useSaveShotSpec, useShotSpec } from './use-shot-spec';

type Field = {
  name: string;
  label: string;
  read: (spec: StoredShotSpec) => string;
  suggestions?: readonly string[];
};

const FIELDS = {
  shotSize: {
    name: 'shotSize',
    label: 'Shot size',
    read: (s) => s.framing.shotSize,
    suggestions: SHOT_SIZES,
  },
  angle: {
    name: 'angle',
    label: 'Angle',
    read: (s) => s.framing.angle,
    suggestions: CAMERA_ANGLES,
  },
  composition: {
    name: 'composition',
    label: 'Composition',
    read: (s) => s.framing.composition,
  },
  subjectStartState: {
    name: 'subjectStartState',
    label: 'Subject at the start',
    read: (s) => s.framing.subjectStartState,
  },
  action: { name: 'action', label: 'Action', read: (s) => s.action },
  move: {
    name: 'move',
    label: 'Camera move',
    read: (s) => s.cameraMovement.move,
    suggestions: CAMERA_MOVES,
  },
  pacing: {
    name: 'pacing',
    label: 'Pacing',
    read: (s) => s.cameraMovement.pacing,
    suggestions: MOVE_PACINGS,
  },
  direction: {
    name: 'direction',
    label: 'Direction',
    read: (s) => s.direction,
  },
  soundCue: { name: 'soundCue', label: 'Sound', read: (s) => s.soundCue },
} satisfies Record<string, Field>;

const GROUPS: { label: string; fields: Field[] }[] = [
  {
    label: 'Framing',
    fields: [
      FIELDS.shotSize,
      FIELDS.angle,
      FIELDS.composition,
      FIELDS.subjectStartState,
    ],
  },
  {
    label: 'Motion',
    fields: [
      FIELDS.action,
      FIELDS.move,
      FIELDS.pacing,
      FIELDS.direction,
      FIELDS.soundCue,
    ],
  },
];

/** The spec read off the form. A keyframe row with no action is dropped. */
function specFromForm(form: FormData, spec: StoredShotSpec): ShotSpecEdit {
  const value = (name: string, fallback: string) => {
    const entry = form.get(name);
    return typeof entry === 'string' ? entry : fallback;
  };
  const cameras = form
    .getAll('keyframeCamera')
    .map((entry) => (typeof entry === 'string' ? entry : ''));
  return {
    framing: {
      shotSize: value('shotSize', spec.framing.shotSize),
      angle: value('angle', spec.framing.angle),
      composition: value('composition', spec.framing.composition),
      subjectStartState: value(
        'subjectStartState',
        spec.framing.subjectStartState
      ),
    },
    action: value('action', spec.action),
    keyframes: form.getAll('keyframeAction').flatMap((action, index) =>
      typeof action === 'string' && action.trim().length > 0
        ? [
            {
              atSeconds: Number(form.getAll('keyframeAt')[index]),
              action,
              camera: cameras[index] ?? '',
            },
          ]
        : []
    ),
    cameraMovement: {
      move: value('move', spec.cameraMovement.move),
      pacing: value('pacing', spec.cameraMovement.pacing),
    },
    direction: value('direction', spec.direction),
    soundCue: value('soundCue', spec.soundCue),
  };
}

function writtenLabel(visual: boolean, motion: boolean): string {
  if (visual && motion) return 'start frame and video prompts';
  return visual ? 'start frame prompt' : 'video prompt';
}

export function ShotSpecForm({
  sequenceId,
  shotId,
  shotSeconds,
}: {
  sequenceId: string;
  shotId: string;
  shotSeconds: number;
}) {
  const { data } = useShotSpec({ sequenceId, shotId });
  if (!data) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (!data.spec) {
    return (
      <p className="text-xs text-muted-foreground">
        No shot spec yet. Rewrite shot writes one.
      </p>
    );
  }
  return (
    <SpecFields
      // A new spec (a save, a rewrite landing) resets the fields to it.
      key={JSON.stringify(data.spec)}
      sequenceId={sequenceId}
      shotId={shotId}
      shotSeconds={shotSeconds}
      spec={data.spec}
      verdict={data.verdict}
      visualWritten={data.visualWritten}
      motionWritten={data.motionWritten}
    />
  );
}

function SpecFields({
  sequenceId,
  shotId,
  shotSeconds,
  spec,
  verdict,
  visualWritten,
  motionWritten,
}: {
  sequenceId: string;
  shotId: string;
  shotSeconds: number;
  spec: StoredShotSpec;
  verdict: 'current' | 'stale' | 'missing' | 'updating';
  visualWritten: boolean;
  motionWritten: boolean;
}) {
  const save = useSaveShotSpec(sequenceId);
  const { items: mentionItems, onMentionRename } =
    useSequenceMentionItems(sequenceId);
  // Remounts the fields on Cancel, back to the saved spec.
  const [resetCount, setResetCount] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<ShotSpecEdit | null>(null);
  const updating = verdict === 'updating';
  const status = updating
    ? 'Rewriting…'
    : dirty
      ? 'Unsaved changes'
      : verdict === 'stale'
        ? 'Script changed since it was written'
        : '';

  const submit = (next: ShotSpecEdit, replace: boolean) => {
    setPending(null);
    save.mutate(
      {
        shotId,
        spec: next,
        replace: {
          visual: replace && visualWritten,
          motion: replace && motionWritten,
        },
      },
      {
        onSuccess: () => {
          setDirty(false);
          toast.success('Shot spec saved');
        },
        onError: (error) =>
          toast.error('Could not save the shot spec', {
            description: errorMessage(error),
          }),
      }
    );
  };

  return (
    <form
      className="flex flex-col gap-3"
      onReset={() => {
        setDirty(false);
        setResetCount((count) => count + 1);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = shotSpecEditSchema.safeParse(
          specFromForm(new FormData(event.currentTarget), spec)
        );
        if (!parsed.success) {
          toast.error('Could not save the shot spec', {
            description: parsed.error.issues[0]?.message,
          });
          return;
        }
        if (visualWritten || motionWritten) setPending(parsed.data);
        else submit(parsed.data, false);
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Shot spec</h3>
        <span
          className="truncate text-xs text-muted-foreground"
          aria-live="polite"
        >
          {status}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        <fieldset
          className="flex flex-col gap-3"
          disabled={updating || save.isPending}
        >
          {GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-3">
              <span className="text-xs font-medium text-muted-foreground">
                {group.label}
              </span>
              {group.fields.map((field) => (
                <SpecField
                  key={`${field.name}-${resetCount}`}
                  id={`${shotId}-${field.name}`}
                  field={field}
                  initial={field.read(spec)}
                  disabled={updating || save.isPending}
                  mentionItems={mentionItems}
                  onMentionRename={onMentionRename}
                  onEdit={() => setDirty(true)}
                />
              ))}
              {group.label === 'Motion' && (
                <KeyframeFields
                  key={`keyframes-${resetCount}`}
                  initial={specKeyframes(spec)}
                  shotSeconds={shotSeconds}
                  disabled={updating || save.isPending}
                  mentionItems={mentionItems}
                  onMentionRename={onMentionRename}
                  onEdit={() => setDirty(true)}
                />
              )}
            </div>
          ))}
        </fieldset>
        {dirty && (
          <div className="flex items-center justify-end gap-2">
            <Button
              type="reset"
              size="sm"
              variant="outline"
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={save.isPending || updating}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </div>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your written prompt?</AlertDialogTitle>
            <AlertDialogDescription>
              You wrote the {writtenLabel(visualWritten, motionWritten)}.
              Replace it with one built from this spec, or keep your text.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) submit(pending, false);
              }}
            >
              Keep mine
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                if (pending) submit(pending, true);
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

/** One spec field: grows with its text and shows cast and elements as pills. */
function SpecField({
  id,
  field,
  initial,
  disabled,
  mentionItems,
  onMentionRename,
  onEdit,
}: {
  id: string;
  field: Field;
  initial: string;
  disabled: boolean;
  mentionItems: MentionItem[];
  onMentionRename: (item: MentionItem, name: string) => void;
  onEdit: () => void;
}) {
  const [value, setValue] = useState(initial);
  // The editor re-emits on mount; only a change after focus is an edit.
  const focused = useRef(false);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="text-xs">{field.label}</span>
        {field.suggestions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={disabled}
                aria-label={`${field.label} presets`}
              >
                Presets
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72">
              {field.suggestions.map((option) => (
                <DropdownMenuItem
                  key={option}
                  onSelect={() => {
                    setValue(option);
                    onEdit();
                  }}
                >
                  {option}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <MarkdownEditor
        id={id}
        aria-label={field.label}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          if (focused.current) onEdit();
        }}
        onFocus={() => {
          focused.current = true;
        }}
        disabled={disabled}
        // Preset fields hold a phrase: one row, growing with the text.
        className={field.suggestions ? 'min-h-9 py-1.5' : undefined}
        mentionItems={mentionItems}
        onMentionRename={onMentionRename}
      />
      <input type="hidden" name={field.name} value={value} />
    </div>
  );
}

type KeyframeRow = {
  key: number;
  at: string;
  action: string;
  camera: string;
};

/** Keyframes (#2386): the timed actions of a long take, one row each. */
function KeyframeFields({
  initial,
  shotSeconds,
  disabled,
  mentionItems,
  onMentionRename,
  onEdit,
}: {
  initial: readonly ShotKeyframe[];
  shotSeconds: number;
  disabled: boolean;
  mentionItems: MentionItem[];
  onMentionRename: (item: MentionItem, name: string) => void;
  onEdit: () => void;
}) {
  const [rows, setRows] = useState<KeyframeRow[]>(() =>
    initial.map((keyframe, key) => ({
      key,
      at: String(keyframe.atSeconds),
      action: keyframe.action,
      camera: keyframe.camera,
    }))
  );
  const nextKey = useRef(initial.length);
  // The editor re-emits on mount; only a change after focus is an edit.
  const focused = useRef(false);
  const lastSecond = Math.max(0, Math.ceil(shotSeconds) - 1);
  const change = (next: KeyframeRow[]) => {
    setRows(next);
    onEdit();
  };
  const patch = (key: number, fields: Partial<KeyframeRow>) =>
    rows.map((row) => (row.key === key ? { ...row, ...fields } : row));
  // Every whole second of the shot, plus any stored time off that grid.
  const seconds = [
    ...new Set([
      ...Array.from({ length: lastSecond + 1 }, (_, second) => second),
      ...rows.map((row) => Number(row.at)),
    ]),
  ].sort((a, b) => a - b);
  // Whole seconds no row holds; a new row takes one about 3s on.
  const taken = new Set(rows.map((row) => Number(row.at)));
  const free = Array.from(
    { length: lastSecond + 1 },
    (_, second) => second
  ).filter((second) => !taken.has(second));
  const lastAt = Number(rows.at(-1)?.at ?? -3);
  const nextAt =
    free.find((second) => second >= lastAt + 3) ??
    free.filter((second) => second > lastAt).at(-1) ??
    free[0];
  const items = seconds.map((second) => ({
    value: String(second),
    label: `${second}s`,
  }));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="text-xs">Keyframes</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled || nextAt === undefined}
          onClick={() => {
            if (nextAt === undefined) return;
            change([
              ...rows,
              {
                key: nextKey.current++,
                at: String(nextAt),
                action: '',
                camera: '',
              },
            ]);
          }}
        >
          Add keyframe
        </Button>
      </div>
      {rows.map((row, index) => (
        <div key={row.key} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <Select
              name="keyframeAt"
              value={row.at}
              items={items}
              onValueChange={(value) => {
                if (value != null) change(patch(row.key, { at: value }));
              }}
              disabled={disabled}
            >
              <SelectTrigger
                size="sm"
                className="w-20 tabular-nums"
                aria-label={`Keyframe ${index + 1} starts at`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                change(rows.filter((other) => other.key !== row.key))
              }
              aria-label={`Remove keyframe ${index + 1}`}
            >
              <X aria-hidden />
            </Button>
          </div>
          <MarkdownEditor
            aria-label={`Keyframe ${index + 1} action`}
            placeholder="What happens from this second"
            value={row.action}
            onValueChange={(action) => {
              const next = patch(row.key, { action });
              if (focused.current) change(next);
              else setRows(next);
            }}
            onFocus={() => {
              focused.current = true;
            }}
            disabled={disabled}
            mentionItems={mentionItems}
            onMentionRename={onMentionRename}
          />
          <input type="hidden" name="keyframeAction" value={row.action} />
          <MarkdownEditor
            aria-label={`Keyframe ${index + 1} camera`}
            placeholder="Where the camera is in this stage"
            value={row.camera}
            onValueChange={(camera) => {
              const next = patch(row.key, { camera });
              if (focused.current) change(next);
              else setRows(next);
            }}
            onFocus={() => {
              focused.current = true;
            }}
            disabled={disabled}
            className="min-h-9 py-1.5"
            mentionItems={mentionItems}
            onMentionRename={onMentionRename}
          />
          <input type="hidden" name="keyframeCamera" value={row.camera} />
        </div>
      ))}
    </div>
  );
}
