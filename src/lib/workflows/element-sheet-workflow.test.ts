import { describe, expect, test } from 'vitest';
import type { SequenceElementMinimal } from '@/lib/db/schema';
import { collectElementResults } from './element-sheet-workflow';

describe('collectElementResults', () => {
  const element = (token: string): SequenceElementMinimal => ({
    id: `el_${token.toLowerCase()}`,
    token,
    description: `Visual description of ${token}`,
    imageUrl: `https://storage.example/${token.toLowerCase()}.png`,
    consistencyTag: token.toLowerCase().replaceAll('_', '-'),
  });
  const fulfilled = (
    token: string
  ): PromiseSettledResult<SequenceElementMinimal> => ({
    status: 'fulfilled',
    value: element(token),
  });
  const rejected = (
    reason: Error | string
  ): PromiseSettledResult<SequenceElementMinimal> => ({
    status: 'rejected',
    reason,
  });

  test('returns the elements in entry order when every entry succeeded', () => {
    const settled = [fulfilled('LOGO'), fulfilled('CORAL_LIPSTICK')];

    const elements = collectElementResults(settled, [
      { token: 'LOGO' },
      { token: 'CORAL_LIPSTICK' },
    ]);

    expect(elements.map((e) => e.token)).toEqual(['LOGO', 'CORAL_LIPSTICK']);
  });

  test('throws naming the failed token when any entry failed', () => {
    const settled = [fulfilled('LOGO'), rejected(new Error('fal timeout'))];

    expect(() =>
      collectElementResults(settled, [
        { token: 'LOGO' },
        { token: 'CORAL_LIPSTICK' },
      ])
    ).toThrow(/1\/2.*CORAL_LIPSTICK: fal timeout/);
  });

  test('aggregates every failure into one error', () => {
    const settled = [rejected('quota exceeded'), rejected(new Error('500'))];

    expect(() =>
      collectElementResults(settled, [{ token: 'LOGO' }, { token: 'BOTTLE' }])
    ).toThrow(/2\/2.*LOGO: quota exceeded; BOTTLE: 500/);
  });
});
