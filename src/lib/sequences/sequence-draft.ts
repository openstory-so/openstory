/**
 * New-sequence composer draft (#1384).
 *
 * localStorage holds the in-progress script (typed or Shuffle/Try sample),
 * style, and attachments so a reload or sign-in remount can restore it.
 * A Try / Use-this-style seed for a *different* style is new intent and
 * wins over a stale draft.
 */
import { z } from 'zod';

export const SEQUENCE_DRAFT_STORAGE_KEY = 'openstory:sequence-draft:v1';
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

const draftElementSchema = z.object({
  tempPath: z.string(),
  tempPublicUrl: z.string(),
  filename: z.string(),
  token: z.string(),
  description: z.string().nullable().default(null),
  consistencyTag: z.string().nullable().default(null),
});

const sequenceDraftSchema = z.object({
  script: z.string().default(''),
  styleId: z.string().nullable().default(null),
  sampleStyleId: z.string().nullable().default(null),
  selectedTalentIds: z.array(z.string()).default([]),
  selectedLocationIds: z.array(z.string()).default([]),
  elementUploads: z.array(draftElementSchema).default([]),
  savedAt: z.number().default(0),
});

export type SequenceDraft = z.infer<typeof sequenceDraftSchema>;

export const EMPTY_SEQUENCE_DRAFT: SequenceDraft = sequenceDraftSchema.parse(
  {}
);

export type PersistableSequenceDraft = Omit<SequenceDraft, 'savedAt'>;

/**
 * Restore the saved composer after reload / sign-in, unless the URL seed is
 * a Try / Use-this-style navigation to a different style.
 */
export function shouldRestoreComposerDraft(
  draft: Pick<SequenceDraft, 'script' | 'styleId'>,
  initialStyleId?: string | null
): boolean {
  if (!draft.script.trim()) return false;
  if (initialStyleId && draft.styleId && initialStyleId !== draft.styleId) {
    return false;
  }
  return true;
}

export function readSequenceDraft(): SequenceDraft | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const stored = localStorage.getItem(SEQUENCE_DRAFT_STORAGE_KEY);
    if (!stored) return null;

    const result = sequenceDraftSchema.safeParse(JSON.parse(stored));
    if (!result.success) return null;
    const draft = result.data;

    if (Date.now() - draft.savedAt > EXPIRY_MS) {
      localStorage.removeItem(SEQUENCE_DRAFT_STORAGE_KEY);
      return null;
    }

    return draft;
  } catch {
    return null;
  }
}

export function writeSequenceDraft(draft: PersistableSequenceDraft): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(
      SEQUENCE_DRAFT_STORAGE_KEY,
      JSON.stringify({ ...draft, savedAt: Date.now() })
    );
  } catch {
    // localStorage full or unavailable
  }
}

export function clearSequenceDraft(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(SEQUENCE_DRAFT_STORAGE_KEY);
}
