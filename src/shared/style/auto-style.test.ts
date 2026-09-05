import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WORKFLOW_CHAT_PROMPTS } from '@/lib/prompts/workflow-prompts';
import {
  AUTO_STYLE_PLACEHOLDER_NAME,
  DEFAULT_AUTO_STYLE_CATEGORY,
  DEFAULT_AUTO_STYLE_PACE,
  STYLE_CATEGORIES,
  autoStyleResponseSchema,
  type AutoStyleResponse,
  autoStyleDraftFromResponse,
  placeholderAutoStyleDraft,
} from './auto-style';
import { STYLE_PACE_VALUES, StyleConfigSchema } from './style-config';

const RESPONSE: AutoStyleResponse = {
  name: 'Rain-slick Neon Noir',
  description: 'Wet streets, sodium and neon, patient camera.',
  category: 'film',
  tags: ['noir', 'neon', 'night'],
  mood: 'tense and paranoid',
  artStyle: 'high-contrast photorealism',
  medium: '35mm anamorphic',
  lighting: 'practical neon and sodium vapour, hard shadows',
  colorPalette: ['#0a0a14', '#e8322f', ' ', '#2bd1ff'],
  colorGrading: 'crushed blacks, teal shadows',
  camera: 'slow dollies, static wides',
  shots: 'wide establishing, tight inserts',
  pace: 'measured',
  energy: 7.4,
  references: ['rain-slicked neon-noir cityscapes', ''],
};

describe('autoStyleDraftFromResponse', () => {
  it('builds a valid v2 config and row fields', () => {
    const draft = autoStyleDraftFromResponse(RESPONSE);
    expect(() => StyleConfigSchema.parse(draft.config)).not.toThrow();
    expect(draft.name).toBe('Rain-slick Neon Noir');
    expect(draft.category).toBe('film');
    expect(draft.tags).toEqual(['noir', 'neon', 'night']);
    expect(draft.config.look.colorPalette).toEqual([
      '#0a0a14',
      '#e8322f',
      '#2bd1ff',
    ]);
    expect(draft.config.references).toEqual([
      'rain-slicked neon-noir cityscapes',
    ]);
    expect(draft.config.look.medium).toBe('35mm anamorphic');
    expect(draft.config.motion.shots).toBe('wide establishing, tight inserts');
  });

  it('clamps energy into 1–5 and rounds it', () => {
    expect(autoStyleDraftFromResponse(RESPONSE).config.motion.energy).toBe(5);
    expect(
      autoStyleDraftFromResponse({ ...RESPONSE, energy: 0.2 }).config.motion
        .energy
    ).toBe(1);
    expect(
      autoStyleDraftFromResponse({ ...RESPONSE, energy: 2.6 }).config.motion
        .energy
    ).toBe(3);
  });

  it('drops blank optional refinements instead of storing empty strings', () => {
    const draft = autoStyleDraftFromResponse({
      ...RESPONSE,
      medium: '  ',
      shots: '',
      description: ' ',
    });
    expect(draft.config.look.medium).toBeUndefined();
    expect(draft.config.motion.shots).toBeUndefined();
    expect(draft.description).toBeNull();
  });

  it('throws on an unsalvageable answer (empty palette, blank name, terse prose)', () => {
    expect(() =>
      autoStyleDraftFromResponse({ ...RESPONSE, colorPalette: [' '] })
    ).toThrow();
    expect(() =>
      autoStyleDraftFromResponse({ ...RESPONSE, name: '  ' })
    ).toThrow();
    expect(() =>
      autoStyleDraftFromResponse({ ...RESPONSE, mood: 'ok' })
    ).toThrow();
  });
});

describe('placeholderAutoStyleDraft', () => {
  it('is a valid config with the placeholder name', () => {
    const draft = placeholderAutoStyleDraft();
    expect(draft.name).toBe(AUTO_STYLE_PLACEHOLDER_NAME);
    expect(() => StyleConfigSchema.parse(draft.config)).not.toThrow();
  });
});

describe('autoStyleResponseSchema vocabulary (#1285, #1410)', () => {
  it('rejects off-vocabulary category/pace at parse (no .catch() on the enum)', () => {
    expect(() =>
      autoStyleResponseSchema.parse({
        ...RESPONSE,
        category: 'Documentary',
        pace: 'rapid',
      })
    ).toThrow();
    expect(autoStyleResponseSchema.parse(RESPONSE).category).toBe('film');
  });

  it('defaults off-vocabulary category/pace in the draft, not the schema', () => {
    const draft = autoStyleDraftFromResponse({
      ...RESPONSE,
      category: 'Documentary',
      pace: 'rapid',
    });
    expect(draft.category).toBe(DEFAULT_AUTO_STYLE_CATEGORY);
    expect(draft.config.motion.pace).toBe(DEFAULT_AUTO_STYLE_PACE);
    expect(StyleConfigSchema.safeParse(draft.config).success).toBe(true);
  });

  it('still sends the enum to the provider without a default/null union', () => {
    const json = z.toJSONSchema(autoStyleResponseSchema);
    expect(json.properties?.category).toMatchObject({
      type: 'string',
      enum: [...STYLE_CATEGORIES],
    });
    expect(json.properties?.category).not.toHaveProperty('default');
    expect(json.properties?.pace).toMatchObject({
      type: 'string',
      enum: [...STYLE_PACE_VALUES],
    });
    expect(json.properties?.pace).not.toHaveProperty('default');
  });
});

/**
 * Captured 2026-08-25 from anthropic/claude-opus-5 via OpenRouter on
 * sequence 01M0W9PBK86ZW4W4WAX004SSVF (PostHog trace
 * fd96530f9515f49ce0129f0c3c525d8d). The model followed the prompt's LOOK /
 * MOTION headings and omitted every flat recipe string.
 */
const COLLAPSED_OPUS_OUTPUT = {
  name: 'Bioluminescent Lab Noir',
  description:
    'A dark, cinematic science-explainer look where glowing molecular structures and clinical lab macro imagery float in inky black space, graded cyan-teal with sterile white highlights.',
  look: 'Photoreal CGI-meets-scientific-visualization rendered as if shot on a full-frame digital cinema camera with fast macro and 50mm primes. Everything lives in near-black negative space: subjects are isolated on a void with faint volumetric haze and drifting dust motes catching the light. Key illumination is self-emissive — DNA helices, sequence read-outs and phage capsids glow from within with soft bloom and thin lens diffraction.',
  motion:
    'Slow, deliberate, gravity-free camera work: continuous slow push-ins on macro subjects, gentle orbital dollies around suspended structures, and micro-parallax drifts that make the void feel three-dimensional.',
  colorPalette: [
    '#05080f',
    '#0d2b3a',
    '#2fe3d6',
    '#e8f6ff',
    '#7b3cc4',
    '#123f4d',
  ],
  references: [
    'self-illuminated molecular structures suspended in black voids',
    'clinical laboratory macro photography with wet specular highlights',
    'cold cyan holographic data read-outs on glass',
  ],
  category: 'tech',
  tags: ['science', 'explainer', 'biotech', 'macro', 'cinematic', 'dark'],
  energy: 2,
  pace: 'measured',
};

describe('autoStyleResponseSchema collapsed look/motion (#1304)', () => {
  it('salvages the captured Opus output instead of failing the parse', () => {
    const parsed = autoStyleResponseSchema.parse(COLLAPSED_OPUS_OUTPUT);
    expect(parsed.name).toBe('Bioluminescent Lab Noir');
    expect(parsed.category).toBe('tech');
    expect(parsed.mood).toContain(
      'Photoreal CGI-meets-scientific-visualization'
    );
    expect(parsed.artStyle).toContain(
      'Photoreal CGI-meets-scientific-visualization'
    );
    expect(parsed.lighting).toContain('self-emissive');
    expect(parsed.colorGrading).toContain(
      'Photoreal CGI-meets-scientific-visualization'
    );
    expect(parsed.camera).toContain('Slow, deliberate, gravity-free');
    expect(parsed.medium).toBe('');
    expect(parsed.shots).toBe('');
    const draft = autoStyleDraftFromResponse(parsed);
    expect(StyleConfigSchema.safeParse(draft.config).success).toBe(true);
    expect(draft.config.look.medium).toBeUndefined();
    expect(draft.config.motion.shots).toBeUndefined();
    expect(draft.config.motion.energy).toBe(2);
  });

  it('fills omitted recipe strings from the placeholder so a guess never fails the run', () => {
    const parsed = autoStyleResponseSchema.parse({
      name: 'Bare Bones',
      description: 'Almost nothing.',
      category: 'film',
      tags: [],
      colorPalette: ['#111111'],
      energy: 3,
      pace: 'measured',
      references: [],
    });
    expect(parsed.mood).toBe('grounded, naturalistic');
    expect(parsed.artStyle).toBe('photorealistic live action');
    expect(parsed.lighting).toBe('motivated natural light');
    expect(parsed.colorGrading).toBe('neutral, true-to-life');
    expect(parsed.camera).toBe('steady, classical coverage');
    expect(parsed.medium).toBe('');
    expect(parsed.shots).toBe('');
    expect(
      StyleConfigSchema.safeParse(autoStyleDraftFromResponse(parsed).config)
        .success
    ).toBe(true);
  });

  it('splits a comma-separated colorPalette string instead of failing the parse', () => {
    // Captured 2026-08-28 from anthropic/claude-sonnet-5 via OpenRouter on
    // sequence 01M1352KQT8288MYT5THGKK8AX (trace 73a15d673d005d7c8bd0e4a290c4af1c).
    // The prompt listed colorPalette under "each its own string" with a single
    // hex example, so Sonnet emitted a CSV instead of an array. Zod then
    // threw `colorPalette: Invalid input: expected array, received string`.
    const parsed = autoStyleResponseSchema.parse({
      name: 'Quiet Doorstep Mourning',
      description:
        'A restrained 1957 period drama moment where grief passes silently between two people in a dim apartment doorway.',
      mood: 'Restrained, quietly devastating grief held beneath a surface of formal politeness and unspoken history',
      artStyle:
        'Photoreal live-action period drama, understated and observational rather than theatrical',
      medium:
        '35mm spherical film emulation, shallow depth of field, fine natural grain',
      lighting:
        'Soft available light motivated from a hallway window and a single interior lamp',
      colorPalette: '#2b241d, #4a3f33, #6e5c47, #8c7a63, #1d1a16, #a89b82',
      colorGrading:
        'Desaturated warm-neutral base with lifted blacks, muted highlights',
      camera:
        'Locked-off to near-static handheld with almost imperceptible drift',
      shots:
        'Doorway two-shot, close medium on Henri, settled interior two-shot',
      pace: 'slow',
      energy: 1,
      category: 'film',
      tags: ['period drama', 'restrained grief'],
      references: [
        'post-war European apartment interiors with worn wooden doorframes',
      ],
    });
    expect(parsed.colorPalette).toEqual([
      '#2b241d',
      '#4a3f33',
      '#6e5c47',
      '#8c7a63',
      '#1d1a16',
      '#a89b82',
    ]);
    expect(
      StyleConfigSchema.safeParse(autoStyleDraftFromResponse(parsed).config)
        .success
    ).toBe(true);
  });

  it('splits a space-separated colorPalette string', () => {
    const parsed = autoStyleResponseSchema.parse({
      name: 'Bare Bones',
      description: 'Almost nothing.',
      category: 'film',
      tags: [],
      colorPalette: '#0a0a14 #e8322f #2bd1ff',
      energy: 3,
      pace: 'measured',
      references: [],
    });
    expect(parsed.colorPalette).toEqual(['#0a0a14', '#e8322f', '#2bd1ff']);
  });

  it('lifts nested look/motion objects onto the flat fields', () => {
    const parsed = autoStyleResponseSchema.parse({
      name: 'Nested Noir',
      description: 'Object-shaped look and motion.',
      category: 'film',
      tags: ['noir'],
      look: {
        mood: 'tense and paranoid nights',
        artStyle: 'high-contrast photorealism',
        lighting: 'practical neon and sodium vapour',
        colorGrading: 'crushed blacks, teal shadows',
        medium: '35mm anamorphic',
      },
      motion: {
        camera: 'slow dollies, static wides',
        shots: 'wide establishing, tight inserts',
      },
      colorPalette: ['#0a0a14'],
      energy: 2,
      pace: 'measured',
      references: ['rain-slicked neon-noir cityscapes'],
    });
    expect(parsed.mood).toBe('tense and paranoid nights');
    expect(parsed.artStyle).toBe('high-contrast photorealism');
    expect(parsed.medium).toBe('35mm anamorphic');
    expect(parsed.camera).toBe('slow dollies, static wides');
    expect(parsed.shots).toBe('wide establishing, tight inserts');
  });

  it('does not advertise look/motion on the provider schema', () => {
    const json = z.toJSONSchema(autoStyleResponseSchema);
    expect(json.properties).not.toHaveProperty('look');
    expect(json.properties).not.toHaveProperty('motion');
    expect(json.properties?.colorPalette).toMatchObject({
      type: 'array',
      items: { type: 'string' },
      description: expect.stringMatching(/array of 3–6 hex/i),
    });
    expect(json.required).toEqual(
      expect.arrayContaining([
        'mood',
        'artStyle',
        'medium',
        'lighting',
        'colorPalette',
        'colorGrading',
        'camera',
        'shots',
      ])
    );
  });

  it('names every recipe field in the prompt and does not invite look/motion keys', () => {
    const system =
      WORKFLOW_CHAT_PROMPTS['phase/automatic-style-chat']?.[0]?.content ?? '';
    for (const field of [
      'mood',
      'artStyle',
      'medium',
      'lighting',
      'colorPalette',
      'colorGrading',
      'camera',
      'shots',
      'pace',
      'energy',
      'name',
      'description',
      'category',
      'tags',
      'references',
    ]) {
      expect(system).toContain(`\`${field}\``);
    }
    expect(system).not.toContain('`look`');
    expect(system).not.toContain('`motion`');
  });
});
