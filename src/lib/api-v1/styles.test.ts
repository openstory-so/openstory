import { describe, expect, it } from 'vitest';
import type { Style } from '@/lib/db/schema/libraries';
import {
  apiCreateStyleSchema,
  EXAMPLE_CREATE_STYLE_BODY,
} from './style-input-schema';
import { styleDocument } from './styles';

const V2_CONFIG = EXAMPLE_CREATE_STYLE_BODY.config;

describe('apiCreateStyleSchema', () => {
  it('requires a v2 config and drops server-managed fields', () => {
    expect(apiCreateStyleSchema.safeParse({ name: 'A' }).success).toBe(false);
    expect(
      apiCreateStyleSchema.safeParse({
        name: 'A',
        config: { ...V2_CONFIG, version: 1 },
      }).success
    ).toBe(false);
    const parsed = apiCreateStyleSchema.parse({
      name: 'A',
      config: V2_CONFIG,
      isPublic: true,
      sequenceId: 'seq',
      usageCount: 99,
    });
    expect(Object.keys(parsed)).toEqual(['name', 'config']);
  });
});

describe('styleDocument', () => {
  it('links self and a create-sequence affordance pre-filled with the id', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal fixture: the document reads only the listed columns
    const row = {
      id: '01STYLE',
      name: 'Neon',
      description: null,
      category: 'film',
      tags: ['noir'],
      useCases: null,
      config: V2_CONFIG,
      isTemplate: false,
      defaultAspectRatio: null,
      recommendedImageModel: null,
      recommendedVideoModel: null,
      previewUrl: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    } as unknown as Style;
    const doc = styleDocument(row);
    expect(doc._links.self?.href).toBe('/api/v1/styles/01STYLE');
    expect(doc._links['create-sequence']?.examples?.[0]).toMatchObject({
      style: '01STYLE',
    });
    expect(doc.useCases).toEqual([]);
    expect(doc.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
