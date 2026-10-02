import { describe, expect, it } from 'vitest';
import {
  derivePublishRequestId,
  publishInputSchema,
  PUBLISH_REQUEST_ID_RE,
  type PublishInput,
} from './social-publish';

const base: PublishInput & { teamId: string } = {
  teamId: '01TEAM',
  sequenceId: '01SEQUENCE',
  exportId: '01EXPORT',
  profile: 'creator',
  platforms: ['tiktok', 'youtube'],
  title: 'My film',
  description: '',
  youtubePrivacy: 'private',
  tiktokPrivacy: 'account_default',
};

describe('derivePublishRequestId', () => {
  it('is stable for the same publish, whatever the platform order', async () => {
    const a = await derivePublishRequestId(base);
    const b = await derivePublishRequestId({
      ...base,
      platforms: ['youtube', 'tiktok'],
    });
    expect(a).toBe(b);
    expect(a).toMatch(PUBLISH_REQUEST_ID_RE);
  });

  it('changes when anything the user reviewed changes', async () => {
    const original = await derivePublishRequestId(base);
    const changes: Partial<PublishInput & { teamId: string }>[] = [
      { teamId: '01OTHERTEAM' },
      { exportId: '01OTHER' },
      { profile: 'other' },
      { platforms: ['tiktok'] },
      { title: 'Another caption' },
      { description: 'Now with a description' },
      { youtubePrivacy: 'public' },
      { tiktokPrivacy: 'SELF_ONLY' },
    ];
    for (const change of changes) {
      expect(await derivePublishRequestId({ ...base, ...change })).not.toBe(
        original
      );
    }
  });

  it("ignores a visibility the post doesn't send", async () => {
    const xOnly = { ...base, platforms: ['x' as const] };
    expect(await derivePublishRequestId(xOnly)).toBe(
      await derivePublishRequestId({ ...xOnly, youtubePrivacy: 'public' })
    );
  });
});

describe('publishInputSchema', () => {
  const { teamId: _, ...input } = base;

  it('accepts a complete publish', () => {
    expect(publishInputSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['no platforms', { platforms: [] }, 'Pick at least one platform'],
    ['a blank caption', { title: '   ' }, 'A caption is required'],
    [
      'a caption over the YouTube limit',
      { title: 'a'.repeat(101) },
      'YouTube captions are limited to 100 characters',
    ],
    [
      'a caption over the X limit',
      { platforms: ['x', 'tiktok'], title: 'a'.repeat(281) },
      'X captions are limited to 280 characters',
    ],
  ])('rejects %s', (_, change, message) => {
    const parsed = publishInputSchema.safeParse({ ...input, ...change });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(message);
  });

  it('applies the tightest limit of the selected platforms only', () => {
    expect(
      publishInputSchema.safeParse({
        ...input,
        platforms: ['tiktok'],
        title: 'a'.repeat(1000),
      }).success
    ).toBe(true);
  });
});
