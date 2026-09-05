/**
 * Family grouping for the Models catalog (#458) — id-based scheme.
 *
 * Display names in the modelschemas catalog are unreliable (three different
 * Kling endpoints across three versions are all named "Kling Video"), but
 * fal's endpoint ids are a clean taxonomy:
 *
 *   fal-ai/kling-video/v2.6/pro/image-to-video
 *   └platform┘└─brand──┘└ver.┘└──── variant ────┘
 *
 * Ids are first CANONICALIZED by stripping the `fal-ai/` platform prefix —
 * fal stopped prefixing new models, so the same brand exists under both
 * roots (`fal-ai/ideogram/v3` and `ideogram/v4` are one Ideogram). One rule
 * then splits the canonical id at its first version-looking segment:
 * everything before it is the FAMILY (one card), the segment is the VERSION,
 * the tail is the VARIANT. Versions embedded in a segment split too (`veo3`,
 * `seedance-2.0`, and with trailing modifiers: `hailuo-2.3-fast` → hailuo
 * v2.3-fast). Ids with no version fall back to the first two canonical
 * segments as the family (bria/video). Families never span activities (the
 * catalog's primary grouping is output type).
 *
 * Titles are humanized from the family path with casing borrowed from
 * display names ("FLUX", "MiniMax Hailuo"). Variants sort newest version
 * first; families sort by release date (newest variant's `firstSeenAt`) —
 * today that's mostly modelschemas' tracking epoch, so ties fall back to
 * variant count, but it gets meaningful as dates are backdated.
 */
import type { CatalogActivity, CatalogModel } from './catalog';

export type ModelVariant = CatalogModel & {
  /** Normalized version label ("v3", "v2.3-fast", "o3") — null when the id carries none. */
  version: string | null;
  /** Canonical id tail after family + version ("pro/image-to-video"); '' for a bare endpoint. */
  variantLabel: string;
};

export type ModelFamily = {
  /** Canonical family id-path key, e.g. "kling-video" — unique per activity. */
  family: string;
  /** Humanized card title, e.g. "Kling Video". */
  title: string;
  activity: CatalogActivity;
  /** Version of the newest variant (null when the family is unversioned). */
  latestVersion: string | null;
  /** Newest `firstSeenAt` across variants (epoch seconds) — the sort key. */
  releasedAt: number | null;
  /** The newest version's first variant — gradient seed + single-variant link. */
  representative: ModelVariant;
  /** All variants, newest version group first, alphabetical within a group. */
  variants: ModelVariant[];
};

/** Whole segment is a version: v2.5-turbo, v3, v2a, o1, 2.0 — but not 4k/720p. */
const STANDALONE_VERSION_RE =
  /^(?:[vo]\d+(?:\.\d+)*[a-z]?(?:-[a-z0-9]+)*|\d+\.\d+)$/i;

/**
 * Trailing version inside a segment, with an optional modifier after it:
 * veo3, flux-1, seedance-2.0, mmaudio-v2, hailuo-2.3-fast, video-01-live,
 * wan-vace-14b (size-suffixed), ltx-2.3-22b (digit-leading modifier).
 */
const EMBEDDED_VERSION_RE =
  /^([a-z][a-z0-9-]*?[a-z])[-._]?v?(\d+(?:\.\d+)*b?)(-[a-z0-9][a-z0-9-]*)?$/i;

/**
 * Segments that are generation modes, not product lines — a versionless id
 * ending in one (`wan-pro/image-to-video`, `boogu-image/edit`) is a variant
 * of the segment before it.
 */
const MODE_SEGMENT_RE = /^(?:[a-z0-9]+-to-[a-z0-9]+|edit)$/;

/**
 * Hand-curated brand aliases for spellings no syntax rule can connect.
 * Keep this list tiny — everything else merges structurally.
 */
const FAMILY_ALIASES: Record<string, string> = {
  ltxv: 'ltx',
};

/**
 * fal writes some versions dotless (`wan-25-preview` is Wan 2.5): a pure
 * two-digit embedded version with a nonzero lead reads as major.minor.
 * Leading zeros (`hailuo-02`) and size suffixes (`14b`) pass through.
 */
function normalizeEmbeddedVersion(digits: string): string {
  const match = /^([1-9])(\d)$/.exec(digits);
  return match ? `${match[1]}.${match[2]}` : digits;
}

/** `fal-ai/` is the platform namespace, not a brand — drop it. */
function canonicalSegments(endpointId: string): string[] {
  const segments = endpointId.split('/');
  return segments[0] === 'fal-ai' && segments.length > 1
    ? segments.slice(1)
    : segments;
}

type SplitId = {
  familyPath: string;
  version: string | null;
  variantLabel: string;
};

/** Split a canonicalized endpoint id at its first version-looking segment. */
export function splitEndpointId(endpointId: string): SplitId {
  const segments = canonicalSegments(endpointId);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? '';
    // A standalone version segment can't be first — a family is never empty.
    if (i >= 1 && STANDALONE_VERSION_RE.test(segment)) {
      return {
        familyPath: segments.slice(0, i).join('/'),
        version: segment.toLowerCase(),
        variantLabel: segments.slice(i + 1).join('/'),
      };
    }
    const embedded = EMBEDDED_VERSION_RE.exec(segment);
    if (embedded) {
      const [, base, digits = '', modifier] = embedded;
      return {
        familyPath: [...segments.slice(0, i), base ?? segment].join('/'),
        version:
          `v${normalizeEmbeddedVersion(digits)}${modifier ?? ''}`.toLowerCase(),
        variantLabel: segments.slice(i + 1).join('/'),
      };
    }
  }

  // No version anywhere: brand + product line is the family — unless the
  // second segment is a generation mode, which belongs to the variant.
  const familyLength =
    segments.length >= 2 && MODE_SEGMENT_RE.test(segments[1] ?? '') ? 1 : 2;
  return {
    familyPath: segments.slice(0, familyLength).join('/'),
    version: null,
    variantLabel: segments.slice(familyLength).join('/'),
  };
}

// ---------------------------------------------------------------------------
// Version ordering (newest first)
// ---------------------------------------------------------------------------

type ParsedVersion = { series: string; nums: number[]; suffix: string };

function parseVersion(version: string): ParsedVersion {
  const match = /^([a-z]*)(\d+(?:\.\d+)*)(.*)$/.exec(version);
  if (!match) return { series: version, nums: [], suffix: '' };
  const [, series = '', digits = '', suffix = ''] = match;
  // A leading zero is a sub-1.0 fraction: v095 is 0.95, not ninety-five.
  const nums =
    !digits.includes('.') && digits.length > 1 && digits.startsWith('0')
      ? [Number(`0.${digits.slice(1)}`)]
      : digits.split('.').map(Number);
  return {
    // Bare numbers ("2.0") sort with the v-series.
    series: series === '' ? 'v' : series,
    nums,
    suffix,
  };
}

/** Pure parameter-size labels (v14b) — weights, not versions. */
const SIZE_VERSION_RE = /^v?\d+b(?:-.*)?$/;

/** Newest first; sizes (v14b) after real versions; null (unversioned) last. */
export function compareVersionsDesc(
  a: string | null,
  b: string | null
): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const sizeA = SIZE_VERSION_RE.test(a);
  const sizeB = SIZE_VERSION_RE.test(b);
  if (sizeA !== sizeB) return sizeA ? 1 : -1;
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const diff = (pb.nums[i] ?? 0) - (pa.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // Same numbers: the main v-series outranks letter series (v3 before o3),
  // plain before suffixed (v2.5 before v2.5-turbo) — all just deterministic.
  if (pa.series !== pb.series) {
    if (pa.series === 'v') return -1;
    if (pb.series === 'v') return 1;
    return pa.series.localeCompare(pb.series);
  }
  return pa.suffix.localeCompare(pb.suffix);
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleCase(word: string): string {
  // Short tokens with no display-name casing to borrow are usually initialisms.
  if (word.length <= 3) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Prefer the casing a display name actually uses for this word ("FLUX" from
 * "FLUX.1 [dev]", "MiniMax" from "MiniMax Hailuo 02"); fall back to Title
 * Case / initialism-upper.
 */
function borrowCasing(word: string, variants: CatalogModel[]): string {
  const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}(?![a-z0-9])`, 'i');
  for (const variant of variants) {
    const match = re.exec(variant.displayName);
    if (match && match[0] !== match[0].toLowerCase()) return match[0];
  }
  return titleCase(word);
}

function familyTitle(familyPath: string, variants: CatalogModel[]): string {
  return familyPath
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((word) => borrowCasing(word, variants))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Fold sub-line families into an existing parent line within the same
 * activity: `ltx-video` → `ltx`, `wan-vace` → `wan`,
 * `ideogram/character` → `ideogram` — the tile is the brand, the sub-line
 * moves into the variant label. Only fires when the parent actually exists
 * as a family, so vendor namespaces without a bare line (`bria/video` vs
 * `bria/genfill`) stay apart. Longest paths fold first, so chains collapse
 * (`wan-vace-apps/*` → `wan-vace` → `wan`) with labels accumulating.
 */
function mergeSubLineFamilies(groups: Map<string, ModelVariant[]>): void {
  const keys = [...groups.keys()].sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const spaceIndex = key.indexOf(' ');
    const activityPrefix = key.slice(0, spaceIndex + 1);
    const path = key.slice(spaceIndex + 1);

    let parent: string | null = null;
    for (const otherKey of groups.keys()) {
      if (otherKey === key || !otherKey.startsWith(activityPrefix)) continue;
      const otherPath = otherKey.slice(spaceIndex + 1);
      if (
        (path.startsWith(`${otherPath}-`) ||
          path.startsWith(`${otherPath}/`)) &&
        (parent === null || otherPath.length > parent.length)
      ) {
        parent = otherPath;
      }
    }
    if (parent === null) continue;

    const variants = groups.get(key);
    const target = groups.get(`${activityPrefix}${parent}`);
    if (!variants || !target) continue;
    const labelPrefix = path.slice(parent.length + 1);
    for (const variant of variants) {
      target.push({
        ...variant,
        variantLabel: [labelPrefix, variant.variantLabel]
          .filter(Boolean)
          .join('/'),
      });
    }
    groups.delete(key);
  }
}

/**
 * Group a catalog list into id-based families (see module docs). Families
 * are ordered newest release first (falling back to variant count, then
 * title, while release dates are still mostly the tracking epoch).
 */
export function groupModelsIntoFamilies(models: CatalogModel[]): ModelFamily[] {
  const groups = new Map<string, ModelVariant[]>();

  for (const model of models) {
    const split = splitEndpointId(model.endpointId);
    const familyPath = FAMILY_ALIASES[split.familyPath] ?? split.familyPath;
    // ` ` cannot appear in either part, so the key is unambiguous.
    const key = `${model.activity} ${familyPath}`;
    const variant: ModelVariant = {
      ...model,
      version: split.version,
      variantLabel: split.variantLabel,
    };
    const group = groups.get(key);
    if (group) {
      group.push(variant);
    } else {
      groups.set(key, [variant]);
    }
  }

  mergeSubLineFamilies(groups);

  const families = [...groups.entries()].flatMap(([key, variants]) => {
    const familyPath = key.slice(key.indexOf(' ') + 1);
    const sorted = [...variants].sort(
      (a, b) =>
        compareVersionsDesc(a.version, b.version) ||
        a.variantLabel.localeCompare(b.variantLabel) ||
        a.endpointId.localeCompare(b.endpointId)
    );
    const representative = sorted[0];
    if (!representative) return [];
    const seenTimes = sorted.flatMap((v) =>
      v.firstSeenAt === undefined ? [] : [v.firstSeenAt]
    );
    return [
      {
        family: familyPath,
        title: familyTitle(familyPath, sorted),
        activity: representative.activity,
        latestVersion: representative.version,
        releasedAt: seenTimes.length > 0 ? Math.max(...seenTimes) : null,
        representative,
        variants: sorted,
      },
    ];
  });

  return families.sort(
    (a, b) =>
      (b.releasedAt ?? 0) - (a.releasedAt ?? 0) ||
      b.variants.length - a.variants.length ||
      a.title.localeCompare(b.title)
  );
}
