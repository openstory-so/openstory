import { describe, expect, it } from 'vitest';
import {
  getConfigColorPalette,
  isStyleConfigV2,
  migrateStyleConfigV1ToV2,
  parseStyleConfig,
  resolveSequenceStyleConfig,
  StyleConfigSchema,
  styleConfigHashBody,
  toStyleProjection,
  type StyleConfigV1,
} from './style-config';
import { DEFAULT_STYLE_TEMPLATES } from './style-templates';

const V1: StyleConfigV1 = {
  mood: 'tense and paranoid',
  artStyle: 'high-contrast neo-noir',
  lighting: 'low-key with hard shadows',
  colorPalette: ['#0a0a14', '#e8322f'],
  cameraWork: 'slow dolly, dutch angles',
  referenceFilms: ['rain-slicked neon-noir cityscapes'],
  colorGrading: 'crushed blacks, neon accents',
};

describe('migrateStyleConfigV1ToV2', () => {
  it('maps every v1 field into the grouped shape and validates the output', () => {
    const v2 = migrateStyleConfigV1ToV2(V1);
    expect(v2.version).toBe(2);
    expect(v2.look.mood).toBe(V1.mood);
    expect(v2.look.colorPalette).toEqual(V1.colorPalette);
    expect(v2.motion.camera).toBe(V1.cameraWork);
    expect(v2.references).toEqual(V1.referenceFilms);
    expect(() => StyleConfigSchema.parse(v2)).not.toThrow();
  });

  it('rejects a v1 blob that violates the shared constraints', () => {
    expect(() => migrateStyleConfigV1ToV2({ ...V1, mood: 'ab' })).toThrow();
  });
});

describe('resolveSequenceStyleConfig', () => {
  it('prefers the sequence snapshot over the live catalog row', () => {
    const snapshot = migrateStyleConfigV1ToV2({
      ...V1,
      mood: 'snapshot mood here',
    });
    const live = migrateStyleConfigV1ToV2({
      ...V1,
      mood: 'live catalog mood',
    });
    expect(resolveSequenceStyleConfig({ snapshot, live }).look.mood).toBe(
      'snapshot mood here'
    );
  });

  it('falls back to the live row when the snapshot is missing', () => {
    const live = migrateStyleConfigV1ToV2(V1);
    expect(resolveSequenceStyleConfig({ snapshot: null, live })).toEqual(live);
  });

  it('throws when neither snapshot nor live recipe exists', () => {
    expect(() =>
      resolveSequenceStyleConfig({ snapshot: null, live: null })
    ).toThrow(/no style config snapshot/);
  });
});

describe('parseStyleConfig', () => {
  it('passes v2 through and up-converts v1', () => {
    const v2 = migrateStyleConfigV1ToV2(V1);
    expect(parseStyleConfig(v2)).toEqual(v2);
    expect(parseStyleConfig(V1)).toEqual(v2);
  });

  it('throws loudly on blobs that are neither v1 nor v2', () => {
    // Pins the fail-loud contract: corruption must surface, not degrade —
    // a future "tolerant" catch-and-default here would mask data corruption.
    expect(() => parseStyleConfig({})).toThrow();
    expect(() => parseStyleConfig(null)).toThrow();
    expect(() => parseStyleConfig({ version: 2 })).toThrow();
    expect(() => parseStyleConfig({ mood: 'corrupt-fragment' })).toThrow();
  });
});

describe('styleConfigHashBody (hash stability across the reshape)', () => {
  it('projects a migrated v2 config to the exact v1 body, so stored hashes stay valid', () => {
    // Pre-reshape, the prompt hashes embedded the raw v1 object and
    // computeStyleConfigHash listed these exact keys. Deep equality with the
    // v1 object (canonicalize sorts keys) proves the reshape flips no hash —
    // the invariant that lets #858 land with no null-sweep migration and no
    // PROMPT_INPUT_HASH_VERSION bump.
    expect(styleConfigHashBody(migrateStyleConfigV1ToV2(V1))).toEqual({
      ...V1,
    });
    expect(styleConfigHashBody(null)).toBeNull();
  });

  it('joins authored refinements into the body — a genuine input change', () => {
    const v2 = migrateStyleConfigV1ToV2(V1);
    const authored = {
      ...v2,
      motion: { ...v2.motion, pace: 'measured' as const, energy: 2 },
    };
    expect(styleConfigHashBody(authored)).toEqual({
      ...V1,
      pace: 'measured',
      energy: 2,
    });
    // version never shapes prompt text — excluded from the body.
    expect(styleConfigHashBody(v2)).toEqual({ ...V1 });
    expect(styleConfigHashBody(v2)).not.toHaveProperty('version');
  });
});

describe('curated templates', () => {
  it('every template is valid v2 and hash-stable with its v1 projection', () => {
    for (const template of DEFAULT_STYLE_TEMPLATES) {
      expect(
        () => StyleConfigSchema.parse(template.config),
        `template "${template.name}"`
      ).not.toThrow();
      const body = styleConfigHashBody(template.config);
      expect(body).toHaveProperty('cameraWork');
      expect(body).not.toHaveProperty('version');
    }
  });
});

describe('total UI accessors and projection', () => {
  it('getConfigColorPalette reads both shapes and never throws on garbage', () => {
    expect(getConfigColorPalette(V1)).toEqual(V1.colorPalette);
    expect(getConfigColorPalette(migrateStyleConfigV1ToV2(V1))).toEqual(
      V1.colorPalette
    );
    expect(getConfigColorPalette(null)).toEqual([]);
    expect(getConfigColorPalette({ look: 'not-an-object' })).toEqual([]);
  });

  it('toStyleProjection parses the config and defaults tags', () => {
    const projection = toStyleProjection({
      name: 'Neo-Noir',
      description: null,
      category: 'film',
      tags: null,
      config: V1,
    });
    expect(projection.tags).toEqual([]);
    expect(isStyleConfigV2(projection.config)).toBe(true);
  });
});
