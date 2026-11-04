import { expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './read-page';

it('round-trips a cursor whose scope is not Latin-1, and binds it to that scope', () => {
  const scope = ['organization', 'generated-assets', 'モデル/🎬'];
  expect(decodeCursor(encodeCursor('01J', scope), scope)).toBe('01J');
  expect(() =>
    decodeCursor(encodeCursor('01J', scope), ['organization'])
  ).toThrow();
});
