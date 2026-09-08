import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_VISION_MODEL } from './models.config';
import { strongestSubjectKind } from '@/lib/talent/subject-kind';
import {
  buildTalentVisionMessages,
  talentMediaAnalysisSchema,
} from './talent-vision';

const talentVisionFixtureFileSchema = z.object({
  fixtures: z
    .array(
      z.object({
        match: z.object({
          userMessage: z.string(),
          model: z.string(),
        }),
        response: z.object({ content: z.string() }),
      })
    )
    .min(1),
});

const TALENT_VISION_FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../e2e/fixtures/recorded/openrouter/talent-vision'
);

describe('talentMediaAnalysisSchema', () => {
  it('accepts a full analysis object', () => {
    const parsed = talentMediaAnalysisSchema.parse({
      isCharacterSheet: true,
      subjectKind: 'human',
      suggestedName: 'Mara',
      description: 'A woman in her 30s with a sharp bob and a leather jacket.',
      age: '30s',
      gender: 'female',
      ethnicity: '',
      physicalDescription: 'Sharp bob, angular face',
      standardClothing: 'Black leather jacket, dark jeans',
      distinguishingFeatures: 'Small hoop earring',
    });
    expect(parsed.isCharacterSheet).toBe(true);
    expect(parsed.subjectKind).toBe('human');
    expect(parsed.suggestedName).toBe('Mara');
  });

  it('rejects a missing subjectKind', () => {
    expect(() =>
      talentMediaAnalysisSchema.parse({
        isCharacterSheet: false,
        suggestedName: '',
        description: 'A robot.',
        age: '',
        gender: '',
        ethnicity: '',
        physicalDescription: '',
        standardClothing: '',
        distinguishingFeatures: '',
      })
    ).toThrow();
  });

  it('rejects a missing isCharacterSheet flag', () => {
    expect(() =>
      talentMediaAnalysisSchema.parse({
        subjectKind: 'human',
        suggestedName: '',
        description: 'A person.',
        age: '',
        gender: '',
        ethnicity: '',
        physicalDescription: '',
        standardClothing: '',
        distinguishingFeatures: '',
      })
    ).toThrow();
  });
});

describe('buildTalentVisionMessages', () => {
  it('uses the singular prompt for one image', () => {
    const messages = buildTalentVisionMessages([
      { type: 'url', value: 'https://example.com/a.png' },
    ]);
    expect(messages[0]?.role).toBe('system');
    const user = messages[1];
    expect(user?.role).toBe('user');
    expect(Array.isArray(user?.content)).toBe(true);
    const parts = user?.content;
    if (!Array.isArray(parts)) throw new Error('expected multimodal content');
    expect(parts[0]).toEqual({
      type: 'text',
      content:
        'Analyze this talent reference: is the image already a character sheet? Describe the person.',
    });
    expect(parts).toHaveLength(2);
  });

  it('uses the plural prompt and one image part per source', () => {
    const messages = buildTalentVisionMessages([
      { type: 'url', value: 'https://example.com/a.png' },
      { type: 'url', value: 'https://example.com/b.png' },
    ]);
    const parts = messages[1]?.content;
    if (!Array.isArray(parts)) throw new Error('expected multimodal content');
    expect(parts[0]).toMatchObject({
      type: 'text',
      content: expect.stringContaining('these 2 images'),
    });
    expect(parts.filter((part) => part.type === 'image')).toHaveLength(2);
  });

  it('appends uploaded filenames after the classify prompt', () => {
    const messages = buildTalentVisionMessages(
      [{ type: 'url', value: 'https://example.com/a.png' }],
      ['character-sheet.jpg']
    );
    const parts = messages[1]?.content;
    if (!Array.isArray(parts)) throw new Error('expected multimodal content');
    expect(parts[0]).toEqual({
      type: 'text',
      content:
        'Analyze this talent reference: is the image already a character sheet? Describe the person.\nUploaded filename: character-sheet.jpg',
    });
  });
});

describe('e2e talent-vision aimock fixture', () => {
  // Recorded by `bun test:e2e:record e2e/tests/talent.spec.ts` against real
  // uploads of e2e/fixtures/{test-image,character-sheet,creature}.jpg — one
  // file per prompt. aimock matches userMessage exactly under the request
  // transform, so file order never matters.
  const loadFixtures = () =>
    readdirSync(TALENT_VISION_FIXTURE_DIR)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        const raw: unknown = JSON.parse(
          readFileSync(resolve(TALENT_VISION_FIXTURE_DIR, name), 'utf8')
        );
        return talentVisionFixtureFileSchema.parse(raw).fixtures;
      });

  const parseFixture = (fixture: {
    response: { content: string };
  }): ReturnType<typeof talentMediaAnalysisSchema.parse> =>
    talentMediaAnalysisSchema.parse(JSON.parse(fixture.response.content));

  it('covers the photo, the sheet and the creature uploads', () => {
    const messages = loadFixtures().map((fixture) => fixture.match.userMessage);
    expect(messages).toContain(
      'Analyze this talent reference: is the image already a character sheet? Describe the person.'
    );
    expect(
      messages.some((message) => message.includes('character-sheet.jpg'))
    ).toBe(true);
    expect(messages.some((message) => message.includes('creature.jpg'))).toBe(
      true
    );
  });

  it('parses every fixture as TalentMediaAnalysis on the vision model', () => {
    const fixtures = loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    for (const fixture of fixtures) {
      expect(fixture.match.model).toBe(DEFAULT_VISION_MODEL);
      parseFixture(fixture);
    }
  });

  it('classifies character-sheet.jpg as an animated sheet', () => {
    const fixture = loadFixtures().find((entry) =>
      entry.match.userMessage.includes('character-sheet.jpg')
    );
    if (!fixture) throw new Error('missing character-sheet.jpg fixture');
    const parsed = parseFixture(fixture);
    expect(parsed.isCharacterSheet).toBe(true);
    expect(parsed.subjectKind).toBe('animated');
  });

  it('classifies creature.jpg as other, not a sheet', () => {
    const fixture = loadFixtures().find((entry) =>
      entry.match.userMessage.includes('creature.jpg')
    );
    if (!fixture) throw new Error('missing creature.jpg fixture');
    const parsed = parseFixture(fixture);
    expect(parsed.isCharacterSheet).toBe(false);
    expect(parsed.subjectKind).toBe('other');
  });

  // The untagged prompt is the server's sheet-metadata pass in
  // create-library-talent.ts, which only runs for a sheet the client already
  // classified — the robot sheet is the only one the suite uploads.
  it('matches the singular prompt with the sheet-metadata answer', () => {
    const fixtures = loadFixtures();
    const messages = buildTalentVisionMessages([
      { type: 'url', value: 'https://example.com/a.png' },
    ]);
    const parts = messages[1]?.content;
    if (!Array.isArray(parts)) throw new Error('expected multimodal content');
    const text = parts[0];
    if (text?.type !== 'text') throw new Error('expected text part');

    const fixture = fixtures.find(
      (entry) => entry.match.userMessage === text.content
    );
    if (!fixture) throw new Error('missing generic talent-vision fixture');
    const parsed = parseFixture(fixture);
    expect(parsed.isCharacterSheet).toBe(true);
    expect(parsed.subjectKind).toBe('animated');
  });
});

describe('strongestSubjectKind', () => {
  it('does not default an empty list to human', () => {
    expect(strongestSubjectKind([])).toBe('other');
  });

  it('keeps animated when no human is present', () => {
    expect(strongestSubjectKind(['other', 'animated'])).toBe('animated');
  });

  it('prefers human when mixed', () => {
    expect(strongestSubjectKind(['animated', 'human', 'other'])).toBe('human');
  });
});
