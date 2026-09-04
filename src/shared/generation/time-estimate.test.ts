import { describe, expect, test } from 'vitest';
import {
  countScriptSceneHeadings,
  estimateMotionSeconds,
  estimateSceneCount,
  estimateSceneCountFromDuration,
  estimateTotalSeconds,
  formatTimeRemaining,
} from './time-estimate';

describe('countScriptSceneHeadings', () => {
  test('counts distinct Scene N labels from Enhance', () => {
    const script = `Scene 1 — 5s
A woman opens the door.

Scene 2 — 6s
She walks down the hall.

Scene 3 — 5s
Close on the bottle.`;
    expect(countScriptSceneHeadings(script)).toBe(3);
  });

  test('dedupes repeated scene numbers', () => {
    const script = `Scene 1 — 5s
(see Scene 1 again)
Scene 1 — 5s
Scene 2 — 4s`;
    expect(countScriptSceneHeadings(script)).toBe(2);
  });

  test('counts fountain INT./EXT. sluglines', () => {
    const script = `INT. KITCHEN - DAY
Mom cooks.

EXT. STREET - NIGHT
Rain falls.`;
    expect(countScriptSceneHeadings(script)).toBe(2);
  });

  test('returns 0 when unstructured', () => {
    expect(countScriptSceneHeadings('A man walks into a bar.')).toBe(0);
  });
});

describe('estimateSceneCount', () => {
  test('short unstructured script estimates 1 scene', () => {
    const script = 'A man walks into a bar and orders a drink.';
    expect(estimateSceneCount(script)).toBe(1);
  });

  test('medium unstructured script estimates proportionally by words', () => {
    // ~240 words → ~2 scenes
    const script = Array(240).fill('word').join(' ');
    expect(estimateSceneCount(script)).toBe(2);
  });

  test('long unstructured script clamps to 30', () => {
    const script = Array(5000).fill('word').join(' ');
    expect(estimateSceneCount(script)).toBe(30);
  });

  test('empty script returns 1', () => {
    expect(estimateSceneCount('')).toBe(1);
  });

  test('prefers Scene N headings over word density (Enhance)', () => {
    // Dense short scenes: word density would undercount badly.
    const scenes = Array.from({ length: 29 }, (_, i) => {
      const n = i + 1;
      return `Scene ${n} — 5s\nBeat ${n}. A short action line.\n`;
    }).join('\n');
    expect(estimateSceneCount(scenes)).toBe(29);
    // Without heading preference this would be ~2–3 by words alone.
    expect(estimateSceneCount(scenes)).toBeGreaterThan(
      estimateSceneCount(scenes.replace(/Scene \d+ — \d+s\n/g, ''))
    );
  });

  test('uses target duration when script has no labels', () => {
    expect(
      estimateSceneCount('Make a trailer.', { targetDurationSeconds: 60 })
    ).toBe(estimateSceneCountFromDuration(60));
  });

  test('labeled count wins over target duration', () => {
    const script = `Scene 1 — 5s
One.
Scene 2 — 5s
Two.`;
    expect(estimateSceneCount(script, { targetDurationSeconds: 180 })).toBe(2);
  });
});

describe('estimateSceneCountFromDuration', () => {
  test('matches enhance guidance midpoints', () => {
    expect(estimateSceneCountFromDuration(15)).toBe(3);
    expect(estimateSceneCountFromDuration(30)).toBe(5);
    expect(estimateSceneCountFromDuration(60)).toBe(10);
    expect(estimateSceneCountFromDuration(120)).toBe(18);
    expect(estimateSceneCountFromDuration(180)).toBe(25);
  });
});

describe('estimateTotalSeconds', () => {
  test('defaults are GPT Image 2 + Seedance stills/motion, Luna analysis', () => {
    // Image/video p90s from PostHog (30d ending 2026-09-01). Analysis falls
    // back to DEFAULT_ANALYSIS_MODEL (Luna, fast) like the other wall clocks,
    // so the default pair is deliberately mixed-tier.
    expect(estimateTotalSeconds(6)).toBe(641);
  });

  test('uses default scene count for 0', () => {
    expect(estimateTotalSeconds(0)).toBe(estimateTotalSeconds(6));
  });

  test('uses estimatedSceneCount as fallback when sceneCount is 0', () => {
    expect(estimateTotalSeconds(0, 10)).toBe(estimateTotalSeconds(10));
  });

  test('ignores estimatedSceneCount when sceneCount > 0', () => {
    expect(estimateTotalSeconds(5, 10)).toBe(estimateTotalSeconds(5));
  });

  test('turbo Lite + H3 Max is ~2.5 min, not a Seedance-class 11 min', () => {
    const defaults = estimateTotalSeconds(5);
    const turbo = estimateTotalSeconds(5, undefined, undefined, {
      analysisModel: 'openai/gpt-5.6-luna',
      imageModel: 'nano_banana_2_lite',
      videoModel: 'minimax_h3_max',
    });
    expect(defaults).toBe(635);
    expect(turbo).toBe(151);
    expect(turbo).toBeLessThan(defaults / 2);
  });

  test('analysis tier follows the analysis model, not the image model', () => {
    // Both mixed pairs named in #1433.
    const liteFable = estimateTotalSeconds(5, undefined, undefined, {
      analysisModel: 'anthropic/claude-fable-5.1',
      imageModel: 'nano_banana_2_lite',
    });
    const liteLuna = estimateTotalSeconds(5, undefined, undefined, {
      analysisModel: 'openai/gpt-5.6-luna',
      imageModel: 'nano_banana_2_lite',
    });
    expect(liteFable).toBeGreaterThan(liteLuna);

    const gptImageLuna = estimateTotalSeconds(5, undefined, undefined, {
      analysisModel: 'openai/gpt-5.6-luna',
      imageModel: 'gpt_image_2',
    });
    const gptImageFable = estimateTotalSeconds(5, undefined, undefined, {
      analysisModel: 'anthropic/claude-fable-5.1',
      imageModel: 'gpt_image_2',
    });
    expect(gptImageLuna).toBeLessThan(gptImageFable);

    // Same image model, so the whole gap is the analysis tier.
    expect(liteFable - liteLuna).toBe(gptImageFable - gptImageLuna);
  });

  test('a retired analysis id scores the app default, not quality', () => {
    // The `sequences.analysisModel` SQL default is a pinned legacy literal
    // that is no longer in the registry (#612 blocks changing it).
    const legacy = estimateTotalSeconds(5, undefined, undefined, {
      analysisModel: 'anthropic/claude-haiku-4.5',
      imageModel: 'gpt_image_2',
    });
    expect(legacy).toBe(
      estimateTotalSeconds(5, undefined, undefined, {
        imageModel: 'gpt_image_2',
      })
    );
  });
});

describe('estimateMotionSeconds', () => {
  test('Seedance 5 clips is one p90 wave, not the old 210s floor', () => {
    expect(estimateMotionSeconds('seedance_v2', 5)).toBe(288);
  });

  test('Seedance 12 clips adds a second p50 wave', () => {
    expect(estimateMotionSeconds('seedance_v2', 12)).toBe(496);
  });

  test('H3 Max 5 clips is ~10s p90, not a 3.5 min floor', () => {
    expect(estimateMotionSeconds('minimax_h3_max', 5)).toBe(10);
  });

  test('Hailuo stays Seedance-class even though it is in the turbo picker', () => {
    expect(estimateMotionSeconds('minimax_hailuo_02', 5)).toBe(228);
  });
});

describe('formatTimeRemaining', () => {
  test('shows "Finishing up…" at 0', () => {
    expect(formatTimeRemaining(0)).toBe('Finishing up\u2026');
  });

  test('shows seconds for < 60', () => {
    expect(formatTimeRemaining(30)).toBe('30s');
  });

  test('shows minutes:seconds for 60', () => {
    expect(formatTimeRemaining(60)).toBe('1:00');
  });

  test('shows minutes:seconds for 150', () => {
    expect(formatTimeRemaining(150)).toBe('2:30');
  });
});
