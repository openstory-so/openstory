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
