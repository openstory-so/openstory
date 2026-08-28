import { describe, expect, it } from 'vitest';
import type { ShotView } from '@/lib/shots/shot-view';
import {
  assembleSequenceSegments,
  formatShotSpan,
  groupShotsBySegment,
  isSelectedVersionStale,
  type SegmentShotInput,
  type SegmentVersionInput,
  type SequenceSegment,
} from './scene-segments';

const shot = (
  id: string,
  shotNumber: number,
  renderSegmentId: string | null
): ShotView =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal fixture: grouping reads only id/renderSegmentId/shotNumber
  ({
    id,
    shotNumber,
    renderSegmentId,
  }) as ShotView;

const segment = (id: string, shotIds: string[]): SequenceSegment => ({
  id,
  sceneId: 'scene-1',
  shotIds,
  selectedVersionId: null,
  selectedVersion: null,
  versions: [],
  model: null,
  stale: false,
});

describe('groupShotsBySegment', () => {
  it('groups contiguous shots sharing a segment, in hierarchical order', () => {
    const shots = [
      shot('a', 1, 'seg-a'),
      shot('b', 2, 'seg-a'),
      shot('c', 3, 'seg-a'),
      shot('d', 4, 'seg-b'),
      shot('e', 5, 'seg-b'),
    ];
    const groups = groupShotsBySegment(
      shots,
      new Map([
        ['seg-a', segment('seg-a', ['a', 'b', 'c'])],
        ['seg-b', segment('seg-b', ['d', 'e'])],
      ])
    );
    expect(groups.map((g) => g.segmentId)).toEqual(['seg-a', 'seg-b']);
    expect(groups[0]?.shots.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(groups[1]?.shots.map((s) => s.id)).toEqual(['d', 'e']);
    expect(groups[0]?.segment?.id).toBe('seg-a');
  });

  it('never coalesces null-segment shots — each is its own singleton', () => {
    const groups = groupShotsBySegment(
      [shot('a', 1, null), shot('b', 2, null)],
      new Map()
    );
    expect(groups).toHaveLength(2);
    expect(
      groups.every((g) => g.segmentId === null && g.segment === null)
    ).toBe(true);
  });

  it('leaves segment null when the id is missing from the map', () => {
    const groups = groupShotsBySegment([shot('a', 1, 'seg-x')], new Map());
    expect(groups[0]?.segmentId).toBe('seg-x');
    expect(groups[0]?.segment).toBeNull();
  });
});

describe('formatShotSpan', () => {
  it('formats a single shot, a range, and an empty list', () => {
    expect(formatShotSpan([2])).toBe('Shot 2');
    expect(formatShotSpan([2, 3, 4])).toBe('Shots 2–4');
    expect(formatShotSpan([])).toBe('');
  });
});

const version = (
  id: string,
  renderSegmentId: string,
  model: string,
  manifest: SegmentVersionInput['manifest']
): SegmentVersionInput => ({
  id,
  renderSegmentId,
  model,
  status: 'completed',
  url: `https://cdn.test/${id}.mp4`,
  createdAt: new Date('2026-01-01'),
  manifest,
});

const segShot = (
  id: string,
  renderSegmentId: string | null,
  selectedMotionPromptVersionId: string | null = null
): SegmentShotInput => ({
  id,
  renderSegmentId,
  selectedMotionPromptVersionId,
});

describe('isSelectedVersionStale', () => {
  const motion = new Map([['shot-1', 'mp-1']]);
  const frame = new Map([['shot-1', 'fv-1']]);

  it('is false with no selection', () => {
    expect(isSelectedVersionStale(undefined, motion, frame)).toBe(false);
  });

  it('is fresh when the manifest matches current pointers', () => {
    const v = version('v1', 'seg', 'kling', [
      {
        shotId: 'shot-1',
        motionPromptVersionId: 'mp-1',
        frameVersionId: 'fv-1',
      },
    ]);
    expect(isSelectedVersionStale(v, motion, frame)).toBe(false);
  });

  it('is stale when a shot repointed its frame or motion prompt', () => {
    const v = version('v1', 'seg', 'kling', [
      {
        shotId: 'shot-1',
        motionPromptVersionId: 'mp-0',
        frameVersionId: 'fv-1',
      },
    ]);
    expect(isSelectedVersionStale(v, motion, frame)).toBe(true);
  });

  it('is stale when a manifest shot no longer exists', () => {
    const v = version('v1', 'seg', 'kling', [
      { shotId: 'gone', motionPromptVersionId: 'mp-1', frameVersionId: 'fv-1' },
    ]);
    expect(isSelectedVersionStale(v, motion, frame)).toBe(true);
  });

  it('treats a null-null manifest as unknown-not-stale, not born-stale (#1380)', () => {
    // Storyboard auto-motion used to stamp both ids as null. Comparing that
    // to the live selected still + prompt always diverged, so every clip
    // showed Stale the moment it landed. Same contract as a legacy null hash.
    const v = version('v1', 'seg', 'kling', [
      {
        shotId: 'shot-1',
        motionPromptVersionId: null,
        frameVersionId: null,
      },
    ]);
    expect(isSelectedVersionStale(v, motion, frame)).toBe(false);
  });
});

describe('assembleSequenceSegments', () => {
  it('assembles membership, versions, selection, and model', () => {
    const result = assembleSequenceSegments({
      segments: [
        { id: 'seg-a', sceneId: 'sc-1', selectedVideoVersionId: 'v1' },
      ],
      versions: [
        version('v1', 'seg-a', 'kling', [
          {
            shotId: 'shot-2',
            motionPromptVersionId: 'mp-1',
            frameVersionId: 'fv-1',
          },
        ]),
        version('v2', 'seg-a', 'seedance', []),
      ],
      // Callers pass shots already in hierarchical order.
      shots: [
        segShot('shot-1', 'seg-a', null),
        segShot('shot-2', 'seg-a', 'mp-1'),
        segShot('shot-3', null),
      ],
      frames: [
        { shotId: 'shot-2', role: 'first', selectedImageVersionId: 'fv-1' },
        { shotId: 'shot-2', role: 'last', selectedImageVersionId: 'other' },
      ],
    });

    expect(result).toHaveLength(1);
    const seg = result[0];
    expect(seg?.shotIds).toEqual(['shot-1', 'shot-2']);
    expect(seg?.selectedVersion?.id).toBe('v1');
    expect(seg?.versions.map((v) => v.id)).toEqual(['v1', 'v2']);
    // Selected version's model wins over the newest version's.
    expect(seg?.model).toBe('kling');
    expect(seg?.stale).toBe(false);
  });

  it('falls back to the newest version model when nothing is selected', () => {
    const result = assembleSequenceSegments({
      segments: [
        { id: 'seg-a', sceneId: 'sc-1', selectedVideoVersionId: null },
      ],
      versions: [
        version('v1', 'seg-a', 'kling', []),
        version('v2', 'seg-a', 'seedance', []),
      ],
      shots: [],
      frames: [],
    });
    expect(result[0]?.model).toBe('seedance');
    expect(result[0]?.selectedVersion).toBeNull();
    expect(result[0]?.stale).toBe(false);
  });

  it('returns a dangling segment with empty shotIds and null selectedVersion', () => {
    const result = assembleSequenceSegments({
      segments: [
        // Selection points at a version not in the (non-discarded) list.
        { id: 'seg-a', sceneId: 'sc-1', selectedVideoVersionId: 'discarded' },
      ],
      versions: [],
      shots: [],
      frames: [],
    });
    expect(result[0]?.shotIds).toEqual([]);
    expect(result[0]?.selectedVersionId).toBe('discarded');
    expect(result[0]?.selectedVersion).toBeNull();
    expect(result[0]?.model).toBeNull();
    expect(result[0]?.stale).toBe(false);
  });

  it('flags a stale selection when a covered shot repointed since the render', () => {
    const result = assembleSequenceSegments({
      segments: [
        { id: 'seg-a', sceneId: 'sc-1', selectedVideoVersionId: 'v1' },
      ],
      versions: [
        version('v1', 'seg-a', 'kling', [
          {
            shotId: 'shot-1',
            motionPromptVersionId: 'mp-old',
            frameVersionId: null,
          },
        ]),
      ],
      shots: [segShot('shot-1', 'seg-a', 'mp-new')],
      frames: [],
    });
    expect(result[0]?.stale).toBe(true);
  });
});
