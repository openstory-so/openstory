/**
 * Images / Videos list toolbar prefs (#1568).
 *
 * Live state lives in the /images and /videos search params (shareable).
 * localStorage is the memory for a bare visit (sidebar / breadcrumb) so
 * support mode survives leaving the page — same contract as sequences.
 *
 * `sort` and `favorites` stay on the URL only; they are not stored, so a
 * remembered Support overlay does not clobber Newest/Oldest.
 *
 * No `.default()` on the search schema: a default rewrites the bare path
 * with a 307, which sours the sitemap entry (#814).
 */
import { studioSortSchema, type StudioSort } from '@/studio/schema';
import { z } from 'zod';

export const STUDIO_LIST_PREFS_KEY = 'openstory:studio-list:v1';

export const studioListSearchSchema = z.object({
  user: z.string().email().optional(),
  q: z.string().optional(),
  support: z.boolean().optional(),
  hideInternal: z.boolean().optional(),
  sort: studioSortSchema.optional(),
  favorites: z.boolean().optional(),
});

export type StudioListSearch = z.infer<typeof studioListSearchSchema>;

export type StudioListPrefs = {
  search: string;
  supportMode: boolean;
  hideInternal: boolean;
  sort: StudioSort;
  favorites: boolean;
};

export const DEFAULT_STUDIO_LIST_PREFS: StudioListPrefs = {
  search: '',
  supportMode: false,
  hideInternal: false,
  sort: 'newest',
  favorites: false,
};

const storedPrefsSchema = z.object({
  search: z.string().catch(''),
  supportMode: z.boolean().catch(false),
  hideInternal: z.boolean().catch(false),
});

type StoredStudioListPrefs = z.infer<typeof storedPrefsSchema>;

export function searchSpecifiesSupportPrefs(search: StudioListSearch): boolean {
  return (
    search.user != null ||
    search.q != null ||
    search.support != null ||
    search.hideInternal != null
  );
}

export function prefsFromSearch(search: StudioListSearch): StudioListPrefs {
  return {
    search: search.user ?? search.q ?? '',
    supportMode: Boolean(search.user) || Boolean(search.support),
    hideInternal: search.user ? false : Boolean(search.hideInternal),
    sort: search.sort ?? 'newest',
    favorites: Boolean(search.favorites),
  };
}

export function resolveStudioListPrefs(
  search: StudioListSearch,
  stored: StoredStudioListPrefs | null
): StudioListPrefs {
  const fromUrl = prefsFromSearch(search);
  if (searchSpecifiesSupportPrefs(search)) {
    return fromUrl;
  }
  return {
    ...fromUrl,
    search: stored?.search ?? '',
    supportMode: stored?.supportMode ?? false,
    hideInternal: stored?.hideInternal ?? false,
  };
}

export function prefsToSearch(
  prefs: StudioListPrefs,
  currentUser?: string
): StudioListSearch {
  const search: StudioListSearch = {};
  const keepUser =
    Boolean(currentUser) && prefs.supportMode && prefs.search === currentUser;

  if (keepUser && currentUser) {
    search.user = currentUser;
  } else if (prefs.search) {
    search.q = prefs.search;
  }

  if (prefs.supportMode && !search.user) search.support = true;
  if (prefs.hideInternal && prefs.supportMode && !search.user) {
    search.hideInternal = true;
  }
  if (prefs.sort !== 'newest') search.sort = prefs.sort;
  if (prefs.favorites) search.favorites = true;
  return search;
}

export function loadStudioListPrefs(): StoredStudioListPrefs | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STUDIO_LIST_PREFS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const result = storedPrefsSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function saveStudioListPrefs(prefs: StudioListPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      STUDIO_LIST_PREFS_KEY,
      JSON.stringify({
        search: prefs.search,
        supportMode: prefs.supportMode,
        hideInternal: prefs.hideInternal,
      })
    );
  } catch {
    // private mode / quota
  }
}
