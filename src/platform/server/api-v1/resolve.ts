/**
 * Resolvers that turn the public API's human-friendly references into the
 * concrete ids / uploads `createSequences` expects:
 *   - style:   id | name | slug  → styleId (auto-pick a default when omitted)
 *   - character: id | name     → castCharacterIds (a team character)
 *   - location:id | name         → suggestedLocationIds (a team location, #1695)
 *   - element: hosted URL        → ingested DraftElementUploadInput
 *
 * Every lookup goes through a team-scoped read (styles: team-owned + public;
 * characters and locations: the team's only), so a caller can never resolve
 * another team's private entry.
 */

import type { Style } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { ConflictError, NotFoundError } from '@/platform/errors';
import type { DraftElementUploadInput } from '@/cast/draft-element-upload';
import { DRAFT_ELEMENT_UPLOAD_PREFIX } from '@/cast/server/sequence-elements/storage-path';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import type { ApiCreateSequenceInput } from './input-schema';
import { ingestImageToBucket } from './safe-fetch';

/** lowercase, non-alphanumerics → single hyphens; for forgiving name matching. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function matchesRef(ref: string, candidate: { id: string; name: string }) {
  if (candidate.id === ref) return true;
  const r = ref.toLowerCase().trim();
  return (
    candidate.name.toLowerCase().trim() === r ||
    slugify(candidate.name) === slugify(ref)
  );
}

// Narrow dependency surfaces: each resolver depends only on what it actually
// uses — the team-scoped `list()` for matching, plus an injected `create*`
// thunk for inline-create. The thunk (wired by the orchestrator) owns the heavy
// create-with-ingest path, keeping these resolvers pure and cast-free to test.
type StyleDeps = { styles: Pick<ScopedDb['styles'], 'list'> };

type CharacterCreate = Exclude<
  NonNullable<ApiCreateSequenceInput['characters']>[number],
  string
>;
type LocationCreate = Exclude<
  NonNullable<ApiCreateSequenceInput['locations']>[number],
  string
>;

type CharacterResolveDeps = {
  characters: Pick<ScopedDb['characters'], 'listTeam'>;
  createCharacter: (input: CharacterCreate) => Promise<{ id: string }>;
};
type LocationResolveDeps = {
  locations: Pick<ScopedDb['locations'], 'listTeam'>;
  createLocation: (input: LocationCreate) => Promise<{ id: string }>;
};

/** Partition a mixed ref/create list into reference strings and create objects. */
function partition<T>(items: readonly (string | T)[]): {
  refs: string[];
  creates: T[];
} {
  const refs: string[] = [];
  const creates: T[] = [];
  for (const item of items) {
    if (typeof item === 'string') refs.push(item);
    else creates.push(item);
  }
  return { refs, creates };
}

/**
 * Resolve a style reference to the full style row. With no reference, auto-pick
 * the most popular team-or-public style. Throws 404 if a given reference matches
 * nothing. Returns the row (not just the id) so callers can apply the style's
 * recommended aspect ratio, mirroring the new-sequence page.
 */
export async function resolveStyle(
  scopedDb: StyleDeps,
  styleRef: string | undefined
): Promise<Style> {
  const styles = await scopedDb.styles.list({ orderBy: 'popular' });

  // list() is ordered by popularity desc, so the first row is the default.
  const [mostPopular] = styles;
  if (!mostPopular) {
    throw new NotFoundError(
      'No styles are available to this team. Create a style first.'
    );
  }
  if (!styleRef) {
    return mostPopular;
  }

  const match = styles.find((s) => matchesRef(styleRef, s));
  if (!match) {
    throw new NotFoundError(`No style found matching "${styleRef}".`);
  }
  return match;
}

/**
 * Resolve a mixed list of character items — reference strings (id|name) and
 * inline create objects — into the team characters to cast into the new
 * sequence (`castCharacterIds`). A string names one of the team's characters,
 * by id then by name; two of that name is a conflict that asks for the id.
 * An inline create whose name a team character already has is a conflict; a
 * repeat of an earlier create in this list reuses it. New names are delegated
 * to `deps.createCharacter`.
 */
export async function resolveCharacterIds(
  deps: CharacterResolveDeps,
  items: ApiCreateSequenceInput['characters']
): Promise<string[]> {
  if (!items || items.length === 0) return [];
  const { refs, creates } = partition(items);
  const ids: string[] = [];

  const team = await deps.characters.listTeam();
  /** The one team character `ref` names, or null; several is a conflict. */
  const named = (ref: string, matches: typeof team): string | null => {
    if (matches.length > 1) {
      throw new ConflictError(
        `"${ref}" names ${matches.length} characters. Use the id: ${matches.map((c) => c.id).join(', ')}.`
      );
    }
    return matches[0]?.id ?? null;
  };

  for (const ref of refs) {
    const byId = team.find((c) => c.id === ref);
    const id =
      byId?.id ??
      named(
        ref,
        team.filter((c) => matchesRef(ref, c))
      );
    if (!id) throw new NotFoundError(`No character found matching "${ref}".`);
    ids.push(id);
  }

  const created = new Map<string, string>();
  for (const create of creates) {
    const slug = slugify(create.name);
    const earlier = created.get(slug);
    if (earlier) {
      ids.push(earlier);
      continue;
    }
    const taken = team.filter((c) => slugify(c.name) === slug);
    if (taken.length > 0) {
      // Reusing it would drop this create's description and person flag.
      throw new ConflictError(
        `The team already has a character named "${create.name}". Pass its name or id as a string to cast it: ${taken.map((c) => c.id).join(', ')}.`
      );
    }
    const character = await deps.createCharacter(create);
    ids.push(character.id);
    created.set(slug, character.id);
  }

  return [...new Set(ids)];
}

/**
 * Resolve a mixed list of location items — reference strings (id|name) and
 * inline create objects — into a deduped list of team location ids for
 * `suggestedLocationIds`. A string names one of the team's locations, by id
 * then by name; two of that name is a conflict that asks for the id. An inline
 * create whose name a team location (or an earlier create in this list) has
 * reuses it. New names are delegated to `deps.createLocation`.
 */
export async function resolveLocationIds(
  deps: LocationResolveDeps,
  items: ApiCreateSequenceInput['locations']
): Promise<string[]> {
  if (!items || items.length === 0) return [];
  const { refs, creates } = partition(items);
  const ids: string[] = [];

  const team = await deps.locations.listTeam();
  /** The one team location `ref` names, or null; several is a conflict. */
  const named = (ref: string, matches: typeof team): string | null => {
    if (matches.length > 1) {
      throw new ConflictError(
        `"${ref}" names ${matches.length} locations. Use the id: ${matches.map((l) => l.id).join(', ')}.`
      );
    }
    return matches[0]?.id ?? null;
  };

  for (const ref of refs) {
    const byId = team.find((l) => l.id === ref);
    const id =
      byId?.id ??
      named(
        ref,
        team.filter((l) => matchesRef(ref, l))
      );
    if (!id) throw new NotFoundError(`No location found matching "${ref}".`);
    ids.push(id);
  }

  const created = new Map<string, string>();
  for (const create of creates) {
    const slug = slugify(create.name);
    const existingId =
      created.get(slug) ??
      named(
        create.name,
        team.filter((l) => slugify(l.name) === slug)
      );
    if (existingId) {
      ids.push(existingId);
      continue;
    }
    const location = await deps.createLocation(create);
    ids.push(location.id);
    created.set(slug, location.id);
  }

  return [...new Set(ids)];
}

/**
 * Ingest caller-hosted reference images into element storage and return the
 * draft uploads `attachDraftElementUploads` expects. The key is permanent and
 * the rows point straight at it (#1471), so a caller-hosted image is never
 * left under a name that reads as reclaimable.
 *
 * Vision is intentionally NOT run here: attach leaves `visionStatus: pending`,
 * which fires the `element-vision` workflow, and analyze-script's
 * `waitForElementVision` gate blocks scene-split until it completes — so the
 * request stays fast.
 */
export async function ingestElements(
  teamId: string,
  elements: ApiCreateSequenceInput['elements']
): Promise<DraftElementUploadInput[]> {
  if (!elements || elements.length === 0) return [];

  return Promise.all(
    elements.map(async (el, index) => {
      const { storagePath, publicUrl, extension } = await ingestImageToBucket(
        el.url,
        STORAGE_BUCKETS.ELEMENTS,
        teamId,
        DRAFT_ELEMENT_UPLOAD_PREFIX,
        {
          label: el.token
            ? `Element "${el.token}"`
            : `Element image #${index + 1}`,
        }
      );
      return {
        // The attach contract wants the bucket-prefixed `elements/` form.
        tempPath: `elements/${storagePath}`,
        tempPublicUrl: publicUrl,
        filename: el.filename ?? `element.${extension}`,
        // Token from the caller if given; else attach derives it from the
        // filename and the vision workflow refines it.
        token: el.token,
      };
    })
  );
}
