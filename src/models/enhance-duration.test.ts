import { describe, expect, it } from 'vitest';
import {
  assessDurationFit,
  briefRequestsUnrenderableText,
  buildDurationCorrectionPrompt,
  buildDurationPromptParagraph,
  createTotalLineFilter,
  durationCorrectionNeeded,
  estimateMotionDurations,
  formatClipGrid,
  maybeRewriteDurationLabels,
  parseClipDurationLabels,
  parseSceneDurationLabels,
  parseShotDurationLabels,
  sceneRangeText,
  stripTotalLine,
  sumSceneDurations,
} from './enhance-duration';

const FIVE_SCENES = `Scene 1 — 5s
A door opens.

Scene 2 — 5s
She walks.

Scene 3 — 5s
A glance.

Scene 4 — 5s
The bag drops.

Scene 5 — 5s
She smiles.`;

const NINE_SCENES = Array.from(
  { length: 9 },
  (_, i) => `Scene ${i + 1} — 5s\nBeat ${i + 1}.`
).join('\n\n');

describe('parseSceneDurationLabels', () => {
  it('reads enhancer headings with en-dashes', () => {
    expect(parseSceneDurationLabels(FIVE_SCENES)).toEqual([5, 5, 5, 5, 5]);
    expect(sumSceneDurations(FIVE_SCENES)).toBe(25);
  });

  it('accepts hyphen and em-dash', () => {
    const script = 'Scene 1 - 6s\nGo.\n\nScene 2 — 8s\nStop.';
    expect(parseSceneDurationLabels(script)).toEqual([6, 8]);
  });
});

const MULTI_SHOT_SCENE = `Scene 1 — 10s
INT. HALLWAY - NIGHT
Shot 1 — 4s
She opens the door.
Shot 2 — 6s
Cut to the hallway beyond.`;

describe('parseClipDurationLabels', () => {
  it('uses scene labels when there are no shot labels (1-shot identity)', () => {
    expect(parseClipDurationLabels(FIVE_SCENES)).toEqual([5, 5, 5, 5, 5]);
  });

  it('uses shot labels when present and does not double-count the scene total', () => {
    expect(parseShotDurationLabels(MULTI_SHOT_SCENE)).toEqual([4, 6]);
    expect(parseSceneDurationLabels(MULTI_SHOT_SCENE)).toEqual([10]);
    expect(parseClipDurationLabels(MULTI_SHOT_SCENE)).toEqual([4, 6]);
    expect(sumSceneDurations(MULTI_SHOT_SCENE)).toBe(10);
  });

  it('counts mixed Enhance labels per scene, not film-wide (#1593)', () => {
    const mixed = [
      'Scene 1 — 10s',
      'Shot 1 — 4s',
      'She opens the door.',
      'Shot 2 — 6s',
      'Cut to the hallway beyond.',
      'Scene 2 — 8s',
      'She waits.',
      'Scene 3 — 5s',
      'A glance.',
    ].join('\n');
    // Shot labels anywhere used to drop the one-shot headings → [4, 6].
    expect(parseClipDurationLabels(mixed)).toEqual([4, 6, 8, 5]);
    expect(sumSceneDurations(mixed)).toBe(23);
  });
});

describe('stripTotalLine / createTotalLineFilter', () => {
  it('drops a trailing TOTAL: 30s line', () => {
    const script = `${FIVE_SCENES}\n\nTOTAL: 25s`;
    expect(stripTotalLine(script)).toBe(FIVE_SCENES);
    expect(parseSceneDurationLabels(stripTotalLine(script))).toEqual([
      5, 5, 5, 5, 5,
    ]);
  });

  it('holds a TOTAL line split across stream chunks', () => {
    const filter = createTotalLineFilter();
    expect(filter.push('Scene 1 — 6s\nA door.\n')).toBe(
      'Scene 1 — 6s\nA door.\n'
    );
    expect(filter.push('TOTAL:')).toBe('');
    expect(filter.push(' 30s')).toBe('');
    expect(filter.flush()).toBe('');
  });

  it('flushes a non-TOTAL remainder', () => {
    const filter = createTotalLineFilter();
    expect(filter.push('Scene 1 — 6s\nShe walks')).toBe('Scene 1 — 6s\n');
    expect(filter.flush()).toBe('She walks');
  });
});

describe('formatClipGrid / sceneRangeText', () => {
  it('joins a discrete LTX grid', () => {
    expect(formatClipGrid([6, 8, 10])).toBe('6, 8 or 10 seconds');
  });

  it('collapses a contiguous Seedance grid', () => {
    expect(formatClipGrid([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])).toBe(
      '4–15 seconds'
    );
  });

  it('intersects 30s preferred 4–6 with LTX min 6s → 4–5 scenes', () => {
    expect(sceneRangeText(30, [6, 8, 10])).toBe('4-5');
  });

  it('keeps 30s preferred 4–6 on Seedance 4–15', () => {
    expect(sceneRangeText(30, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])).toBe(
      '4-6'
    );
  });
});

describe('durationCorrectionNeeded', () => {
  it('triggers when the sum is more than 10% off', () => {
    expect(
      durationCorrectionNeeded({
        labels: [5, 5, 5, 5, 5, 5, 5, 5, 5],
        targetSeconds: 30,
        grid: [6, 8, 10],
      })
    ).toBe(true);
  });

  it('triggers when labels are off the clip grid even if the sum is close', () => {
    expect(
      durationCorrectionNeeded({
        labels: [5, 5, 5, 5, 5, 5],
        targetSeconds: 30,
        grid: [6, 8, 10],
      })
    ).toBe(true);
  });

  it('skips a 30s on-grid sum', () => {
    expect(
      durationCorrectionNeeded({
        labels: [6, 6, 6, 6, 6],
        targetSeconds: 30,
        grid: [6, 8, 10],
      })
    ).toBe(false);
  });
});

describe('maybeRewriteDurationLabels', () => {
  it('leaves on-grid labels alone (e2e fixture stability)', () => {
    const script =
      'Scene 1 — 6s\nA.\n\nScene 2 — 6s\nB.\n\nScene 3 — 6s\nC.\n\nScene 4 — 6s\nD.\n\nScene 5 — 8s\nE.';
    expect(sumSceneDurations(script)).toBe(32);
    expect(maybeRewriteDurationLabels(script, 'minimax_h3_max')).toBe(script);
  });

  it('rewrites illegal 4s labels onto the H3 Max grid', () => {
    const rewritten = maybeRewriteDurationLabels(
      FIVE_SCENES.replaceAll('5s', '4s'),
      'minimax_h3_max'
    );
    expect(parseSceneDurationLabels(rewritten)).toEqual([5, 5, 5, 5, 5]);
    expect(rewritten).toContain('Scene 1 — 5s');
    expect(rewritten).not.toContain('Scene 1 — 4s');
  });

  it('snaps shot labels and leaves the scene total line alone', () => {
    const script = `Scene 1 — 8s
Shot 1 — 4s
A.
Shot 2 — 4s
B.`;
    const rewritten = maybeRewriteDurationLabels(script, 'minimax_h3_max');
    expect(parseShotDurationLabels(rewritten)).toEqual([5, 5]);
    expect(rewritten).toContain('Scene 1 — 8s');
    expect(rewritten).toContain('Shot 1 — 5s');
  });
});

describe('assessDurationFit', () => {
  it('reports the snapped total, off-grid labels included', () => {
    // 9 × 4s labels snap up to the H3 Max 5s floor — the script renders at
    // 45s whatever the enhance target was.
    expect(
      assessDurationFit(NINE_SCENES.replaceAll('5s', '4s'), 'minimax_h3_max')
        .snappedSeconds
    ).toBe(45);
    expect(
      assessDurationFit(FIVE_SCENES.replaceAll('5s', '6s'), 'minimax_h3_max')
        .snappedSeconds
    ).toBe(30);
  });

  it('reports no total for an unlabeled script', () => {
    const fit = assessDurationFit('A door opens.', 'minimax_h3_max');
    expect(fit.snappedSeconds).toBeNull();
    expect(fit.clipGrid).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

describe('buildDurationPromptParagraph', () => {
  it('requires a hard sum, the model grid, a TOTAL line, and title-card substitution', () => {
    const paragraph = buildDurationPromptParagraph({
      targetSeconds: 30,
      videoModel: 'minimax_h3_max',
    });
    expect(paragraph).toContain('Target video duration: 30 seconds');
    expect(paragraph).toContain('about 4-6 clips');
    expect(paragraph).toContain('Clip durations MUST be 5–15 seconds');
    expect(paragraph).toContain('MUST add up to 30 seconds');
    expect(paragraph).toContain('TOTAL: <sum>s');
    expect(paragraph).toContain('title card');
    expect(paragraph).toContain('living beat');
    expect(paragraph).toContain('a scene may hold several shots');
    expect(paragraph).toContain('one-shot scene needs only the scene label');
    expect(paragraph).toContain('Each SHOT is one video clip');
  });
});

describe('buildDurationCorrectionPrompt', () => {
  it('names the actual sum and the grid', () => {
    const prompt = buildDurationCorrectionPrompt({
      sum: 43,
      targetSeconds: 30,
      grid: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      sceneCount: 9,
    });
    expect(prompt).toContain('sum to 43s');
    expect(prompt).toContain('target is 30s');
    expect(prompt).toContain('5–15 seconds');
    expect(prompt).toContain('9 scenes at ≥5s is at least 45s');
    expect(prompt).toContain('clip duration labels');
  });
});

describe('briefRequestsUnrenderableText', () => {
  it('detects SUPER: and title card', () => {
    expect(briefRequestsUnrenderableText('SUPER: CORAL. OUT NOW.')).toBe(true);
    expect(briefRequestsUnrenderableText('End on a TITLE CARD')).toBe(true);
    expect(briefRequestsUnrenderableText('A woman opens a door.')).toBe(false);
  });
});

describe('estimateMotionDurations', () => {
  it('averages snapped labeled clips', () => {
    const { perShotSeconds, totalSeconds } = estimateMotionDurations({
      script: FIVE_SCENES.replaceAll('5s', '6s'),
      targetSeconds: 30,
      sceneCount: 5,
      model: 'minimax_h3_max',
    });
    expect(totalSeconds).toBe(30);
    expect(perShotSeconds).toBe(6);
  });

  it('snaps an unlabeled spread onto the model grid', () => {
    const { perShotSeconds } = estimateMotionDurations({
      script: 'a one-liner',
      targetSeconds: 30,
      sceneCount: 8,
      model: 'minimax_h3_max',
    });
    // 30/8 = 3.75 → H3 Max floor 5
    expect(perShotSeconds).toBe(5);
  });
});
