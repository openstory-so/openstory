/**
 * Composer draft persist/restore (#1384): typed and shuffled scripts survive
 * login remount; a Try/Use-this-style seed for a different style still wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, v);
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
};

describe('sequence composer draft', () => {
  beforeEach(() => {
    mem.clear();
    vi.stubGlobal('window', { localStorage: localStorageMock });
    vi.stubGlobal('localStorage', localStorageMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('persists a Shuffle/Try sample as the script, not as empty', async () => {
    const { persistableComposerDraft } = await import('./sequence-draft');

    expect(
      persistableComposerDraft({
        script: 'A neon diner at dawn.',
        styleId: 'product-ad',
        sampleStyleId: 'product-ad',
        selectedTalentIds: [],
        selectedLocationIds: [],
        elementUploads: [],
      })
    ).toMatchObject({
      script: 'A neon diner at dawn.',
      styleId: 'product-ad',
      sampleStyleId: 'product-ad',
    });
  });

  it('round-trips sampleStyleId and accepts drafts saved before that field', async () => {
    const {
      SEQUENCE_DRAFT_STORAGE_KEY,
      readSequenceDraft,
      writeSequenceDraft,
    } = await import('./sequence-draft');

    writeSequenceDraft({
      script: 'Shuffled brief',
      styleId: 'noir',
      sampleStyleId: 'noir',
      selectedTalentIds: [],
      selectedLocationIds: [],
      elementUploads: [],
    });
    expect(readSequenceDraft()).toMatchObject({
      script: 'Shuffled brief',
      styleId: 'noir',
      sampleStyleId: 'noir',
    });

    mem.set(
      SEQUENCE_DRAFT_STORAGE_KEY,
      JSON.stringify({
        script: 'Typed before sampleStyleId existed',
        styleId: 'auto',
        selectedTalentIds: [],
        selectedLocationIds: [],
        elementUploads: [],
        savedAt: Date.now(),
      })
    );
    expect(readSequenceDraft()).toMatchObject({
      script: 'Typed before sampleStyleId existed',
      styleId: 'auto',
      sampleStyleId: null,
    });
  });

  it('drops an expired draft', async () => {
    const { readSequenceDraft, writeSequenceDraft } =
      await import('./sequence-draft');

    writeSequenceDraft({
      script: 'stale',
      styleId: 'auto',
      sampleStyleId: null,
      selectedTalentIds: [],
      selectedLocationIds: [],
      elementUploads: [],
    });
    vi.setSystemTime(new Date('2026-08-30T12:00:01Z'));
    expect(readSequenceDraft()).toBeNull();
  });
});

describe('shouldRestoreComposerDraft', () => {
  it('restores typed text on a blank composer (login / reload)', async () => {
    const { shouldRestoreComposerDraft } = await import('./sequence-draft');

    expect(
      shouldRestoreComposerDraft({
        isEditing: false,
        draft: { script: 'INT. KITCHEN - DAY', styleId: 'auto' },
      })
    ).toBe(true);
  });

  it('restores a shuffled sample after login when the URL still has that style', async () => {
    const { shouldRestoreComposerDraft } = await import('./sequence-draft');

    expect(
      shouldRestoreComposerDraft({
        isEditing: false,
        draft: { script: 'A neon diner at dawn.', styleId: 'product-ad' },
        initialStyleId: 'product-ad',
      })
    ).toBe(true);
  });

  it('restores edits over a Try seed for the same style', async () => {
    const { shouldRestoreComposerDraft } = await import('./sequence-draft');

    expect(
      shouldRestoreComposerDraft({
        isEditing: false,
        draft: { script: 'User rewrite of the sample', styleId: 'product-ad' },
        initialScript: 'Original sample brief',
        initialStyleId: 'product-ad',
      })
    ).toBe(true);
  });

  it('does not restore over a Try / Use-this-style seed for a different style', async () => {
    const { shouldRestoreComposerDraft } = await import('./sequence-draft');

    expect(
      shouldRestoreComposerDraft({
        isEditing: false,
        draft: { script: 'Old diner draft', styleId: 'auto' },
        initialScript: 'Product ad sample',
        initialStyleId: 'product-ad',
      })
    ).toBe(false);
  });

  it('does not restore an empty draft or while editing', async () => {
    const { shouldRestoreComposerDraft } = await import('./sequence-draft');

    expect(
      shouldRestoreComposerDraft({
        isEditing: false,
        draft: { script: '   ', styleId: 'auto' },
      })
    ).toBe(false);
    expect(
      shouldRestoreComposerDraft({
        isEditing: true,
        draft: { script: 'INT. KITCHEN - DAY', styleId: 'auto' },
      })
    ).toBe(false);
  });
});
