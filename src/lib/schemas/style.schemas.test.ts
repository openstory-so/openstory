import { describe, expect, it } from 'vitest';
import { migrateStyleConfigV1ToV2 } from '@/lib/style/style-config';
import { createStyleSchema, updateStyleSchema } from './style.schemas';

const baseConfig = migrateStyleConfigV1ToV2({
  mood: 'neutral',
  artStyle: 'cinematic',
  lighting: 'natural',
  colorPalette: ['#000', '#fff'],
  cameraWork: 'static',
  referenceFilms: [],
  colorGrading: 'neutral',
});

// Every SERVER_MANAGED_COLUMNS entry, injected as a malicious payload — the
// tests pin the full omit list, so dropping any entry fails here.
const serverManagedPayload = {
  id: 'attacker-chosen-id',
  isPublic: true,
  isTemplate: true,
  teamId: 'other-team',
  createdBy: 'other-user',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  usageCount: 99,
  version: 99,
  sortOrder: 1,
};

describe('style schemas', () => {
  it('strips client-provided server-managed columns when creating a style', () => {
    const parsed = createStyleSchema.parse({
      name: 'Team Style',
      config: baseConfig,
      category: 'film',
      ...serverManagedPayload,
    });

    expect(parsed).toMatchObject({
      name: 'Team Style',
      config: baseConfig,
      category: 'film',
    });
    for (const column of Object.keys(serverManagedPayload)) {
      expect(parsed).not.toHaveProperty(column);
    }
  });

  it('strips client-provided server-managed columns when updating a style', () => {
    const parsed = updateStyleSchema.parse({
      name: 'Updated Style',
      ...serverManagedPayload,
    });

    expect(parsed).toEqual({ name: 'Updated Style' });
  });

  it('requires category on create and defaults tags/useCases to []', () => {
    expect(() =>
      createStyleSchema.parse({ name: 'X', config: baseConfig })
    ).toThrow();
    const parsed = createStyleSchema.parse({
      name: 'X',
      config: baseConfig,
      category: 'film',
    });
    expect(parsed.tags).toEqual([]);
    expect(parsed.useCases).toEqual([]);
  });

  it('takes config whole-or-omitted on update (no partial config patches)', () => {
    expect(updateStyleSchema.parse({}).config).toBeUndefined();
    expect(() =>
      updateStyleSchema.parse({ config: { look: baseConfig.look } })
    ).toThrow();
  });
});
