/**
 * "Did you mean …?" for a cast name that is one edit, or a unique first
 * name, from another live member (#2249). The button merges this member
 * into that one.
 */

import { castNearMatch } from '@/cast/near-name';
import { Button } from '@/ui/shadcn/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
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
import { useState } from 'react';

export function suggestCastMerge<T extends { id: string; name: string }>(
  name: string,
  others: readonly T[]
): T | null {
  return castNearMatch(name, others)?.match ?? null;
}

export function CastMergeOffer({
  fromName,
  intoName,
  keepsLoserSheet,
  pending,
  onMerge,
  showHint = true,
}: {
  fromName: string;
  intoName: string;
  keepsLoserSheet: boolean;
  pending: boolean;
  onMerge: () => void;
  showHint?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      {showHint ? (
        <p className="text-xs text-muted-foreground">
          <span>Did you mean {intoName}?</span>
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        {pending ? <span>Merging…</span> : <span>Merge into {intoName}</span>}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <span>
                Merge {fromName} into {intoName}?
              </span>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span>
                {fromName} leaves this sequence and stays in the organization.{' '}
                {intoName} keeps its sheet, looks and voice.
                {keepsLoserSheet
                  ? ` ${intoName} has no sheet, so ${fromName}'s sheet is kept.`
                  : ''}{' '}
                Undo brings {fromName} back into the cast.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => {
                setOpen(false);
                onMerge();
              }}
            >
              {pending ? <span>Merging…</span> : <span>Merge</span>}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type MergeTarget = {
  id: string;
  name: string;
  sheetImageUrl: string | null;
  sheetStatus: string;
  pendingPromoteSheetVersionId: string | null;
};

/** Merge this character into any other live cast member. */
export function MergeIntoPicker({
  fromName,
  others,
  suggestedId,
  pending,
  onMerge,
}: {
  fromName: string;
  others: readonly MergeTarget[];
  suggestedId: string | null;
  pending: boolean;
  onMerge: (intoId: string) => void;
}) {
  const [intoId, setIntoId] = useState(suggestedId ?? others[0]?.id ?? '');
  const into = others.find((member) => member.id === intoId) ?? others[0];
  if (!into) return null;
  const keepsLoserSheet =
    !into.sheetImageUrl &&
    into.sheetStatus !== 'generating' &&
    into.sheetStatus !== 'completed' &&
    !into.pendingPromoteSheetVersionId;
  return (
    <div className="flex flex-col gap-2">
      <Select
        value={into.id}
        items={Object.fromEntries(
          others.map((member) => [member.id, member.name])
        )}
        onValueChange={(value) => {
          if (value) setIntoId(value);
        }}
      >
        <SelectTrigger aria-label={`Merge ${fromName} into`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {others.map((member) => (
            <SelectItem key={member.id} value={member.id}>
              {member.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <CastMergeOffer
        fromName={fromName}
        intoName={into.name}
        keepsLoserSheet={keepsLoserSheet}
        pending={pending}
        showHint={suggestedId === into.id}
        onMerge={() => onMerge(into.id)}
      />
    </div>
  );
}
