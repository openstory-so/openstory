/**
 * Prompt shuffle for the Images / Videos composers (#1274).
 *
 * A short, hand-written pool per activity. Image prompts are stills
 * (light, place, one subject). Video prompts name a single motion that
 * can play in a few seconds. `random` is injected so tests stay deterministic.
 */

import type { StudioActivity } from '@/lib/studio/schema';

const STUDIO_IMAGE_PROMPTS = [
  'A red fox in knee-high marsh grass at blue hour, breath visible, 35mm, shallow depth of field',
  'Overhead still life: a cracked pomegranate on a zinc counter, juice pooling toward a silver knife, hard side light',
  "Brutalist concrete stairwell at night, one sodium lamp, a child's yellow raincoat hanging on the rail",
  'Close portrait of an older woman with silver braids, window light, dust in the air, linen shirt',
  'A 1970s Tokyo phone booth in rain, neon kanji smeared on wet glass, empty interior',
  'Desert highway at noon, a single turquoise motel sign, no cars, heat shimmer',
  'A flooded mid-century living room, furniture half underwater, a table lamp still on',
  "Night train window: a child's reflection over dark fields, one farmhouse light",
  'An astronaut visor in a cluttered garage, reflecting a family dinner through the open door',
  'Hand-tinted kitchen of a lighthouse keeper, steam from a kettle, oilskins on a peg',
  'Rooftop basketball court at dusk, one player sitting on the ball, city grid below',
  'Macro: a moth pinned to cork, a moth-eaten hole in the paper behind it, museum cabinet light',
] as const;

const STUDIO_VIDEO_PROMPTS = [
  'The fox lifts its head and looks into lens, fog drifting left to right, slow push-in',
  'Pomegranate juice creeps toward the knife as a fly lands on the blade, locked-off macro',
  'Rain sheets down the phone booth glass; a train passes behind, camera static',
  'The yellow raincoat on the stairwell rail lifts in a draft, sodium light flickers once',
  'A plastic bag rolls into frame and snags on the motel sign, heat shimmer over the highway',
  'The lamp in the flooded room bobs; a photograph floats past camera, slow dolly',
  "Night train: the farmhouse light slides across the window, the child's reflection blinks",
  'Garage door starts to close; the dinner in the visor shrinks, slow zoom',
  'Kettle steam blooms; a hand enters and lifts it off the hob',
  'The player stands, dribbles twice, city lights flicker on behind them',
  'A bicycle light streaks past the booth, neon ripples in the puddle',
  "The moth's wings twitch once under the pin; a cabinet reflection of someone walking by",
] as const;

export function studioShufflePrompts(
  activity: StudioActivity
): readonly string[] {
  return activity === 'video' ? STUDIO_VIDEO_PROMPTS : STUDIO_IMAGE_PROMPTS;
}

/**
 * Next shuffle prompt: uniformly random among the pool, never the current
 * text when another option exists. Returns null only for an empty pool.
 */
export function pickShufflePrompt(
  prompts: readonly string[],
  current: string,
  random: () => number
): string | null {
  if (prompts.length === 0) return null;
  const trimmed = current.trim();
  const candidates = prompts.filter((prompt) => prompt !== trimmed);
  const pool = candidates.length > 0 ? candidates : prompts;
  return pool[Math.floor(random() * pool.length)] ?? null;
}
