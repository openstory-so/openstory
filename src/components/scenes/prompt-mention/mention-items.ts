/**
 * Builds the sectioned mention-item list from sequence characters, elements,
 * and locations. The `tag` field is the canonical string inserted into the
 * prompt and recognised by `extract-continuity-from-prompt.ts`.
 */

import type {
  CharacterWithTalent,
  SequenceElement,
  SequenceLocation,
} from '@/lib/db/schema';

/**
 * `references` = stills, clips, and audio attached to a studio composer
 * (pill `@ImageN` / `@VideoN` / `@AudioN`);
 * `images` = the team's generated stills, offered so picking one attaches it.
 */
export type MentionSection =
  | 'references'
  | 'elements'
  | 'cast'
  | 'locations'
  | 'images';

/** Sections whose pill renders with a leading `@` (the tag has no CAPS form). */
export function mentionShowsAt(section: MentionSection): boolean {
  return (
    section === 'locations' || section === 'references' || section === 'images'
  );
}

/** Fields buildMentionItems actually consumes. */
export type MentionCharacterInput = Pick<
  CharacterWithTalent,
  'id' | 'characterId' | 'name' | 'consistencyTag' | 'sheetImageUrl'
>;
export type MentionElementInput = Pick<
  SequenceElement,
  'id' | 'token' | 'description' | 'imageUrl' | 'consistencyTag'
>;
export type MentionLocationInput = Pick<
  SequenceLocation,
  'id' | 'locationId' | 'name' | 'consistencyTag' | 'referenceImageUrl'
>;

export type MentionItem = {
  id: string;
  section: MentionSection;
  /** Display label (e.g. character name or element token). */
  label: string;
  /** Optional secondary line (e.g. character id, location id). */
  sublabel?: string;
  /** Canonical tag inserted into the prompt + emitted by the markdown serializer. */
  tag: string;
  /**
   * Additional patterns that should also pill to this item when found in
   * existing prompt text. Used for legacy formats (e.g. elements stored as
   * `RED HEX LOGO` uppercase-with-spaces) so old prompts still pill — saving
   * the prompt re-serializes everything to the canonical `tag`, soft-migrating
   * the storage format on edit.
   */
  aliases?: string[];
  /** Lowercase haystack for filtering. */
  haystack: string;
  thumbnailUrl?: string | null;
};

/** Strip "char_001: " prefix from a consistencyTag to get the slug half. */
function consistencyTagSlug(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  const slug = (idx >= 0 ? raw.slice(idx + 1) : raw).trim();
  return slug.length > 0 ? slug : null;
}

export function buildMentionItems(args: {
  characters: MentionCharacterInput[];
  elements: MentionElementInput[];
  locations: MentionLocationInput[];
}): MentionItem[] {
  const items: MentionItem[] = [];

  for (const el of args.elements) {
    // The element's UPPERCASE_SNAKE token IS its identifier — the exact form the
    // script, prompts, and continuity.elementTags all use. Highlight it in place
    // (no `@`), exactly like a cast name.
    const tag = el.token;
    // Legacy kebab `consistencyTag` prompts (from before elements used the
    // token) still pill, re-pilling to the token on save.
    const slug = consistencyTagSlug(el.consistencyTag);
    const aliases = slug && slug !== tag ? [slug] : undefined;
    items.push({
      id: `element:${el.id}`,
      section: 'elements',
      label: tag,
      sublabel: el.description ?? undefined,
      tag,
      ...(aliases ? { aliases } : {}),
      haystack: [tag, el.description ?? '', el.consistencyTag ?? '']
        .join(' ')
        .toLowerCase(),
      thumbnailUrl: el.imageUrl,
    });
  }

  for (const c of args.characters) {
    const slug = consistencyTagSlug(c.consistencyTag);
    // The cast tag is the character's ALL-CAPS name — the exact form the script
    // and the visual/motion prompts already use ("NAME IN CAPS"). The mention
    // selector inserts it and tagify highlights it in place; unlike elements /
    // locations it renders with no `@` prefix (see mention-extension/tagify).
    const tag = c.name.toUpperCase();
    // The consistencyTag slug and characterId are the canonical forms the
    // server-side continuity parser emits — keep them as aliases so prompts
    // already carrying those still pill (and re-pill to the name on save).
    const aliases = [slug, c.characterId].filter(
      (a): a is string => a !== null && a !== tag
    );
    items.push({
      id: `character:${c.id}`,
      section: 'cast',
      label: c.name,
      sublabel: slug ?? c.characterId,
      tag,
      ...(aliases.length > 0 ? { aliases } : {}),
      haystack: [c.name, tag, c.characterId, slug ?? '']
        .join(' ')
        .toLowerCase(),
      thumbnailUrl: c.sheetImageUrl,
    });
  }

  for (const loc of args.locations) {
    const slug = consistencyTagSlug(loc.consistencyTag);
    const tag = slug ?? loc.locationId;
    items.push({
      id: `location:${loc.id}`,
      section: 'locations',
      label: loc.name,
      sublabel: tag,
      tag,
      haystack: [loc.name, tag, loc.locationId, slug ?? '']
        .join(' ')
        .toLowerCase(),
      thumbnailUrl: loc.referenceImageUrl,
    });
  }

  return items;
}

export function filterMentionItems(
  items: MentionItem[],
  query: string
): MentionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.haystack.includes(q));
}

/**
 * Attrs written onto the Tiptap mention node when a dropdown row is chosen.
 *
 * The suggestion plugin sometimes hands the command the raw `MentionItem`
 * (`id` is `element:<ulid>` / `character:<ulid>`). Inserting that id produces
 * a pill the continuity parser never recognises — selecting an element from
 * the @ dropdown looks like a no-op. Prefer `tag` (the canonical token) when
 * present; already-mapped `{ id, section, label }` attrs pass through.
 */
export function mentionInsertAttrs(item: {
  id: string | null;
  section: MentionSection | null;
  label: string | null;
  tag?: string;
}): {
  id: string | null;
  section: MentionSection | null;
  label: string | null;
} {
  return {
    id: item.tag || item.id,
    section: item.section,
    label: item.label,
  };
}

export const SECTION_LABELS: Record<MentionSection, string> = {
  references: 'Attached',
  elements: 'Elements',
  cast: 'Cast',
  locations: 'Locations',
  images: 'Images',
};

export const SECTION_ORDER: MentionSection[] = [
  'references',
  'elements',
  'cast',
  'locations',
  'images',
];
