import { StyleSampleVideoSchema } from '@/lib/db/schema/libraries';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { describe, expect, it } from 'vitest';
import {
  briefForStyle,
  CATEGORY_BRIEFS,
  STYLE_BRIEF_OVERRIDES,
} from '@/shared/style/brief-for-style';
import {
  beatsToScript,
  BESPOKE_SCRIPTS,
  buildSampleVideos,
  CANONICAL_SCRIPT_OVERRIDES,
  CANONICAL_TARGET_SECONDS,
  heroStyleSlugs,
  isHeroStyle,
  sampleVideoUrl,
} from './sample-videos';
import { styleSlug } from '@/shared/style/style-slug';

const DOMAIN = 'assets.openstory.so';

describe('sampleVideoUrl', () => {
  it('builds canonical and bespoke R2 URLs', () => {
    expect(sampleVideoUrl(DOMAIN, 'product-ad', 'canonical')).toBe(
      'https://assets.openstory.so/styles/product-ad/canonical.mp4'
    );
    expect(sampleVideoUrl(DOMAIN, 'product-ad', 'bespoke')).toBe(
      'https://assets.openstory.so/styles/product-ad/bespoke.mp4'
    );
  });
});

describe('buildSampleVideos', () => {
  it('returns only a canonical entry for a non-hero style', () => {
    const entries = buildSampleVideos({
      domain: DOMAIN,
      styleName: 'White Background Studio',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'canonical', order: 0 });
  });

  it('returns canonical + bespoke for a hero style', () => {
    const entries = buildSampleVideos({
      domain: DOMAIN,
      styleName: 'Product Ad',
    });
    expect(entries.map((e) => e.kind)).toEqual(['canonical', 'bespoke']);
    expect(entries.map((e) => e.order)).toEqual([0, 1]);
  });

  it('stamps the canonical target duration', () => {
    const [canonical] = buildSampleVideos({
      domain: DOMAIN,
      styleName: 'White Background Studio',
    });
    expect(canonical?.durationSeconds).toBe(CANONICAL_TARGET_SECONDS);
  });

  it('produces entries that satisfy the DB schema', () => {
    for (const style of DEFAULT_STYLE_TEMPLATES) {
      const entries = buildSampleVideos({
        domain: DOMAIN,
        styleName: style.name,
      });
      for (const entry of entries) {
        expect(() => StyleSampleVideoSchema.parse(entry)).not.toThrow();
      }
    }
  });
});

describe('hero styles', () => {
  it('every bespoke slug maps to a real template name', () => {
    const templateSlugs = new Set(
      DEFAULT_STYLE_TEMPLATES.map((s) => styleSlug(s.name))
    );
    for (const slug of heroStyleSlugs()) {
      expect(templateSlugs.has(slug)).toBe(true);
    }
  });

  it('every bespoke script has at least one beat', () => {
    for (const [slug, beats] of Object.entries(BESPOKE_SCRIPTS)) {
      expect(beats.length, slug).toBeGreaterThan(0);
    }
  });

  it('isHeroStyle matches the bespoke map', () => {
    expect(isHeroStyle('Product Ad')).toBe(true);
    expect(isHeroStyle('White Background Studio')).toBe(false);
  });
});

describe('canonical script overrides', () => {
  const templateSlugs = new Set(
    DEFAULT_STYLE_TEMPLATES.map((s) => styleSlug(s.name))
  );

  it('every override slug maps to a real template name', () => {
    for (const slug of Object.keys(CANONICAL_SCRIPT_OVERRIDES)) {
      expect(templateSlugs.has(slug), slug).toBe(true);
    }
  });

  it('every override has a non-empty script', () => {
    for (const [slug, override] of Object.entries(CANONICAL_SCRIPT_OVERRIDES)) {
      expect(override.enhancedScript.length, slug).toBeGreaterThan(50);
    }
  });
});

describe('style brief overrides', () => {
  const templateSlugs = new Set(
    DEFAULT_STYLE_TEMPLATES.map((s) => styleSlug(s.name))
  );

  it('every override slug maps to a real template name', () => {
    for (const slug of Object.keys(STYLE_BRIEF_OVERRIDES)) {
      expect(templateSlugs.has(slug), slug).toBe(true);
    }
  });

  it('every override has a non-empty brief', () => {
    for (const [slug, brief] of Object.entries(STYLE_BRIEF_OVERRIDES)) {
      expect(brief.length, slug).toBeGreaterThan(0);
    }
  });
});

describe('beatsToScript', () => {
  it('flattens beats into numbered shot prose', () => {
    const script = beatsToScript([
      { id: 'a', imagePrompt: 'A red ball.', motionPrompt: 'It rolls.' },
      { id: 'b', imagePrompt: 'A blue cube.', motionPrompt: 'It spins.' },
    ]);
    expect(script).toBe(
      'Shot 1: A red ball. It rolls.\n\nShot 2: A blue cube. It spins.'
    );
  });
});

describe('briefForStyle', () => {
  it('resolves a non-empty brief for every template category (no silent default)', () => {
    for (const style of DEFAULT_STYLE_TEMPLATES) {
      const brief = briefForStyle(style);
      expect(brief, style.name).toBeTruthy();
    }
  });

  it('throws on an unmapped category', () => {
    expect(() =>
      briefForStyle({ name: 'Mystery Style', category: 'not-a-real-category' })
    ).toThrow();
  });

  it('gives every film-genre style its own brief or script (the shared film brief made action have no action)', () => {
    const filmStyles = DEFAULT_STYLE_TEMPLATES.filter(
      (s) => s.category === 'film'
    );
    expect(filmStyles.length).toBeGreaterThan(0);
    for (const style of filmStyles) {
      const slug = styleSlug(style.name);
      const hasOwnBrief =
        briefForStyle(style) !== CATEGORY_BRIEFS['film'] ||
        slug in CANONICAL_SCRIPT_OVERRIDES;
      expect(
        hasOwnBrief,
        `${style.name} falls back to the generic film brief`
      ).toBe(true);
    }
  });
});
