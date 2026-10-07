import { describe, expect, it } from 'vitest';
import {
  defaultLookCaption,
  defaultLookFace,
  defaultLookFaceState,
  defaultLookName,
  lookSheetFaceMessage,
  lookSheetFaceRefusal,
  populatedDefaultSheet,
} from './look-sheet-face';

describe('populatedDefaultSheet', () => {
  it('is the completed sheet, and nothing else', () => {
    expect(
      populatedDefaultSheet({
        sheetStatus: 'completed',
        sheetImageUrl: '/r2/priya.png',
        selectedSheetVersionId: 'ver-1',
      })
    ).toEqual({ url: '/r2/priya.png', versionId: 'ver-1' });
    expect(
      populatedDefaultSheet({
        sheetStatus: 'generating',
        sheetImageUrl: '/r2/priya.png',
        selectedSheetVersionId: 'ver-1',
      })
    ).toBeNull();
    expect(
      populatedDefaultSheet({
        sheetStatus: 'completed',
        sheetImageUrl: null,
        selectedSheetVersionId: 'ver-1',
      })
    ).toBeNull();
    // The pre-versioning sheet is the row keyed to the character's id, and
    // the pointer stays null (#1419). That sheet is still the face.
    expect(
      populatedDefaultSheet({
        id: 'priya',
        sheetStatus: 'completed',
        sheetImageUrl: '/r2/priya.png',
        selectedSheetVersionId: null,
      })
    ).toEqual({ url: '/r2/priya.png', versionId: 'priya' });
  });
});

describe('lookSheetFaceMessage', () => {
  it('names the default look in every state', () => {
    expect(
      defaultLookName([{ isDefault: true, name: 'Clean white shirt' }])
    ).toBe('Clean white shirt');
    expect(lookSheetFaceMessage('Clean white shirt', 'ready')).toBe(
      'Drawn from the default look, Clean white shirt. The face stays; the outfit changes.'
    );
    expect(lookSheetFaceMessage('Clean white shirt', 'missing')).toBe(
      'Drawn from the default look, Clean white shirt. Generate that sheet first.'
    );
    expect(lookSheetFaceMessage('Clean white shirt', 'generating')).toBe(
      'Drawn from the default look, Clean white shirt. That sheet is still generating.'
    );
    expect(defaultLookCaption('Clean white shirt', true)).toBe(
      'This is the default look, Clean white shirt. Other looks keep this face and change the outfit.'
    );
    expect(defaultLookCaption('Default', true)).toBe(
      'This is the default look. Other looks keep this face and change the outfit.'
    );
    expect(lookSheetFaceMessage('Default', 'ready')).toBe(
      'Drawn from the default look. The face stays; the outfit changes.'
    );
    expect(defaultLookCaption('Clean white shirt', false)).toBe(
      'This is the default look. Looks you add keep this face and change the outfit.'
    );
  });
});

describe('lookSheetFaceRefusal', () => {
  const looks = (
    sheetStatus: string,
    extra?: {
      sheetImageUrl?: string | null;
      selectedSheetVersionId?: string | null;
      id?: string;
    }
  ) => [
    {
      id: extra?.id ?? 'priya',
      isDefault: true,
      name: 'Clean white shirt',
      sheetStatus,
      sheetImageUrl: extra?.sheetImageUrl ?? '/r2/priya.png',
      selectedSheetVersionId:
        extra && 'selectedSheetVersionId' in extra
          ? extra.selectedSheetVersionId
          : 'ver-1',
    },
    { isDefault: false, name: 'Op shop jacket', sheetStatus: 'pending' },
  ];

  it('lets the default look through, and a look only once that sheet is completed', () => {
    const ready = looks('completed');
    expect(lookSheetFaceRefusal(ready, true)).toBeNull();
    expect(lookSheetFaceRefusal(ready, false)).toBeNull();
    expect(defaultLookFace(ready)).toEqual({
      url: '/r2/priya.png',
      versionId: 'ver-1',
    });
    expect(defaultLookFaceState(ready)).toBe('ready');
  });

  it('refuses while the default sheet is missing or still generating', () => {
    const missing = looks('pending', {
      sheetImageUrl: null,
      selectedSheetVersionId: null,
    });
    expect(lookSheetFaceRefusal(missing, false)).toBe(
      'Drawn from the default look, Clean white shirt. Generate that sheet first.'
    );
    // A completed sheet with a null pointer is the #1419 row.
    const unpointed = looks('completed', { selectedSheetVersionId: null });
    expect(lookSheetFaceRefusal(unpointed, false)).toBeNull();
    expect(defaultLookFace(unpointed)).toEqual({
      url: '/r2/priya.png',
      versionId: 'priya',
    });
    expect(defaultLookFace(missing)).toBeNull();

    const generating = looks('generating');
    expect(defaultLookFaceState(generating)).toBe('generating');
    expect(lookSheetFaceRefusal(generating, false)).toBe(
      'Drawn from the default look, Clean white shirt. That sheet is still generating.'
    );
  });
});
