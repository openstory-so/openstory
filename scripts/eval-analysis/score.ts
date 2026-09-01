import {
  addLineGutter,
  resolveBoundaries,
  sliceScenes,
} from '@/lib/ai/boundary-split';
import type {
  SceneSplitBiblesResult,
  SceneSplitScenesResult,
} from '@/lib/ai/response-schemas';
import type { AutoStyleResponse } from '@/lib/style/auto-style';
import { z } from 'zod';
import { LOCATION_CASE, PROSE_GOLD_BEATS, TALENT_CASE } from './fixtures';

export const judgeSchema = z.object({
  score: z.number(),
  note: z.string(),
});
export type JudgeVerdict = z.infer<typeof judgeSchema>;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function pct(...parts: Array<{ w: number; v: number }>): number {
  const w = parts.reduce((s, p) => s + p.w, 0);
  if (w <= 0) return 0;
  const v = parts.reduce((s, p) => s + p.w * clamp01(p.v), 0);
  return Math.round((100 * v) / w);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function headingF1(offsets: number[], goldStarts: number[]): number {
  if (goldStarts.length === 0) return 1;
  const WINDOW = 80;
  let hits = 0;
  const used = new Set<number>();
  for (const off of offsets) {
    const match = goldStarts.findIndex(
      (g, i) => !used.has(i) && Math.abs(g - off) <= WINDOW
    );
    if (match >= 0) {
      used.add(match);
      hits++;
    }
  }
  const prec = hits / Math.max(offsets.length, 1);
  const rec = hits / goldStarts.length;
  if (prec + rec === 0) return 0;
  return (2 * prec * rec) / (prec + rec);
}

export function scoreSceneSplit(opts: {
  script: string;
  result: SceneSplitScenesResult;
  goldHeadingStarts?: number[];
  goldSceneCount: number;
}): { quality: number; details: Record<string, number | string | boolean> } {
  const { script, result } = opts;
  const resolution = resolveBoundaries(script, result.boundaries);
  const slices = sliceScenes(script, resolution.offsets);
  const partitionValid = slices.join('') === script;
  const n = resolution.offsets.length;
  const dropped = resolution.dropped.length;
  const repairs = resolution.repairs;
  const dropRate = dropped / Math.max(result.boundaries.length, 1);
  const repairRate = repairs / Math.max(result.boundaries.length, 1);
  const countScore =
    1 -
    Math.min(
      1,
      Math.abs(n - opts.goldSceneCount) / Math.max(opts.goldSceneCount, 1)
    );
  const f1 = opts.goldHeadingStarts
    ? headingF1(resolution.offsets, opts.goldHeadingStarts)
    : 1;

  let quality = pct(
    { w: 4, v: partitionValid ? 1 : 0 },
    { w: 2, v: 1 - dropRate },
    { w: 1, v: 1 - repairRate },
    { w: 2, v: f1 },
    { w: 1, v: countScore }
  );
  if (!partitionValid) quality = Math.min(quality, 35);

  return {
    quality,
    details: {
      partitionValid,
      scenes: n,
      dropped,
      repairs,
      dropRate: Number(dropRate.toFixed(3)),
      headingF1: Number(f1.toFixed(3)),
      title: result.projectMetadata.title,
    },
  };
}

export function scoreBibles(
  result: SceneSplitBiblesResult,
  scriptLineCount: number
): { quality: number; details: Record<string, number | boolean | string> } {
  const names = result.characterBible.map((c) => c.name.toUpperCase());
  const hasScarlett = names.some((n) => n.includes('SCARLETT'));
  const locText = result.locationBible
    .map((l) => `${l.name} ${l.description}`.toLowerCase())
    .join('\n');
  const locHits = ['kitchen', 'stoop', 'subway', 'club'].filter((k) =>
    locText.includes(k)
  ).length;
  const tags = [
    ...result.characterBible.map((c) => c.consistencyTag),
    ...result.locationBible.map((l) => l.consistencyTag),
  ];
  const tagOk =
    tags.length === 0
      ? 0
      : tags.filter((t) => /^[a-z][a-z0-9_]*$/.test(t)).length / tags.length;
  const mentions = [
    ...result.locationBible.map((l) => l.firstMention.lineNumber),
    ...result.elementBible.map((e) => e.firstMention.lineNumber),
  ];
  const lineOk =
    mentions.length === 0
      ? 1
      : mentions.filter((n) => n >= 1 && n <= scriptLineCount).length /
        mentions.length;

  const quality = pct(
    { w: 3, v: hasScarlett ? 1 : 0 },
    { w: 3, v: locHits / 4 },
    { w: 2, v: tagOk },
    { w: 1, v: lineOk },
    { w: 1, v: result.characterBible.length > 0 ? 1 : 0 }
  );
  return {
    quality,
    details: {
      hasScarlett,
      locHits,
      characters: result.characterBible.length,
      locations: result.locationBible.length,
      elements: result.elementBible.length,
      tagOk: Number(tagOk.toFixed(3)),
    },
  };
}

export function scoreTalent(
  matches: Array<{ characterId: string; talentId: string }>
): {
  quality: number;
  details: Record<string, number>;
} {
  const gold = new Map(
    TALENT_CASE.gold.map((g) => [g.talentId, g.characterId])
  );
  const predicted = new Map(matches.map((m) => [m.talentId, m.characterId]));
  let correct = 0;
  for (const [talentId, characterId] of gold) {
    if (predicted.get(talentId) === characterId) correct++;
  }
  const recall = correct / gold.size;
  const prec = matches.length === 0 ? 0 : correct / matches.length;
  const f1 = prec + recall === 0 ? 0 : (2 * prec * recall) / (prec + recall);
  return {
    quality: pct({ w: 1, v: f1 }),
    details: { correct, predicted: matches.length, f1: Number(f1.toFixed(3)) },
  };
}

export function scoreLocation(
  matches: Array<{
    locationId: string;
    libraryLocationId: string;
    confidence: number;
  }>
): { quality: number; details: Record<string, number | boolean> } {
  const gold = new Map(
    LOCATION_CASE.gold.map((g) => [g.libraryLocationId, g.locationId])
  );
  const unmatched = new Set(LOCATION_CASE.unmatchedScriptIds);
  let correct = 0;
  let falsePos = 0;
  for (const m of matches) {
    const expected = gold.get(m.libraryLocationId);
    if (expected && expected === m.locationId) correct++;
    else falsePos++;
    if (unmatched.has(m.locationId)) falsePos++;
  }
  const recall = correct / gold.size;
  const prec =
    matches.length === 0 ? (gold.size === 0 ? 1 : 0) : correct / matches.length;
  const f1 = prec + recall === 0 ? 0 : (2 * prec * recall) / (prec + recall);
  const subwayUnmatched = !matches.some((m) => m.locationId === 'loc_subway');
  const quality = pct({ w: 3, v: f1 }, { w: 1, v: subwayUnmatched ? 1 : 0 });
  return {
    quality,
    details: {
      correct,
      falsePos,
      f1: Number(f1.toFixed(3)),
      subwayUnmatched,
    },
  };
}

const APPEARANCE_LEAK =
  /\b(hair|blonde|brunette|olive|freckles|ethnicity|skin tone|brown eyes|blue eyes)\b/i;
const TEXT_LEAK =
  /\b(subtitle|title card|on-screen text|lower[- ]third|logo outro)\b/i;
const CAMERA_VERBS =
  /\b(dolly|push[- ]in|pull[- ]out|pan|tilt|track|truck|crane|steadicam|handheld|static|lock-off|zoom)\b/i;

export function scoreVisual(
  fullPrompt: string,
  characterName: string
): {
  quality: number;
  details: Record<string, number | boolean>;
} {
  const words = wordCount(fullPrompt);
  const lengthScore =
    words >= 80 && words <= 120 ? 1 : words >= 50 && words <= 160 ? 0.6 : 0.2;
  const name = characterName.toUpperCase();
  const hasName = fullPrompt.toUpperCase().includes(name);
  const appearanceLeak = APPEARANCE_LEAK.test(fullPrompt);
  const textLeak = TEXT_LEAK.test(fullPrompt);
  const quality = pct(
    { w: 2, v: lengthScore },
    { w: 3, v: hasName ? 1 : 0 },
    { w: 3, v: appearanceLeak ? 0 : 1 },
    { w: 2, v: textLeak ? 0 : 1 }
  );
  return {
    quality,
    details: { words, hasName, appearanceLeak, textLeak, lengthScore },
  };
}

export function scoreMotion(
  fullPrompt: string,
  hasDialogue: boolean,
  dialoguePresence: boolean | null | undefined
): { quality: number; details: Record<string, number | boolean> } {
  const chars = fullPrompt.length;
  const words = wordCount(fullPrompt);
  const lengthScore =
    chars <= 2000 && words >= 40 && words <= 160
      ? 1
      : chars <= 2500
        ? 0.6
        : 0.2;
  const cameraHits =
    fullPrompt.match(new RegExp(CAMERA_VERBS.source, 'gi')) ?? [];
  // One primary move is the contract; 1–2 mentions is healthy, 4+ is stacked.
  const cameraScore =
    cameraHits.length === 0
      ? 0
      : cameraHits.length <= 2
        ? 1
        : cameraHits.length === 3
          ? 0.5
          : 0.2;
  const musicLeak = /\b(score|soundtrack|music|orchestral sting)\b/i.test(
    fullPrompt
  );
  const dialogueOk = !hasDialogue || dialoguePresence === true;
  const quality = pct(
    { w: 2, v: lengthScore },
    { w: 3, v: cameraScore },
    { w: 2, v: musicLeak ? 0 : 1 },
    { w: 2, v: dialogueOk ? 1 : 0 },
    { w: 1, v: words > 20 ? 1 : 0 }
  );
  return {
    quality,
    details: {
      chars,
      words,
      cameraMentions: cameraHits.length,
      musicLeak,
      dialogueOk,
    },
  };
}

export function scoreMusic(result: {
  tags: string;
  prompt: string;
  scenes: unknown[];
  expectedScenes: number;
}): { quality: number; details: Record<string, number | boolean> } {
  const tags = result.tags.toLowerCase();
  const startsInstrumental = tags.startsWith('instrumental');
  const vocalLeak = /\b(vocal|singing|lyrics|rapper|choir vocals)\b/i.test(
    `${result.tags} ${result.prompt}`
  );
  const promptHasInstrumental = /instrumental/i.test(result.prompt);
  const countScore =
    result.scenes.length === result.expectedScenes
      ? 1
      : result.scenes.length > 0
        ? 0.4
        : 0;
  const quality = pct(
    { w: 3, v: startsInstrumental ? 1 : 0 },
    { w: 2, v: vocalLeak ? 0 : 1 },
    { w: 2, v: promptHasInstrumental ? 1 : 0 },
    { w: 2, v: countScore },
    { w: 1, v: result.prompt.trim().length > 20 ? 1 : 0 }
  );
  return {
    quality,
    details: {
      startsInstrumental,
      vocalLeak,
      promptHasInstrumental,
      sceneCount: result.scenes.length,
    },
  };
}

export function scoreAutoStyle(result: AutoStyleResponse): {
  quality: number;
  details: Record<string, number | boolean>;
} {
  const palette = result.colorPalette;
  const hexes = palette.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));
  const paletteScore =
    hexes.length >= 3 && hexes.length <= 6 ? 1 : hexes.length > 0 ? 0.4 : 0;
  const hasLook = [
    result.mood,
    result.artStyle,
    result.lighting,
    result.camera,
  ].every((s) => s.trim().length > 4);
  const quality = pct(
    { w: 3, v: paletteScore },
    { w: 3, v: hasLook ? 1 : 0 },
    { w: 2, v: result.name.trim().length > 0 ? 1 : 0 },
    { w: 2, v: result.references.length > 0 ? 1 : 0 }
  );
  return {
    quality,
    details: {
      hexCount: hexes.length,
      hasLook,
      name: result.name.trim().length > 0,
    },
  };
}

export function blend(structural: number, judge: number | undefined): number {
  if (judge === undefined) return structural;
  return Math.round(
    0.55 * structural + 0.45 * Math.min(100, Math.max(0, judge * 10))
  );
}

export function gutterLineCount(script: string): number {
  return addLineGutter(script).split('\n').length;
}

export { PROSE_GOLD_BEATS };
