/**
 * Resolvers that turn the public API's human-friendly references into the
 * concrete ids / uploads `createSequences` expects:
 *   - style:   id | name | slug  → styleId (auto-pick a default when omitted)
 *   - talent:  id | name         → suggestedTalentIds
 *   - location:id | name         → suggestedLocationIds
 *   - element: hosted URL        → promoted TempElementUpload
 *
 * Every lookup goes through the team-scoped `list()` (team-owned + public), so
 * a caller can never resolve another team's private library entry.
 */

import type { Style } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { NotFoundError } from '@/lib/errors';
import type { TempElementUpload } from '@/lib/sequence-elements/promote-temp-elements';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import type { ApiCreateSequenceInput } from './input-schema';
import { ingestImageToTempBucket } from './safe-fetch';

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

type TalentCreate = Exclude<
  NonNullable<ApiCreateSequenceInput['characters']>[number],
  string
>;
type LocationCreate = Exclude<
  NonNullable<ApiCreateSequenceInput['locations']>[number],
  string
>;

type TalentResolveDeps = {
  talent: Pick<ScopedDb['talent'], 'list'>;
  createTalent: (input: TalentCreate) => Promise<{ id: string }>;
};
type LocationResolveDeps = {
  locations: Pick<ScopedDb['locations'], 'list'>;
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
 * Resolve a mixed list of talent items — reference strings (id|name) and inline
 * create objects — into a deduped list of talent ids for `suggestedTalentIds`.
 * Inline creates matching an existing name (or a name already created in this
 * list) reuse that id. New names are delegated to `deps.createTalent`.
 */
export async function resolveTalentIds(
  deps: TalentResolveDeps,
  items: ApiCreateSequenceInput['characters']
): Promise<string[]> {
  if (!items || items.length === 0) return [];
  const { refs, creates } = partition(items);
  const ids: string[] = [];

  const all = await deps.talent.list();
  const seen = new Map<string, string>();
  for (const talent of all) {
    seen.set(talent.id, talent.id);
    seen.set(slugify(talent.name), talent.id);
  }

  for (const ref of refs) {
    const match = all.find((t) => matchesRef(ref, t));
    if (!match) {
      throw new NotFoundError(`No character/talent found matching "${ref}".`);
    }
    ids.push(match.id);
    seen.set(slugify(match.name), match.id);
  }

  for (const create of creates) {
    const existingId = seen.get(slugify(create.name));
    if (existingId) {
      ids.push(existingId);
      continue;
    }
    const created = await deps.createTalent(create);
    ids.push(created.id);
    seen.set(slugify(create.name), created.id);
  }

  return [...new Set(ids)];
}

/**
 * Resolve a mixed list of location items — reference strings (id|name) and
 * inline create objects — into a deduped list of ids for `suggestedLocationIds`.
 * Inline-create is delegated to `deps.createLocation`.
 */
export async function resolveLocationIds(
  deps: LocationResolveDeps,
  items: ApiCreateSequenceInput['locations']
): Promise<string[]> {
  if (!items || items.length === 0) return [];
  const { refs, creates } = partition(items);
  const ids: string[] = [];

  const all = await deps.locations.list();
  const seen = new Map<string, string>();
  for (const location of all) {
    seen.set(location.id, location.id);
    seen.set(slugify(location.name), location.id);
  }

  for (const ref of refs) {
    const match = all.find((l) => matchesRef(ref, l));
    if (!match) {
      throw new NotFoundError(`No location found matching "${ref}".`);
    }
    ids.push(match.id);
    seen.set(slugify(match.name), match.id);
  }

  for (const create of creates) {
    const existingId = seen.get(slugify(create.name));
    if (existingId) {
      ids.push(existingId);
      continue;
    }
    const created = await deps.createLocation(create);
    ids.push(created.id);
    seen.set(slugify(create.name), created.id);
  }

  return [...new Set(ids)];
}

/**
 * Ingest caller-hosted reference images into element temp storage and return
 * `TempElementUpload`s for `promoteTempElements`. Vision is intentionally NOT
 * run here: promotion leaves `visionStatus: pending`, which fires the
 * `element-vision` workflow, and analyze-script's `waitForElementVision` gate
 * blocks scene-split until it completes — so the request stays fast.
 */
export async function ingestElements(
  teamId: string,
  elements: ApiCreateSequenceInput['elements']
): Promise<TempElementUpload[]> {
  if (!elements || elements.length === 0) return [];

  return Promise.all(
    elements.map(async (el, index) => {
      const { tempPath, publicUrl, extension } = await ingestImageToTempBucket(
        el.url,
        STORAGE_BUCKETS.ELEMENTS,
        teamId,
        {
          label: el.token
            ? `Element "${el.token}"`
            : `Element image #${index + 1}`,
        }
      );
      return {
        // promote contract wants the bucket-prefixed `elements/` form.
        tempPath: `elements/${tempPath}`,
        tempPublicUrl: publicUrl,
        filename: el.filename ?? `element.${extension}`,
        // Token from the caller if given; else promote derives it from the
        // filename and the vision workflow refines it.
        token: el.token,
      };
    })
  );
}
