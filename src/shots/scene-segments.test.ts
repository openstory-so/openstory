import { describe, expect, it } from 'vitest';
import type { ShotView } from './shot-view';
import {
  assembleSequenceSegments,
  formatShotSpan,
  groupShotsBySegment,
  groupShotsForSceneList,
  isSelectedVersionStale,
  type SegmentShotInput,
  type SegmentVersionInput,
  type SequenceSegment,
  type LiveShotInputs,
} from './scene-segments';
import { dialogueLinesKey, shotDialogue } from './shot-dialogue';
import { motionPromptFromVersion } from '@/motion/server/resolve-motion-prompt';

const shot = (
  id: string,
  shotNumber: number,
  renderSegmentId: string | null,
  durationMs = 3000
): ShotView =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal fixture: grouping reads only id/renderSegmentId/shotNumber/durationMs
  ({
    id,
    shotNumber,
    renderSegmentId,
    durationMs,
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

describe('groupShotsForSceneList', () => {
  it('leaves independently renderable shots unwrapped', () => {
    const groups = groupShotsForSceneList(
      [
        shot('a', 1, null, 4000),
        shot('b', 2, null, 6000),
        shot('c', 3, null, 5000),
      ],
      new Map(),
      'seedance_v2'
    );
    expect(groups.map((g) => g.shots.map((s) => s.id))).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
    expect(groups.every((g) => g.plannedModel === undefined)).toBe(true);
    expect(groups.every((g) => g.segment === null)).toBe(true);
  });

  it('groups only the short shots needed to reach the minimum', () => {
    const groups = groupShotsForSceneList(
      [
        shot('a', 1, null, 8000),
        shot('b', 2, null, 2000),
        shot('c', 3, null, 2000),
      ],
      new Map(),
      'seedance_v2'
    );
    expect(groups.map((g) => g.shots.map((s) => s.id))).toEqual([
      ['a'],
      ['b', 'c'],
    ]);
    expect(groups[0]?.plannedModel).toBeUndefined();
    expect(groups[1]?.plannedModel).toBe('seedance_v2');
  });

  it('keeps a 1-shot tile unwrapped', () => {
    const groups = groupShotsForSceneList(
      [shot('a', 1, null, 4000)],
      new Map(),
      'seedance_v2'
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.plannedModel).toBeUndefined();
    expect(groups[0]?.shots.map((s) => s.id)).toEqual(['a']);
  });

  it('does not plan packs for a model that cannot cut inside a clip', () => {
    const groups = groupShotsForSceneList(
      [
        shot('a', 1, null, 4000),
        shot('b', 2, null, 6000),
        shot('c', 3, null, 5000),
      ],
      new Map(),
      'grok_imagine_video_1_5'
    );
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.plannedModel === undefined)).toBe(true);
  });

  it('leaves a persisted render segment untouched', () => {
    const groups = groupShotsForSceneList(
      [
        shot('a', 1, 'seg-a', 4000),
        shot('b', 2, 'seg-a', 6000),
        shot('c', 3, 'seg-a', 5000),
      ],
      new Map([['seg-a', segment('seg-a', ['a', 'b', 'c'])]]),
      'seedance_v2'
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.segment?.id).toBe('seg-a');
    expect(groups[0]?.plannedModel).toBeUndefined();
  });

  it('plans only the unrendered run next to a persisted segment', () => {
    const groups = groupShotsForSceneList(
      [
        shot('a', 1, 'seg-a', 4000),
        shot('b', 2, 'seg-a', 6000),
        shot('c', 3, null, 2000),
        shot('d', 4, null, 2000),
      ],
      new Map([['seg-a', segment('seg-a', ['a', 'b'])]]),
      'seedance_v2'
    );
    expect(groups.map((g) => g.shots.map((s) => s.id))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(groups[0]?.segment?.id).toBe('seg-a');
    expect(groups[1]?.plannedModel).toBe('seedance_v2');
  });

  it('does not coalesce a dangling renderSegmentId into a planned pack', () => {
    const groups = groupShotsForSceneList(
      [shot('a', 1, 'seg-x', 4000), shot('b', 2, null, 4000)],
      new Map(),
      'seedance_v2'
    );
    expect(groups.map((g) => g.shots.map((s) => s.id))).toEqual([['a'], ['b']]);
    expect(groups.every((g) => g.plannedModel === undefined)).toBe(true);
  });

  it('wraps a 1-shot leftover so the strip can show snap/Grok', () => {
    const groups = groupShotsForSceneList(
      [shot('a', 1, null, 1000)],
      new Map(),
      'minimax_h3_max'
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.belowMin).toBe(true);
    expect(groups[0]?.plannedModel).toBe('minimax_h3_max');
  });

  it('packs [12, 3, 3] on Seedance as [12][3, 3], not [12, 3] leftover [3]', () => {
    const groups = groupShotsForSceneList(
      [
        shot('a', 1, null, 12_000),
        shot('b', 2, null, 3_000),
        shot('c', 3, null, 3_000),
      ],
      new Map(),
      'seedance_v2'
    );
    expect(groups.map((g) => g.shots.map((s) => s.id))).toEqual([
      ['a'],
      ['b', 'c'],
    ]);
    expect(groups[1]?.plannedModel).toBe('seedance_v2');
    expect(groups.every((g) => g.belowMin !== true)).toBe(true);
  });

  it('does not fill Seedance 2.5’s longer cap unnecessarily', () => {
    const groups = groupShotsForSceneList(
      [
        shot('a', 1, null, 8000),
        shot('b', 2, null, 8000),
        shot('c', 3, null, 5000),
      ],
      new Map(),
      'seedance_v2_5'
    );
    expect(groups.map((g) => g.shots.map((s) => s.id))).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
    expect(groups.every((g) => g.plannedModel === undefined)).toBe(true);
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
  resolution: null,
  draftTaskId: null,
  status: 'completed',
  url: `https://cdn.test/${id}.mp4`,
  createdAt: new Date('2026-01-01'),
  manifest,
});

const segShot = (
  id: string,
  renderSegmentId: string | null,
  selectedMotionPromptVersionId: string | null = null,
  rendersReferenceOnly = false
): SegmentShotInput => ({
  id,
  renderSegmentId,
  selectedMotionPromptVersionId,
  rendersReferenceOnly,
  motionPromptRenamedFrom: [],
  audioClips: null,
  durationMs: null,
});

const NO_LOADED = {
  audioSourceKeyByShot: new Map<string, string | null>(),
  dialogueKeyByShot: new Map<string, string | null>(),
  referenceIdentity: new Map<string, string>(),
};
const motion = new Map([['shot-1', 'mp-1']]);
const frame = new Map([['shot-1', 'fv-1']]);
/** Staleness of `v` against shot-1's pointers, with only the given live maps bound. */
const stale = (
  v: SegmentVersionInput | undefined,
  live: Partial<LiveShotInputs> = {}
) =>
  isSelectedVersionStale(
    v,
    motion,
    frame,
    {
      ...NO_LOADED,
      audioClipIdsByShot: new Map(),
      durationMsByShot: new Map(),
      audioSecondsByShot: new Map(),
      ...live,
    },
    new Map()
  );

describe('isSelectedVersionStale', () => {
  it('is false with no selection', () => {
    expect(stale(undefined)).toBe(false);
  });

  it('a token rename of the rendered prompt keeps the clip fresh; an edit after it does not (#1827)', () => {
    const v = version('v1', 'seg', 'kling', [
      {
        shotId: 'shot-1',
        motionPromptVersionId: 'mp-0',
        frameVersionId: 'fv-1',
      },
    ]);
    const live = {
      ...NO_LOADED,
      audioClipIdsByShot: new Map(),
      durationMsByShot: new Map(),
      audioSecondsByShot: new Map(),
    };
    // mp-1 renamed from r1, renamed from the rendered mp-0.
    const renamedTwice = new Map([['shot-1', ['r1', 'mp-0']]]);
    expect(isSelectedVersionStale(v, motion, frame, live, renamedTwice)).toBe(
      false
    );
    // An edit after the rename is not a rename: no chain, so stale.
    expect(isSelectedVersionStale(v, motion, frame, live, new Map())).toBe(
      true
    );
  });

  it('is fresh when the manifest matches current pointers', () => {
    const v = version('v1', 'seg', 'kling', [
      {
        shotId: 'shot-1',
        motionPromptVersionId: 'mp-1',
        frameVersionId: 'fv-1',
      },
    ]);
    expect(stale(v)).toBe(false);
  });

  it('is stale when the bound dialogue audio identity moved', () => {
    const v = version('v1', 'seg', 'seedance_v2', [
      {
        shotId: 'shot-1',
        motionPromptVersionId: 'mp-1',
        frameVersionId: 'fv-1',
        audioSourceKey: 'voice-sarah\tStay down.\t\televen_v3',
      },
    ]);
    const audio = new Map([['shot-1', 'voice-other\tStay down.\t\televen_v3']]);
    expect(stale(v, { audioSourceKeyByShot: audio })).toBe(true);
    expect(
      stale(v, {
        audioSourceKeyByShot: new Map([
          ['shot-1', 'voice-sarah\tStay down.\t\televen_v3'],
        ]),
      })
    ).toBe(false);
  });

  it('a clip stamped from the render payload reads fresh against the live key (#1784)', () => {
    // The render stamps the lines on its motion prompt; the live side keys
    // the resolver's answer. The same lines must give the same key.
    const said = shotDialogue([
      { character: 'Alice', line: 'Stay down.', tone: 'calm', voiceToken: 'A' },
      { character: 'Bob', line: 'No.', tone: '' },
    ]);
    const sent = motionPromptFromVersion(
      { text: 'She ducks.', audio: null },
      said
    );
    const v = version('v1', 'seg', 'kling_v3_pro', [
      {
        shotId: 'shot-1',
        motionPromptVersionId: 'mp-1',
        frameVersionId: 'fv-1',
        audioSourceKey: null,
        dialogueKey: dialogueLinesKey(sent.dialogue),
      },
    ]);
    expect(
      stale(v, {
        dialogueKeyByShot: new Map([['shot-1', dialogueLinesKey(said)]]),
      })
    ).toBe(false);
  });

  it('is stale when any line the prompt quoted moved, voiced or not (#1784)', () => {
    const stamped = 'Alice\tStay down.\t\t';
    const edited = new Map([['shot-1', 'Alice\tStay up.\t\t']]);
    // kling_v3_pro splices lines into its prompt but takes no dialogue audio,
    // so `audioSourceKey` is null and never moves.
    const v = version('v1', 'seg', 'kling_v3_pro', [
      {
        shotId: 'shot-1',
        motionPromptVersionId: 'mp-1',
        frameVersionId: 'fv-1',
        audioSourceKey: null,
        dialogueKey: stamped,
      },
    ]);
    expect(stale(v, { dialogueKeyByShot: edited })).toBe(true);
    expect(
      stale(v, { dialogueKeyByShot: new Map([['shot-1', stamped]]) })
    ).toBe(false);
    // A model without audio never quoted a line: it stamps null and stays
    // fresh whatever the lines say.
    const silent = version('v1', 'seg', 'grok_imagine_video_1_5', [
      {
        shotId: 'shot-1',
        motionPromptVersionId: 'mp-1',
        frameVersionId: 'fv-1',
        dialogueKey: null,
      },
    ]);
    expect(stale(silent, { dialogueKeyByShot: edited })).toBe(false);
    // A clip from before #1784 has no key: unknown, never stale.
    const legacy = version('v1', 'seg', 'kling_v3_pro', [
      {
        shotId: 'shot-1',
        motionPromptVersionId: 'mp-1',
        frameVersionId: 'fv-1',
      },
    ]);
    expect(stale(legacy, { dialogueKeyByShot: edited })).toBe(false);
  });

  it.each(['grok_imagine_video_1_5', 'kling_v3_pro', 'gemini_omni_flash'])(
    'keeps a fresh %s video fresh when the shot has a designed voice (#1720)',
    (model) => {
      const v = version('v1', 'seg', model, [
        {
          shotId: 'shot-1',
          motionPromptVersionId: 'mp-1',
          frameVersionId: 'fv-1',
          audioSourceKey: null,
          audioClipIds: [],
        },
      ]);
      // Render triggers omit voicedLines for models without an audio input.
      // The live loader still resolves the voice for dialogue staleness.
      expect(
        stale(v, {
          audioSourceKeyByShot: new Map([
            ['shot-1', 'voice-sarah\tStay down.\t\televen_v3'],
          ]),
        })
      ).toBe(false);
      expect(
        isSelectedVersionStale(
          v,
          new Map([['shot-1', 'mp-2']]),
          frame,
          {
            ...NO_LOADED,
            audioClipIdsByShot: new Map(),
            durationMsByShot: new Map(),
            audioSecondsByShot: new Map(),
          },
          new Map()
        )
      ).toBe(true);
    }
  );

  it('still compares explicitly stamped audio on a legacy or fallback render', () => {
    const v = version('v1', 'seg', 'grok_imagine_video_1_5', [
      {
        shotId: 'shot-1',
        motionPromptVersionId: 'mp-1',
        frameVersionId: 'fv-1',
        audioSourceKey: 'recorded-key',
      },
    ]);
    expect(
      stale(v, { audioSourceKeyByShot: new Map([['shot-1', 'recorded-key']]) })
    ).toBe(false);
    expect(
      stale(v, { audioSourceKeyByShot: new Map([['shot-1', 'changed-key']]) })
    ).toBe(true);
  });

  it('is stale when a shot repointed its frame or motion prompt', () => {
    const v = version('v1', 'seg', 'kling', [
      {
        shotId: 'shot-1',
        motionPromptVersionId: 'mp-0',
        frameVersionId: 'fv-1',
      },
    ]);
    expect(stale(v)).toBe(true);
  });

  it('is stale when a manifest shot no longer exists', () => {
    const v = version('v1', 'seg', 'kling', [
      { shotId: 'gone', motionPromptVersionId: 'mp-1', frameVersionId: 'fv-1' },
    ]);
    expect(stale(v)).toBe(true);
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
    expect(stale(v)).toBe(false);
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
      live: NO_LOADED,
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
      live: NO_LOADED,
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
      live: NO_LOADED,
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
      live: NO_LOADED,
    });
    expect(result[0]?.stale).toBe(true);
  });
});

describe('legacy packed video provenance (#1720)', () => {
  const firstKey = 'voice-a\tHello.\tcalm\televen_v3';
  const secondKey = 'voice-b\tGoodbye.\tcalm\televen_v3';
  const v = version('packed', 'seg', 'minimax_h3_max', [
    {
      shotId: 'a',
      motionPromptVersionId: 'mp-a',
      frameVersionId: null,
      durationMs: 3000,
      audioSourceKey: `${firstKey}\n${secondKey}`,
      audioClipIds: ['clip-a'],
    },
    {
      shotId: 'b',
      motionPromptVersionId: 'mp-b',
      frameVersionId: null,
      durationMs: 2000,
      audioSourceKey: secondKey,
      audioClipIds: ['clip-b'],
    },
  ]);
  const live: LiveShotInputs = {
    ...NO_LOADED,
    audioSourceKeyByShot: new Map([
      ['a', firstKey],
      ['b', secondKey],
    ]),
    audioClipIdsByShot: new Map([
      ['a', ['clip-a']],
      ['b', ['clip-b']],
    ]),
    durationMsByShot: new Map([
      ['a', 3000],
      ['b', 2000],
    ]),
    audioSecondsByShot: new Map(),
  };
  const check = (changes: Partial<LiveShotInputs> = {}) =>
    isSelectedVersionStale(
      v,
      new Map([
        ['a', 'mp-a'],
        ['b', 'mp-b'],
      ]),
      new Map(),
      { ...live, ...changes },
      new Map()
    );

  it('recognizes an unchanged historical conversation and sub-minimum member durations', () => {
    expect(check()).toBe(false);
  });
  it.each(['a', 'b'])(
    'still detects changed words or voice on member %s',
    (id) => {
      const keys = new Map(live.audioSourceKeyByShot);
      keys.set(id, 'changed-voice\tChanged words.\tcalm\televen_v3');
      expect(check({ audioSourceKeyByShot: keys })).toBe(true);
    }
  );
  it('still detects a different recording of unchanged dialogue', () => {
    expect(
      check({
        audioClipIdsByShot: new Map([
          ['a', ['new-take']],
          ['b', ['clip-b']],
        ]),
      })
    ).toBe(true);
  });
  it('detects editorial duration changes even below the model minimum', () => {
    expect(
      check({
        durationMsByShot: new Map([
          ['a', 4000],
          ['b', 2000],
        ]),
      })
    ).toBe(true);
  });
});

describe('reference-only shots and staleness', () => {
  // A shot rendering from reference sheets animates from no still, so its
  // manifest entry records `frameVersionId: null`. The shot may still HAVE a
  // still — a per-shot override on a normal sequence, or one generated before
  // the switch was flipped — and comparing the clip against a still it never
  // received marked it Stale the instant it finished, offering a paid
  // re-render that produced the identical clip for ever.
  const referenceOnlyClip = () =>
    version('v1', 'seg-a', 'seedance', [
      { shotId: 'shot-1', motionPromptVersionId: 'mp-1', frameVersionId: null },
    ]);

  const assemble = (rendersReferenceOnly: boolean) =>
    assembleSequenceSegments({
      segments: [
        { id: 'seg-a', sceneId: 'sc-1', selectedVideoVersionId: 'v1' },
      ],
      versions: [referenceOnlyClip()],
      shots: [segShot('shot-1', 'seg-a', 'mp-1', rendersReferenceOnly)],
      // The shot has a selected still regardless — that is the whole trap.
      frames: [
        { shotId: 'shot-1', role: 'first', selectedImageVersionId: 'fv-1' },
      ],
      live: NO_LOADED,
    });

  it('is fresh when the clip rendered from references and a still exists', () => {
    expect(assemble(true)[0]?.stale).toBe(false);
  });

  it('is still stale when the same clip did NOT render reference-only', () => {
    // The null-frame escape must not swallow a genuine missing pointer: this
    // clip claims no start frame while the shot animates from one.
    expect(assemble(false)[0]?.stale).toBe(true);
  });
});

describe('isSelectedVersionStale — clips, references, duration (#1657)', () => {
  const entry = {
    shotId: 'shot-1',
    motionPromptVersionId: 'mp-1',
    frameVersionId: 'fv-1',
  };
  const key = new Map([['shot-1', 'k']]);
  const voiced = version('v1', 'seg', 'seedance_v2', [
    { ...entry, audioSourceKey: 'k', audioClipIds: ['section-1'] },
  ]);
  const staleWith = (
    v: SegmentVersionInput,
    audioClipIdsByShot: ReadonlyMap<string, readonly string[]>
  ) =>
    stale(v, {
      audioSourceKeyByShot: key,
      audioClipIdsByShot,
    });

  it('is fresh while the shot still holds the clip the render was sent', () => {
    expect(staleWith(voiced, new Map([['shot-1', ['section-1']]]))).toBe(false);
  });

  it('is stale when the shot picks another reading of the same lines', () => {
    expect(staleWith(voiced, new Map([['shot-1', ['section-2']]]))).toBe(true);
    // The working set emptied: the clip it was sent is gone.
    expect(staleWith(voiced, new Map())).toBe(true);
  });

  it('does not compare an entry with no clip ids, or a row from before the field', () => {
    // A voice appearing is `audioSourceKey`'s job, not this rule's.
    const voiceless = version('v1', 'seg', 'kling_v3_pro', [
      { ...entry, audioClipIds: [] },
    ]);
    const old = version('v1', 'seg', 'kling_v3_pro', [entry]);
    const live = { audioClipIdsByShot: new Map([['shot-1', ['section-2']]]) };
    expect(stale(voiceless, live)).toBe(false);
    expect(stale(old, live)).toBe(false);
  });

  it('keeps a legacy manifest fresh: its clip ids are the ones the working set still holds', () => {
    // Pre-#1657 clips carry a generated id, not a section id — and no
    // migration touched either side, so the sets still agree in any order.
    const legacy = version('v1', 'seg', 'seedance_v2', [
      { ...entry, audioSourceKey: 'k', audioClipIds: ['clip-a', 'clip-b'] },
    ]);
    expect(staleWith(legacy, new Map([['shot-1', ['clip-b', 'clip-a']]]))).toBe(
      false
    );
  });

  it('is not staled by a neighbour shot re-recording', () => {
    expect(
      staleWith(
        voiced,
        new Map([
          ['shot-1', ['section-1']],
          ['shot-2', ['section-9']],
        ])
      )
    ).toBe(false);
  });

  it('is stale when a stamped reference sheet or element media moved', () => {
    const v = version('v1', 'seg', 'kling_v3_pro', [
      { ...entry, referenceKeys: ['character:c1:csv-1'] },
    ]);
    expect(
      stale(v, {
        referenceIdentity: new Map([['character:c1', 'character:c1:csv-1']]),
      })
    ).toBe(false);
    expect(
      stale(v, {
        referenceIdentity: new Map([['character:c1', 'character:c1:csv-2']]),
      })
    ).toBe(true);
  });

  it('compares duration snapped on both sides, accepting the audio-raised length', () => {
    // Kling v3 pro grid is whole seconds 3–15: a 5s render matches a 4.6s
    // user edit (snaps to 5) and a 9s one does not.
    const v = version('v1', 'seg', 'kling_v3_pro', [
      { ...entry, durationMs: 5000 },
    ]);
    expect(
      stale(v, {
        durationMsByShot: new Map([['shot-1', 4600]]),
      })
    ).toBe(false);
    expect(
      stale(v, {
        durationMsByShot: new Map([['shot-1', 9000]]),
      })
    ).toBe(true);
    // Raised to cover 7s of dialogue: 7s is still "unchanged".
    const raised = version('v1', 'seg', 'kling_v3_pro', [
      { ...entry, durationMs: 7000 },
    ]);
    expect(
      stale(raised, {
        durationMsByShot: new Map([['shot-1', 5000]]),
        audioSecondsByShot: new Map([['shot-1', 7]]),
      })
    ).toBe(false);
    // No user duration: nothing to compare.
    expect(
      stale(v, {
        durationMsByShot: new Map([['shot-1', 0]]),
      })
    ).toBe(false);
  });
});
