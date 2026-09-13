/**
 * Shot Duration Field — the duration control for a shot, on the video surface.
 *
 * Duration is a **video parameter**, not a prompt driver: `sceneInputContext`
 * (input-hash.ts) allowlists it out of the prompt hashes, and it is hashed only
 * by `computeShotVideoInputHash`. Changing it re-stales the render, never the
 * image/motion prompts — which is why this lives on the Motion tab next to the
 * model and the segment panel rather than under the scene script.
 *
 * It is also per-**shot**, not per-scene: `shots.durationMs` is the only store
 * (a scene's duration is the sum of its shots, which is exactly what
 * `tileSceneIntoSegments` reads against the model's cap). Today's one-shot
 * scenes make the two coincide; multi-shot scenes (#910) won't.
 *
 * Options come from the selected motion model's JSON Schema, so the user can
 * only pick a value the model accepts. A stored value outside that set (the
 * shot renders through a different model than it was saved against, or legacy
 * data) is shown snapped, with a note — not as a pending edit. The render path
 * snaps it too (`resolveShotDuration`), so nothing is broken and there is
 * nothing the user must do.
 */

import { Button } from '@/ui/shadcn/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
import { estimateSceneDurationFn } from '@/models/ai.fn';
import { updateShotDurationFn } from '@/shots/shots.fn';
import { sequenceKeys } from '@/sequences/ui/use-sequences';
import { formatSeconds } from '@/sequences/ui/target-duration-chip';
import { shotStalenessNamespace } from './use-shot-staleness';
import { shotKeys } from './use-shots';
import { videoModelDisplayName, type ImageToVideoModel } from '@/models/models';
import { durationGridForModel } from '@/motion/model-capabilities';
import { dialogueExceedsShotDuration } from '@/motion/resolve-shot-duration';
import { snapDuration, snapDurationUp } from '@/motion/snap-duration';
import type { Shot } from '@/platform/server/db/schema';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type ShotDurationFieldProps = {
  shot: Shot | undefined;
  sequenceId: string;
  /** Drives the legal duration set — the model this shot renders through. */
  motionModel: ImageToVideoModel;
  /** The scene's script — what the Estimate button reads. */
  scriptExtract?: string;
  /** Sum of the scene's shots / of the whole cut (#1593) — shown as totals. */
  sceneSeconds?: number;
  filmSeconds?: number;
  /** References-stage take length. Noted only when it exceeds the shot. */
  dialogueSeconds?: number | null;
};

export const ShotDurationField: React.FC<ShotDurationFieldProps> = ({
  shot,
  sequenceId,
  motionModel,
  scriptExtract = '',
  sceneSeconds,
  filmSeconds,
  dialogueSeconds,
}) => {
  // `undefined` = no draft (the Select mirrors the saved value). Mount this
  // component with `key={shot.id}` so switching shots drops the draft.
  const [editedSeconds, setEditedSeconds] = useState<number | undefined>(
    undefined
  );
  const queryClient = useQueryClient();

  const savedSeconds =
    shot?.durationMs && shot.durationMs > 0
      ? shot.durationMs / 1000
      : undefined;

  const durationOptions = durationGridForModel(motionModel);
  const durationItems = durationOptions.map((seconds) => ({
    value: String(seconds),
    label: `${seconds}s`,
  }));
  const snappedSavedSeconds = snapDuration(savedSeconds, motionModel);
  const currentSeconds = editedSeconds ?? snappedSavedSeconds;
  // Dirty means the USER changed it. A stored value outside the current model's
  // set deliberately does NOT count: `resolveShotDuration` snaps at render time
  // anyway, so the mismatch is harmless — and because the set is per-model, a
  // shot whose model differs from the sequence default would otherwise sit
  // permanently "unsaved", showing Save/Cancel on a field nobody touched. It's
  // surfaced as a note below instead.
  const isDirty = editedSeconds !== undefined && editedSeconds !== savedSeconds;
  const rendersSnapped =
    savedSeconds !== undefined && snappedSavedSeconds !== savedSeconds;
  const dialogueLonger = dialogueExceedsShotDuration(
    dialogueSeconds,
    currentSeconds
  );
  const raisedForDialogue =
    dialogueLonger && dialogueSeconds != null
      ? snapDurationUp(dialogueSeconds, motionModel)
      : null;

  const saveMutation = useMutation({
    mutationFn: async (durationSeconds: number) => {
      if (!shot?.id) throw new Error('shot required');
      return updateShotDurationFn({
        data: { sequenceId, shotId: shot.id, durationSeconds },
      });
    },
    onSuccess: async (updated) => {
      setEditedSeconds(undefined);
      queryClient.setQueryData(shotKeys.detail(updated.id), updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) }),
        // The render's input hash includes duration — staleness flips here.
        queryClient.invalidateQueries({
          queryKey: shotStalenessNamespace,
        }),
        // The sequence's total runtime sums shot durations.
        queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        }),
      ]);
      toast.success('Duration saved');
    },
    onError: (error) => {
      toast.error('Failed to save duration', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  const estimateMutation = useMutation({
    mutationFn: async () => {
      if (!shot?.id) throw new Error('shot required');
      if (!scriptExtract.trim()) throw new Error('scene script is empty');
      return estimateSceneDurationFn({
        data: { sequenceId, shotId: shot.id, extract: scriptExtract },
      });
    },
    onSuccess: ({ durationSeconds }) => {
      const snapped = snapDuration(durationSeconds, motionModel);
      setEditedSeconds(snapped);
      toast.success(`Suggested duration: ${snapped}s`);
    },
    onError: (error) => {
      toast.error('Duration estimate failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  const isSaving = saveMutation.isPending;
  const isEstimating = estimateMutation.isPending;
  const busy = isSaving || isEstimating;

  return (
    <div className="space-y-2">
      <label htmlFor="shot-duration-input" className="text-sm font-medium">
        Duration (seconds)
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={String(currentSeconds)}
          items={durationItems}
          onValueChange={(value) => {
            if (value == null) return;
            setEditedSeconds(Number(value));
          }}
          disabled={!shot || busy}
        >
          <SelectTrigger id="shot-duration-input" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {durationItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => estimateMutation.mutate()}
          disabled={!shot || !scriptExtract.trim() || busy}
        >
          {isEstimating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          {isEstimating ? 'Estimating…' : 'Estimate'}
        </Button>

        {sceneSeconds !== undefined && filmSeconds !== undefined && (
          <span className="text-xs tabular-nums text-muted-foreground">
            Scene {formatSeconds(sceneSeconds)} · Film{' '}
            {formatSeconds(filmSeconds)}
          </span>
        )}
        {dialogueLonger && dialogueSeconds != null && (
          <span className="text-xs tabular-nums text-muted-foreground">
            Dialogue {formatSeconds(dialogueSeconds)}
          </span>
        )}

        {isDirty && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditedSeconds(undefined)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => saveMutation.mutate(currentSeconds)}
              disabled={!shot || busy}
            >
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </div>

      {/* The snapped-value line is purely informational — there is nothing to
          fix, so it carries no call to action: Save only appears once the user
          changes the value, and telling them to save would point at a button
          that isn't on screen. */}
      {isDirty ? (
        <p className="text-xs text-muted-foreground">
          Saving will mark the rendered video as stale. Prompts are unaffected.
        </p>
      ) : rendersSnapped ? (
        <p className="text-xs text-muted-foreground">
          Stored as {savedSeconds}s — {videoModelDisplayName(motionModel)}{' '}
          renders it at {snappedSavedSeconds}s.
        </p>
      ) : null}
      {dialogueLonger &&
        dialogueSeconds != null &&
        raisedForDialogue != null && (
          <p className="text-xs text-muted-foreground">
            {raisedForDialogue < dialogueSeconds
              ? `Dialogue is ${formatSeconds(dialogueSeconds)} — ${videoModelDisplayName(motionModel)} maxes at ${formatSeconds(raisedForDialogue)}, so the take won't attach.`
              : `Dialogue is ${formatSeconds(dialogueSeconds)} — this shot is ${formatSeconds(currentSeconds)}. Generate will render at ${formatSeconds(raisedForDialogue)}.`}
          </p>
        )}
    </div>
  );
};
