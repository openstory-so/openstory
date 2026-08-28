import { describe, expect, test } from 'vitest';
import {
  countScriptSceneHeadings,
  estimateRemainingSeconds,
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
  test('returns reasonable total for any scene count', () => {
    const total = estimateTotalSeconds(6);
    // All 5 phases (including optional motion/music), ~13min against real
    // providers (calibrated on the 2026-08-20 11-scene record run)
    expect(total).toBeGreaterThan(600);
    expect(total).toBeLessThan(1000);
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
});

describe('estimateRemainingSeconds', () => {
  test('decreases as phases complete', () => {
    const full = estimateRemainingSeconds({
      sceneCount: 6,
      completedPhases: [],
      elapsedSeconds: 0,
    });

    const partial = estimateRemainingSeconds({
      sceneCount: 6,
      completedPhases: [1, 2, 3],
      elapsedSeconds: 30,
    });

    expect(partial).toBeLessThan(full);
  });

  test('never returns negative', () => {
    const result = estimateRemainingSeconds({
      sceneCount: 6,
      completedPhases: [1, 2, 3, 4, 5],
      elapsedSeconds: 9999,
    });

    expect(result).toBe(0);
  });

  test('returns 0 when all phases completed', () => {
    const result = estimateRemainingSeconds({
      sceneCount: 1,
      completedPhases: [1, 2, 3, 4, 5],
      elapsedSeconds: 0,
    });

    expect(result).toBe(0);
  });
});

describe('formatTimeRemaining', () => {
  test('shows "Finishing up…" at 0', () => {
    expect(formatTimeRemaining(0)).toBe('Finishing up\u2026');
  });

  test('shows seconds for < 60', () => {
    expect(formatTimeRemaining(30)).toBe('30s remaining');
  });

  test('shows minutes:seconds for 60', () => {
    expect(formatTimeRemaining(60)).toBe('1:00 remaining');
  });

  test('shows minutes:seconds for 150', () => {
    expect(formatTimeRemaining(150)).toBe('2:30 remaining');
  });
});
