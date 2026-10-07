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
  it('is the selected sheet, whatever the last attempt did', () => {
    const sheet = {
      id: 'priya',
      sheetImageUrl: '/r2/priya.png',
      selectedSheetVersionId: 'ver-1',
    };
    expect(populatedDefaultSheet(sheet)).toEqual({
      url: '/r2/priya.png',
      versionId: 'ver-1',
    });
    expect(populatedDefaultSheet({ ...sheet, sheetImageUrl: null })).toBeNull();
    // The pre-versioning sheet is the row keyed to the character's id, and
    // the pointer stays null (#1419). That sheet is still the face.
    expect(
      populatedDefaultSheet({ ...sheet, selectedSheetVersionId: null })
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
  const look = { id: 'jacket', isDefault: false, name: 'Op shop jacket' };
  const looks = (defaultLook: {
    sheetStatus: string;
    sheetImageUrl: string | null;
    selectedSheetVersionId: string | null;
  }) => [
    { id: 'priya', isDefault: true, name: 'Clean white shirt', ...defaultLook },
    {
      ...look,
      sheetStatus: 'pending',
      sheetImageUrl: null,
      selectedSheetVersionId: null,
    },
  ];
  const READY = {
    url: '/r2/priya.png',
    versionId: 'ver-1',
  };

  it('lets the default look through, and a look once the default has a selected sheet', () => {
    const ready = looks({
      sheetStatus: 'completed',
      sheetImageUrl: '/r2/priya.png',
      selectedSheetVersionId: 'ver-1',
    });
    expect(lookSheetFaceRefusal(ready, true)).toBeNull();
    expect(lookSheetFaceRefusal(ready, false)).toBeNull();
    expect(defaultLookFace(ready)).toEqual(READY);
    expect(defaultLookFaceState(ready)).toBe('ready');
  });

  it('keeps the face when a re-roll of the default failed: the old sheet is still selected', () => {
    const failed = looks({
      sheetStatus: 'failed',
      sheetImageUrl: '/r2/priya.png',
      selectedSheetVersionId: 'ver-1',
    });
    expect(defaultLookFaceState(failed)).toBe('ready');
    expect(lookSheetFaceRefusal(failed, false)).toBeNull();
    expect(defaultLookFace(failed)).toEqual(READY);
  });

  it('keeps the face while a re-roll is running, and waits for a first sheet', () => {
    const rerolling = looks({
      sheetStatus: 'generating',
      sheetImageUrl: '/r2/priya.png',
      selectedSheetVersionId: 'ver-1',
    });
    expect(defaultLookFaceState(rerolling)).toBe('ready');
    expect(defaultLookFace(rerolling)).toEqual(READY);

    const first = looks({
      sheetStatus: 'generating',
      sheetImageUrl: null,
      selectedSheetVersionId: null,
    });
    expect(defaultLookFaceState(first)).toBe('generating');
    expect(lookSheetFaceRefusal(first, false)).toBe(
      'Drawn from the default look, Clean white shirt. That sheet is still generating.'
    );
    expect(defaultLookFace(first)).toBeNull();
  });

  it('refuses while the default look has never had a sheet', () => {
    const never = looks({
      sheetStatus: 'pending',
      sheetImageUrl: null,
      selectedSheetVersionId: null,
    });
    expect(defaultLookFaceState(never)).toBe('missing');
    expect(lookSheetFaceRefusal(never, false)).toBe(
      'Drawn from the default look, Clean white shirt. Generate that sheet first.'
    );
    expect(defaultLookFace(never)).toBeNull();
    // A failed first attempt is still "never had one".
    expect(
      lookSheetFaceRefusal(
        looks({
          sheetStatus: 'failed',
          sheetImageUrl: null,
          selectedSheetVersionId: null,
        }),
        false
      )
    ).toBe(
      'Drawn from the default look, Clean white shirt. Generate that sheet first.'
    );
  });

  it('takes the #1419 row, a selected sheet with a null pointer, as the face', () => {
    const unpointed = looks({
      sheetStatus: 'completed',
      sheetImageUrl: '/r2/priya.png',
      selectedSheetVersionId: null,
    });
    expect(lookSheetFaceRefusal(unpointed, false)).toBeNull();
    expect(defaultLookFace(unpointed)).toEqual({
      url: '/r2/priya.png',
      versionId: 'priya',
    });
  });
});
