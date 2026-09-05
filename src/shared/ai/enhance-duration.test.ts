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
  parseSceneDurationLabels,
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
    expect(maybeRewriteDurationLabels(script, 'ltx_2_3_pro')).toBe(script);
  });

  it('rewrites illegal 5s labels onto the LTX grid', () => {
    const rewritten = maybeRewriteDurationLabels(FIVE_SCENES, 'ltx_2_3_pro');
    expect(parseSceneDurationLabels(rewritten)).toEqual([6, 6, 6, 6, 6]);
    expect(rewritten).toContain('Scene 1 — 6s');
    expect(rewritten).not.toContain('Scene 1 — 5s');
  });
});

describe('assessDurationFit', () => {
  it('flags 9 beats × 6s LTX clips as unachievable at 30s', () => {
    const fit = assessDurationFit(NINE_SCENES, 30, 'ltx_2_3_pro');
    expect(fit.snappedSeconds).toBe(54);
    expect(fit.message).toContain('9 scenes at ≥6s clips is ≥54s');
    expect(fit.message).toContain('target 30s');
    expect(fit.message).toContain('about 54s');
  });

  it('fits five 6s LTX clips at 30s', () => {
    const script = FIVE_SCENES.replaceAll('5s', '6s');
    const fit = assessDurationFit(script, 30, 'ltx_2_3_pro');
    expect(fit.message).toBeNull();
    expect(fit.snappedSeconds).toBe(30);
  });

  it('does not warn on a partial stream (1–2 scenes of a 30s target)', () => {
    const one = 'Scene 1 — 6s\nA door opens.';
    const two = `${one}\n\nScene 2 — 6s\nShe walks.`;
    expect(assessDurationFit(one, 30, 'ltx_2_3_pro').message).toBeNull();
    expect(assessDurationFit(two, 30, 'ltx_2_3_pro').message).toBeNull();
  });
});

describe('buildDurationPromptParagraph', () => {
  it('requires a hard sum, the LTX grid, a TOTAL line, and title-card substitution', () => {
    const paragraph = buildDurationPromptParagraph({
      targetSeconds: 30,
      videoModel: 'ltx_2_3_pro',
    });
    expect(paragraph).toContain('Target video duration: 30 seconds');
    expect(paragraph).toContain('about 4-5 scenes');
    expect(paragraph).toContain('Clip durations MUST be 6, 8 or 10 seconds');
    expect(paragraph).toContain('MUST add up to 30 seconds');
    expect(paragraph).toContain('TOTAL: <sum>s');
    expect(paragraph).toContain('title card');
    expect(paragraph).toContain('living beat');
  });
});

describe('buildDurationCorrectionPrompt', () => {
  it('names the actual sum and the grid', () => {
    const prompt = buildDurationCorrectionPrompt({
      sum: 43,
      targetSeconds: 30,
      grid: [6, 8, 10],
      sceneCount: 9,
    });
    expect(prompt).toContain('sum to 43s');
    expect(prompt).toContain('target is 30s');
    expect(prompt).toContain('6, 8 or 10 seconds');
    expect(prompt).toContain('9 scenes at ≥6s is at least 54s');
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
      model: 'ltx_2_3_pro',
    });
    expect(totalSeconds).toBe(30);
    expect(perShotSeconds).toBe(6);
  });

  it('snaps an unlabeled spread onto the model grid', () => {
    const { perShotSeconds } = estimateMotionDurations({
      script: 'a one-liner',
      targetSeconds: 30,
      sceneCount: 6,
      model: 'ltx_2_3_pro',
    });
    // 30/6 = 5 → LTX 6
    expect(perShotSeconds).toBe(6);
  });
});
