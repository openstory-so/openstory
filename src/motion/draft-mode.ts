/**
 * Ark draft mode (#1756). Client-safe: no env, no adapters.
 *
 * A draft is a 480p Seedance 2.5 render submitted with `draft: true`. Ark
 * keeps the task for seven days; within that window a second request whose
 * only content is `{ type: 'draft_task', draft_task: { id } }` renders the
 * 1080p final with the same seed, prompt and assets — so what the user
 * approved at 480p is what they get at 1080p. Both the draft and the final
 * are billed as ordinary renders at their own resolution.
 *
 * Ark-only: fal exposes no draft flag, and the 2.0 family has none, so
 * `supportsDraftMode` (the catalog) gates the switch and the BytePlus via
 * gates the submit.
 */

/** The only resolution Ark accepts with `draft: true`. */
export const DRAFT_RESOLUTION = '480p' as const;

/** The only resolution Ark accepts for a Seedance 2.5 final from a draft. */
export const DRAFT_FINAL_RESOLUTION = '1080p' as const;

/** A draft task id is valid for seven days from the task's `created_at`. */
const DRAFT_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a draft rendered at `createdAt` can still be rendered at quality.
 * Our row opens seconds before Ark's `created_at`, so this errs early.
 */
export function draftTaskUsable(
  createdAt: Date | string | number,
  now: number = Date.now()
): boolean {
  return now - new Date(createdAt).getTime() < DRAFT_TASK_TTL_MS;
}

/**
 * How the expiry reads next to the word "draft", or null while it is not
 * worth saying: nothing until three days remain (`' · 3 days left'`), then
 * `' · expires today'`, then `' expired'` once the final can no longer be
 * rendered. Whole days, rounded down, so "1 day left" never overstates.
 */
export function draftExpirySuffix(
  createdAt: Date | string | number,
  now: number = Date.now()
): string | null {
  const remaining = new Date(createdAt).getTime() + DRAFT_TASK_TTL_MS - now;
  if (remaining <= 0) return ' expired';
  const days = Math.floor(remaining / DAY_MS);
  if (days === 0) return ' · expires today';
  if (days > 3) return null;
  return ` · ${days} ${days === 1 ? 'day' : 'days'} left`;
}

/** The frame pill for a draft clip: "Draft", "Draft · 2 days left", "Draft expired". */
export function draftBadgeLabel(
  createdAt: Date | string | number,
  now: number = Date.now()
): string {
  return `Draft${draftExpirySuffix(createdAt, now) ?? ''}`;
}

/** The pill for a shot whose selected clip is an Ark draft, else null. */
export function shotDraftLabel(
  shot:
    | {
        primaryVideo: {
          draftTaskId: string | null;
          createdAt: Date | string | number;
        } | null;
      }
    | null
    | undefined,
  now: number = Date.now()
): string | null {
  const video = shot?.primaryVideo;
  return video?.draftTaskId ? draftBadgeLabel(video.createdAt, now) : null;
}

/**
 * The theatre pill for a cut with draft clips in it, else null: "Draft cut"
 * when every clip is a draft, "3 of 12 shots are drafts" otherwise, with the
 * soonest expiry appended the way `draftBadgeLabel` does it.
 */
export function theatreDraftLabel(
  shots: ReadonlyArray<{
    primaryVideo: {
      draftTaskId: string | null;
      createdAt: Date | string | number;
    } | null;
  }>,
  now: number = Date.now()
): string | null {
  const drafts = shots.filter((shot) => shot.primaryVideo?.draftTaskId);
  if (drafts.length === 0) return null;
  const soonest = Math.min(
    ...drafts.map((shot) =>
      new Date(shot.primaryVideo?.createdAt ?? now).getTime()
    )
  );
  const head =
    drafts.length === shots.length
      ? 'Draft cut'
      : `${drafts.length} of ${shots.length} shots are drafts`;
  return `${head}${draftExpirySuffix(soonest, now) ?? ''}`;
}
