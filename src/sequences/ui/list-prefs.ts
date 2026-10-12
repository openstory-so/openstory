/**
 * Sequences list toolbar prefs (#1314).
 *
 * Live state lives in the /sequences search params (shareable, back/forward).
 * A cookie is the memory for a bare `/sequences` visit (sidebar, breadcrumb),
 * so the route can restore it on the server before the first paint.
 *
 * No `.default()` on the search schema: a default rewrites bare /sequences with
 * a 307, which sours the sitemap entry (#814).
 */
import { aspectRatioSchema, type AspectRatio } from '@/models/aspect-ratios';
import { readCookie, writeCookie } from '@/ui/cookie';
import { z } from 'zod';

export const SEQUENCES_LIST_PREFS_COOKIE = 'openstory_sequences_list_v1';

export const sequencesListSearchSchema = z.object({
  user: z.string().email().optional(),
  q: z.string().optional(),
  analysisModel: z.string().optional(),
  imageModel: z.string().optional(),
  aspectRatio: aspectRatioSchema.optional(),
  styleId: z.string().optional(),
  support: z.boolean().optional(),
  hideInternal: z.boolean().optional(),
});

export type SequencesListSearch = z.infer<typeof sequencesListSearchSchema>;

export type SequencesListPrefs = {
  search: string;
  analysisModel: string | null;
  imageModel: string | null;
  aspectRatio: AspectRatio | null;
  styleId: string | null;
  supportMode: boolean;
  hideInternal: boolean;
};

export const DEFAULT_SEQUENCES_LIST_PREFS: SequencesListPrefs = {
  search: '',
  analysisModel: null,
  imageModel: null,
  aspectRatio: null,
  styleId: null,
  supportMode: false,
  hideInternal: false,
};

const optionalId = z.string().min(1).nullable().catch(null);

const storedPrefsSchema = z.object({
  search: z.string().catch(''),
  analysisModel: optionalId,
  imageModel: optionalId,
  aspectRatio: aspectRatioSchema.nullable().catch(null),
  styleId: optionalId,
  supportMode: z.boolean().catch(false),
  hideInternal: z.boolean().catch(false),
});

export function searchSpecifiesPrefs(search: SequencesListSearch): boolean {
  return (
    search.user != null ||
    search.q != null ||
    search.analysisModel != null ||
    search.imageModel != null ||
    search.aspectRatio != null ||
    search.styleId != null ||
    search.support != null ||
    search.hideInternal != null
  );
}

export function prefsFromSearch(
  search: SequencesListSearch
): SequencesListPrefs {
  return {
    search: search.user ?? search.q ?? '',
    analysisModel: search.analysisModel ?? null,
    imageModel: search.imageModel ?? null,
    aspectRatio: search.aspectRatio ?? null,
    styleId: search.styleId ?? null,
    supportMode: Boolean(search.user) || Boolean(search.support),
    hideInternal: search.user ? false : Boolean(search.hideInternal),
  };
}

export function resolveSequencesListPrefs(
  search: SequencesListSearch,
  stored: SequencesListPrefs | null
): SequencesListPrefs {
  if (!searchSpecifiesPrefs(search)) {
    return stored ?? DEFAULT_SEQUENCES_LIST_PREFS;
  }
  return prefsFromSearch(search);
}

export function prefsToSearch(
  prefs: SequencesListPrefs,
  currentUser?: string
): SequencesListSearch {
  const search: SequencesListSearch = {};
  const keepUser =
    Boolean(currentUser) && prefs.supportMode && prefs.search === currentUser;

  if (keepUser && currentUser) {
    search.user = currentUser;
  } else if (prefs.search) {
    search.q = prefs.search;
  }

  if (prefs.analysisModel) search.analysisModel = prefs.analysisModel;
  if (prefs.imageModel) search.imageModel = prefs.imageModel;
  if (prefs.aspectRatio) search.aspectRatio = prefs.aspectRatio;
  if (prefs.styleId) search.styleId = prefs.styleId;
  if (prefs.supportMode && !search.user) search.support = true;
  if (prefs.hideInternal && prefs.supportMode && !search.user) {
    search.hideInternal = true;
  }
  return search;
}

export function loadSequencesListPrefs(): SequencesListPrefs | null {
  const raw = readCookie(SEQUENCES_LIST_PREFS_COOKIE);
  if (!raw) return null;
  try {
    const result = storedPrefsSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function saveSequencesListPrefs(prefs: SequencesListPrefs): void {
  writeCookie(SEQUENCES_LIST_PREFS_COOKIE, JSON.stringify(prefs));
}

/**
 * Route `beforeLoad`: a URL that names prefs is remembered; a bare visit gets
 * the search to redirect to. The redirect target names prefs, so it never
 * redirects twice. A hover preload remembers nothing.
 */
export function rememberSequencesListPrefs(
  search: SequencesListSearch,
  preload: boolean
): SequencesListSearch | null {
  if (searchSpecifiesPrefs(search)) {
    if (!preload) saveSequencesListPrefs(prefsFromSearch(search));
    return null;
  }
  const next = prefsToSearch(
    resolveSequencesListPrefs(search, loadSequencesListPrefs())
  );
  return searchSpecifiesPrefs(next) ? next : null;
}
