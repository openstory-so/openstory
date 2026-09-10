import { mediaUrlSchema } from '@/platform/schemas/media-url.schemas';
import { z } from 'zod';

/**
 * A draft element upload as it crosses the wire into sequence creation: an
 * image already sitting in R2 at a permanent key (#1471), waiting for a
 * sequence to point a row at it.
 *
 * The `temp*` field names are a wire contract, not a description. The draft is
 * persisted verbatim to localStorage by `draftElementSchema`
 * (`src/sequences/ui/script/sequence-draft.ts`), whose `safeParse` returns
 * `null` on any mismatch — so renaming a field here silently drops the *whole*
 * saved draft, not just its elements. Bump that module's `:v1` storage key if
 * the shape ever has to change.
 */
export const draftElementUploadSchema = z.object({
  /** Bucket-prefixed R2 key, `elements/<teamId>/…`. Validated server-side. */
  tempPath: z.string().min(1),
  /**
   * Display URL for the draft grid, and what the script enhancer looks at.
   * Never trusted for the stored row — that URL is re-derived from `tempPath`.
   */
  tempPublicUrl: mediaUrlSchema,
  filename: z.string().min(1),
  /**
   * Vision-suggested token from the inline `analyzeDraftElementFn` call during
   * draft upload; optional on the public API, where callers may omit it. Falls
   * back to a filename-derived token at attach time.
   */
  token: z.string().min(1).max(100).nullable().optional(),
  /**
   * Pre-computed by `analyzeDraftElementFn` so the row lands `completed` and
   * the async element-vision workflow never has to run.
   */
  description: z.string().nullable().optional(),
  consistencyTag: z.string().nullable().optional(),
});

export type DraftElementUploadInput = z.infer<typeof draftElementUploadSchema>;
