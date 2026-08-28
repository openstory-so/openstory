import { z } from 'zod';

export const sheetProgressActivitySchema = z.enum(['sheet', 'portrait']);
export type SheetProgressActivity = z.infer<typeof sheetProgressActivitySchema>;

/** Longer than a slow 4-panel + headshot (those finish in ~2–5 min). */
export const SHEET_PROGRESS_STALE_MS = 10 * 60 * 1000;

export function isSheetProgressStale(
  tsMs: number | undefined,
  now = Date.now()
): boolean {
  if (tsMs === undefined) return false;
  return now - tsMs > SHEET_PROGRESS_STALE_MS;
}

/** What the UI should say for an in-flight talent-sheet run. */
export function sheetProgressCopy(
  activity: SheetProgressActivity,
  variant: 'short' | 'long' = 'short'
): string {
  if (activity === 'portrait') {
    return variant === 'long'
      ? 'Creating portrait from the uploaded sheet…'
      : 'Creating portrait…';
  }
  return variant === 'long' ? 'Generating talent sheet…' : 'Generating sheet…';
}

export function parseSheetProgressActivity(
  value: unknown
): SheetProgressActivity | undefined {
  const parsed = sheetProgressActivitySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function activityFromProgress(data: {
  status: string;
  activity?: SheetProgressActivity;
}): SheetProgressActivity {
  if (data.status === 'sheet_ready') return 'portrait';
  return parseSheetProgressActivity(data.activity) ?? 'sheet';
}
