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
  parseSceneDurationLabels,
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

  it('ignores a stray "Shot N — Xs" line: Enhance no longer emits those (#1621)', () => {
    const script =
      'Scene 1 — 10s\nINT. HALLWAY - NIGHT\nShot 1 — 4s\nShe opens the door.\nShot 2 — 6s\nCut to the hallway beyond.';
    expect(parseSceneDurationLabels(script)).toEqual([10]);
    expect(sumSceneDurations(script)).toBe(10);
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

describe('formatClipGrid', () => {
  it('joins a discrete LTX grid', () => {
    expect(formatClipGrid([6, 8, 10])).toBe('6, 8 or 10 seconds');
  });

  it('collapses a contiguous Seedance grid', () => {
    expect(formatClipGrid([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])).toBe(
      '4–15 seconds'
    );
  });
});

describe('durationCorrectionNeeded', () => {
  it('triggers when the sum is more than 10% off', () => {
    expect(
      durationCorrectionNeeded({
        labels: [5, 5, 5, 5, 5, 5, 5, 5, 5],
        targetSeconds: 30,
      })
    ).toBe(true);
  });

  it('skips a close-enough sum, whatever the individual labels (#1621: no grid check)', () => {
    expect(
      durationCorrectionNeeded({
        labels: [5, 5, 5, 5, 5, 5],
        targetSeconds: 30,
      })
    ).toBe(false);
  });

  it('skips a 30s sum', () => {
    expect(
      durationCorrectionNeeded({
        labels: [6, 6, 6, 6, 6],
        targetSeconds: 30,
      })
    ).toBe(false);
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
  it('requires a hard sum, a TOTAL line, and title-card substitution — no clip grid (#1621)', () => {
    const paragraph = buildDurationPromptParagraph({ targetSeconds: 30 });
    expect(paragraph).toContain('Target video duration: 30 seconds');
    expect(paragraph).toContain('MUST add up to 30 seconds');
    expect(paragraph).toContain('TOTAL: <sum>s');
    expect(paragraph).toContain('title card');
    expect(paragraph).toContain('living beat');
    expect(paragraph).toContain('playing time, not a clip length');
    expect(paragraph).not.toContain('shot');
    expect(paragraph).not.toContain('clip durations');
  });
});

describe('buildDurationCorrectionPrompt', () => {
  it('names the actual sum with no clip-grid rule (#1621)', () => {
    const prompt = buildDurationCorrectionPrompt({
      sum: 43,
      targetSeconds: 30,
      sceneCount: 9,
    });
    expect(prompt).toContain('sum to 43s');
    expect(prompt).toContain('target is 30s');
    expect(prompt).toContain('scene duration labels');
    expect(prompt).toContain('scene count');
    expect(prompt).not.toMatch(/clip duration/i);
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
  it('averages snapped labeled scenes', () => {
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
