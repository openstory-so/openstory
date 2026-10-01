import { describe, expect, it, vi } from 'vitest';
import { loadSequenceStyle } from './sequence-style';
import type { StyleConfig } from '@/look/style-config';
const style: StyleConfig = {
  version: 2,
  look: {
    mood: 'quiet',
    artStyle: 'watercolour',
    lighting: 'soft light',
    colorPalette: ['silver'],
    colorGrading: 'cool shadows',
  },
  motion: { camera: 'locked' },
  references: [],
};
function database() {
  const getSequence = vi.fn(async () => ({
    id: 'sequence',
    styleId: 'style',
    styleConfig: style,
  }));
  const getStyle = vi.fn(async () => ({ config: style }));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the two read methods are used by this loader.
  const scopedDb = {
    sequences: { getById: getSequence },
    styles: { getById: getStyle },
  } as unknown as Parameters<typeof loadSequenceStyle>[0];
  return { scopedDb, getSequence, getStyle };
}
describe('loadSequenceStyle', () => {
  it('uses the saved snapshot without reading the mutable library style', async () => {
    const { scopedDb, getSequence, getStyle } = database();
    expect(
      await loadSequenceStyle(scopedDb, {
        id: 'sequence',
        styleId: 'style',
        styleConfig: style,
      })
    ).toEqual(style);
    expect(getSequence).not.toHaveBeenCalled();
    expect(getStyle).not.toHaveBeenCalled();
  });
  it('resolves partial shot contexts through the owning sequence snapshot', async () => {
    const { scopedDb, getSequence, getStyle } = database();
    expect(await loadSequenceStyle(scopedDb, { id: 'sequence' })).toEqual(
      style
    );
    expect(getSequence).toHaveBeenCalledWith('sequence');
    expect(getStyle).not.toHaveBeenCalled();
  });
  it('uses live style only for legacy rows with no snapshot', async () => {
    const { scopedDb, getSequence, getStyle } = database();
    expect(
      await loadSequenceStyle(scopedDb, {
        id: 'sequence',
        styleId: 'style',
        styleConfig: null,
      })
    ).toEqual(style);
    expect(getSequence).not.toHaveBeenCalled();
    expect(getStyle).toHaveBeenCalledWith('style');
  });
});
