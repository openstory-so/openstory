import { describe, expect, it } from 'vitest';
import {
  characterReferenceEntityKeys,
  liveReferenceIdentity,
  referenceKeysFrom,
  referenceKeysMoved,
  referenceProvenanceKey,
} from './reference-provenance';

describe('a one-off copy answers for its original (#2017)', () => {
  const copy = {
    id: 'copy',
    copiedFromCharacterId: 'orig',
    selectedSheetVersionId: 'csv-1',
    sheetImageUrl: '/r2/a.png',
  };
  const live = liveReferenceIdentity({
    characters: [copy],
    locations: [],
    elements: [],
  });
  const referenced = new Set(characterReferenceEntityKeys(copy));
  it('keeps a clip stamped with the original id and the same sheet fresh', () => {
    expect(referenced).toEqual(new Set(['character:copy', 'character:orig']));
    expect(
      referenceKeysMoved(
        [referenceProvenanceKey('character', 'orig', 'csv-1')],
        live,
        referenced
      )
    ).toBe(false);
  });
  it('stales it once the copy selects another sheet', () => {
    expect(
      referenceKeysMoved(
        [referenceProvenanceKey('character', 'orig', 'csv-0')],
        live,
        referenced
      )
    ).toBe(true);
  });
});

describe('reference provenance (#1657)', () => {
  const live = liveReferenceIdentity({
    characters: [
      {
        id: 'c1',
        copiedFromCharacterId: null,
        selectedSheetVersionId: 'csv-2',
        sheetImageUrl: '/r2/a.png',
      },
      {
        id: 'c2',
        copiedFromCharacterId: null,
        selectedSheetVersionId: null,
        sheetImageUrl: '/r2/b.png',
      },
    ],
    locations: [
      {
        id: 'l1',
        selectedReferenceVersionId: 'lsv-1',
        referenceImageUrl: null,
      },
    ],
    elements: [{ id: 'e1', imageUrl: '/r2/beach.mp4' }],
  });
  /** Every entity a render of the shot would be sent now. */
  const all = new Set([
    'character:c1',
    'character:c2',
    'location:l1',
    'element:e1',
    'location:gone',
  ]);

  it('prefers the selected version id and falls back to the url', () => {
    expect(live.get('character:c1')).toBe('character:c1:csv-2');
    expect(live.get('character:c2')).toBe('character:c2:/r2/b.png');
    expect(live.get('element:e1')).toBe('element:e1:/r2/beach.mp4');
  });

  it('collects sorted, de-duplicated keys and ignores refs without one', () => {
    expect(
      referenceKeysFrom([
        { provenanceKey: 'element:e1:/r2/beach.mp4' },
        { provenanceKey: 'character:c1:csv-2' },
        { provenanceKey: 'character:c1:csv-2' },
        {},
      ])
    ).toEqual(['character:c1:csv-2', 'element:e1:/r2/beach.mp4']);
  });

  it('is fresh when every stamped reference still matches, stale on a re-select, re-upload or delete', () => {
    const stamped = [
      referenceProvenanceKey('character', 'c1', 'csv-2'),
      referenceProvenanceKey('element', 'e1', '/r2/beach.mp4'),
    ];
    expect(referenceKeysMoved(stamped, live, all)).toBe(false);
    expect(
      referenceKeysMoved(
        [referenceProvenanceKey('character', 'c1', 'csv-1')],
        live,
        all
      )
    ).toBe(true);
    expect(
      referenceKeysMoved(
        [referenceProvenanceKey('element', 'e1', '/r2/old.mp4')],
        live,
        all
      )
    ).toBe(true);
    expect(
      referenceKeysMoved(
        [referenceProvenanceKey('location', 'gone', 'x')],
        live,
        all
      )
    ).toBe(true);
  });

  it('treats an absent stamp as unknown, never stale', () => {
    expect(referenceKeysMoved(undefined, live, all)).toBe(false);
    expect(referenceKeysMoved([], live, all)).toBe(false);
  });

  it('does not compare a stamped reference a render would no longer send (#2012)', () => {
    const stamped = [
      referenceProvenanceKey('character', 'c1', 'csv-1'),
      referenceProvenanceKey('character', 'c2', '/r2/b.png'),
    ];
    const onlyC2 = new Set(['character:c2']);
    expect(referenceKeysMoved(stamped, live, onlyC2)).toBe(false);
    expect(
      referenceKeysMoved(
        [referenceProvenanceKey('character', 'c2', 'old-sheet')],
        live,
        onlyC2
      )
    ).toBe(true);
    // A stamped entity that no longer exists is stale whatever the set says.
    expect(
      referenceKeysMoved(
        [referenceProvenanceKey('location', 'gone', 'x')],
        live,
        onlyC2
      )
    ).toBe(true);
  });
});
