import { expect, it } from 'vitest';
import { nameHexColours } from './colour-name';

it('names hex colours and leaves words alone', () => {
  expect(
    nameHexColours('#0b1016, #1f3a45, #d9822b, #c9d3da, #3fd0c0, #7a1f2b')
  ).toBe('near-black blue, dark teal, orange, light grey, teal, dark red');
  expect(nameHexColours('#fff, #000, sepia')).toBe('white, black, sepia');
});
