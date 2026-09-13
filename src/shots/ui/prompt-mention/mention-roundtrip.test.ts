/**
 * The whole mention feature only earns its keep if a slug inserted via the
 * Tiptap mention dropdown round-trips through the markdown serializer and is
 * then recognised by `extractContinuityFromPrompt` on save. The Mention
 * extension serializes nodes as bare slugs (no `@`), so the on-disk form is
 * `"<text> <slug> <text>"` — exactly what the parser already handles.
 *
 * This locks two halves:
 *  1) `tagifyMarkdown` (the editor-load preprocessor) wraps known slugs into
 *     mention spans whose `data-id` IS the canonical slug — i.e. what
 *     getMarkdown() will write back.
 *  2) The bare slug is recognised by `extractContinuityFromPrompt` for cast /
 *     elements / locations.
 */

import { describe, expect, it } from 'vitest';
import {
  buildMentionItems,
  type MentionCharacterInput,
  type MentionElementInput,
  type MentionLocationInput,
} from './mention-items';
import { tagifyMarkdown } from '@/ui/text-editor/mention/tagify';
import { extractContinuityFromPrompt } from '@/shots/server/workflows/extract-continuity-from-prompt';
import type { SequenceElementMinimal } from '@/platform/server/db/schema';

const character: MentionCharacterInput = {
  id: 'c1',
  characterId: 'char_001',
  name: 'Jack',
  consistencyTag: 'char_001: jack-denim-jacket',
  sheetImageUrl: null,
};

const element: MentionElementInput = {
  id: 'e1',
  token: 'red-hex-logo',
  description: 'A red hex logo',
  imageUrl: '',
  kind: 'image',
  consistencyTag: null,
};

const location: MentionLocationInput = {
  id: 'l1',
  locationId: 'loc_001',
  name: 'INT. OFFICE',
  consistencyTag: 'loc_001: office-modern-steel',
  referenceImageUrl: null,
};

const elementMinimal: SequenceElementMinimal = {
  id: element.id,
  token: element.token,
  description: element.description ?? '',
  imageUrl: element.imageUrl,
  consistencyTag: element.consistencyTag,
  kind: 'image',
  durationSeconds: null,
};

const baseExisting = {
  characterTags: [] as string[],
  elementTags: [] as string[],
  environmentTag: '',
};

describe('mention round-trip: tagify → serialize → parse', () => {
  const items = buildMentionItems({
    characters: [character],
    elements: [element],
    locations: [location],
  });

  it('tagify highlights the ALL-CAPS cast name (no @); legacy slug re-pills to it', () => {
    const byName = tagifyMarkdown(
      'A wide shot featuring JACK on screen',
      items
    );
    expect(byName.matched).toBe(true);
    expect(byName.content).toContain('data-type="mention"');
    expect(byName.content).toContain('data-id="JACK"');
    expect(byName.content).toContain('data-section="cast"');
    // Visible text is the bare name — no leading @ (unlike elements).
    expect(byName.content).toContain('>JACK</span>');
    expect(byName.content).not.toContain('@JACK');
    // A legacy consistencyTag slug still pills, re-pilling to the name.
    const bySlug = tagifyMarkdown('hero is jack-denim-jacket here', items);
    expect(bySlug.content).toContain('data-id="JACK"');
  });

  it('inserted ALL-CAPS cast name is recognised by extractContinuityFromPrompt', () => {
    const result = extractContinuityFromPrompt({
      promptText: 'A wide shot featuring JACK on screen',
      characters: [character],
      elements: [],
      locations: [],
      existing: baseExisting,
    });
    expect(result.characterTags).toEqual(['jack']);
  });

  it('legacy character consistencyTag slug is still recognised', () => {
    const prompt = `A wide shot featuring ${character.consistencyTag?.split(':')[1]?.trim()} on screen`;
    const result = extractContinuityFromPrompt({
      promptText: prompt,
      characters: [character],
      elements: [],
      locations: [],
      existing: baseExisting,
    });
    expect(result.characterTags).toEqual(['jack-denim-jacket']);
  });

  it('serialized element slug is recognised by extractContinuityFromPrompt', () => {
    const prompt = `Close-up of ${element.token}`;
    const result = extractContinuityFromPrompt({
      promptText: prompt,
      characters: [],
      elements: [elementMinimal],
      locations: [],
      existing: baseExisting,
    });
    expect(result.elementTags).toEqual(['RED-HEX-LOGO']);
  });

  it('serialized location slug is recognised by extractContinuityFromPrompt', () => {
    const prompt = `Establishing shot in ${location.consistencyTag?.split(':')[1]?.trim()}`;
    const result = extractContinuityFromPrompt({
      promptText: prompt,
      characters: [],
      elements: [],
      locations: [location],
      existing: baseExisting,
    });
    expect(result.environmentTag).toBe('office-modern-steel');
  });
});
