import { describe, expect, it } from 'vitest';
import { substituteReferenceTags } from './reference-legend';

describe('substituteReferenceTags', () => {
  const steve = [{ token: 'STEVE', render: 'Image 4' }];

  it('binds a name in the action, never inside spoken words (#1657)', () => {
    const { prompt, mentioned } = substituteReferenceTags(
      'Steve looks up. ELARA says: "Hello Steve." ELARA says: {Steve, listen} <d>[English] Steve?</d> “Steve…”',
      steve
    );
    expect(prompt).toBe(
      'Image 4 looks up. ELARA says: "Hello Steve." ELARA says: {Steve, listen} <d>[English] Steve?</d> “Steve…”'
    );
    expect(mentioned).toEqual([true]);
  });

  it('a name that is only spoken is not a mention, so the legend still binds it', () => {
    const { prompt, mentioned } = substituteReferenceTags(
      'ELARA says: "Hello Steve."',
      steve
    );
    expect(prompt).toBe('ELARA says: "Hello Steve."');
    expect(mentioned).toEqual([false]);
  });

  it('is word-bounded and case-insensitive', () => {
    expect(
      substituteReferenceTags('A jacket for Jack.', [
        { token: 'jack', render: '@Image1' },
      ]).prompt
    ).toBe('A jacket for @Image1.');
  });
});
