/**
 * The shot spec (#1929), one form on the Shot tab (#2350): framing, then
 * motion. Saving rebuilds the prompts from the spec for free. A written
 * prompt is replaced only when the user says so.
 */

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/platform/errors';
import {
  shotSpecEditSchema,
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/shadcn/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { useHydrated } from '@/ui/use-hydrated';
import { cn } from '@/ui/utils';
import { ChevronRight } from 'lucide-react';
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

/** The spec read off the form. */
function specFromForm(form: FormData, spec: StoredShotSpec): StoredShotSpec {
  const value = (name: string, fallback: string) => {
    const entry = form.get(name);
    return typeof entry === 'string' ? entry : fallback;
  };
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
}: {
  sequenceId: string;
  shotId: string;
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
  spec,
  verdict,
  visualWritten,
  motionWritten,
}: {
  sequenceId: string;
  shotId: string;
  spec: StoredShotSpec;
  verdict: 'current' | 'stale' | 'missing' | 'updating';
  visualWritten: boolean;
  motionWritten: boolean;
}) {
  const save = useSaveShotSpec(sequenceId);
  const hydrated = useHydrated();
  const { items: mentionItems, onMentionRename } =
    useSequenceMentionItems(sequenceId);
  // Remounts the fields on Cancel, back to the saved spec.
  const [resetCount, setResetCount] = useState(0);
  const [open, setOpen] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<StoredShotSpec | null>(null);
  const updating = verdict === 'updating';
  const status = updating
    ? 'Rewriting…'
    : dirty
      ? 'Unsaved changes'
      : verdict === 'stale'
        ? 'Script changed since it was written'
        : '';

  const submit = (next: StoredShotSpec, replace: boolean) => {
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
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="rounded-md border"
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            disabled={!hydrated}
            className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRight
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                open && 'rotate-90'
              )}
              aria-hidden
            />
            <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
              <span className="font-medium">Shot spec</span>
              <span
                className="truncate text-xs text-muted-foreground"
                aria-live="polite"
              >
                {status}
              </span>
            </span>
          </button>
        </CollapsibleTrigger>
        {/* Hidden, not unmounted, so closing keeps unsaved edits. */}
        <CollapsibleContent forceMount className="data-[state=closed]:hidden">
          <div className="flex flex-col gap-3 border-t px-3 py-3">
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
        </CollapsibleContent>
      </Collapsible>

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
                aria-label={`${field.label} suggestions`}
              >
                Suggestions
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
        mentionItems={mentionItems}
        onMentionRename={onMentionRename}
      />
      <input type="hidden" name={field.name} value={value} />
    </div>
  );
}
