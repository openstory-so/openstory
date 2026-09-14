import type { StyleConfig } from '@/platform/server/db/schema/libraries';
import { UNTITLED_SEQUENCE_TITLE } from '@/sequences/untitled-sequence-title';
import type { ShotSpec } from '@/shots/shot-list.schema';

const MAX_PROMPT_LENGTH = 2000;
const MAX_SCRIPT_LENGTH = 500;
// Short on purpose (#1277): every extra line of screenplay is detail the model
// tries to draw, and detail is exactly what a stand-in must not have. Shot-spec
// previews are structured framing (not a slice of the script), so they get a
// longer budget — composition is the load-bearing field (#1642).
const MAX_SHOT_TEXT_LENGTH = 900;

/** Scene fields the preview prompt reads. Narrower than SceneSplittingScene. */
export type PreviewShotScene = {
  shots?: ReadonlyArray<Pick<ShotSpec, 'shotNumber' | 'framing' | 'action'>>;
  originalScript: { extract: string };
  metadata: { title: string; location: string; timeOfDay: string };
};

const SKETCH_SUFFIX =
  'Loose freehand black line drawing on plain flat white, quick gesture strokes, nothing ruled or geometric. Figures as a few flowing outline strokes with blank faces, the setting hinted with a handful of loose lines. No shading, no texture, no colour, no rendering, no realism, no detail.';

const NO_TEXT_SUFFIX =
  'No text, no titles, no subtitles, no watermarks, no letters, no words, no signs, no UI elements.';

function formatStyleDetails(styleConfig: StyleConfig): string {
  const details = [
    `Art style: ${styleConfig.look.artStyle}`,
    `Mood: ${styleConfig.look.mood}`,
    `Lighting: ${styleConfig.look.lighting}`,
  ];

  return details.join('. ') + '.';
}

function clampPrompt(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_LENGTH) return prompt;
  return prompt.slice(0, MAX_PROMPT_LENGTH - 3) + '...';
}

/**
 * Build an image generation prompt for a sequence poster image.
 * Combines the sequence title, opening script text, and style config
 * into a single prompt suitable for fast preview image generation.
 */
export function buildPosterPrompt(
  title: string,
  script: string,
  styleConfig?: StyleConfig
): string {
  const scriptExcerpt = script.slice(0, MAX_SCRIPT_LENGTH).trim();

  // The poster renders before scene-split names the sequence, so the title
  // is normally still the placeholder — say nothing rather than "Untitled".
  const parts: string[] = [
    title === UNTITLED_SEQUENCE_TITLE
      ? `A cinematic establishing shot.`
      : `A cinematic establishing shot for "${title}".`,
    `Opening scene: ${scriptExcerpt}`,
  ];

  if (styleConfig) {
    const style = formatStyleDetails(styleConfig);
    if (style) parts.push(style);
  }

  parts.push(NO_TEXT_SUFFIX);
  return clampPrompt(parts.join(' '));
}

/** Drop ALL-CAPS sluglines — they read as signage against NO_TEXT_SUFFIX. */
function previewPart(value: string): string {
  const trimmed = value.trim().replace(/\.+$/, '');
  const letters = trimmed.replace(/[^A-Za-z]/g, '');
  if (letters.length > 0 && letters === letters.toUpperCase()) return '';
  return trimmed;
}

/**
 * Animatic text for one shot's preview (#1642). Shot spec is the source of
 * truth, including on a 1-shot scene; the scene slice is the empty-spec
 * fallback. Style stays out (#1277).
 */
export function previewTextForShot(
  scene: PreviewShotScene,
  shotNumber: number
): string {
  const spec = scene.shots?.find((shot) => shot.shotNumber === shotNumber);
  if (spec) {
    const parts = [
      spec.framing.shotSize,
      spec.framing.angle,
      spec.framing.composition,
      spec.framing.subjectStartState,
      spec.action,
      scene.metadata.location,
      scene.metadata.timeOfDay,
    ]
      .map(previewPart)
      .filter((part) => part.length > 0);
    if (parts.length > 0) return parts.join('. ');
  }
  return (
    scene.originalScript.extract || scene.metadata.title || 'A cinematic scene'
  );
}

/**
 * Build an image generation prompt for a fast shot preview.
 *
 * Previews are stand-ins rendered before any character/location reference
 * exists, so anything rendered "for real" is wrong by construction and reads
 * as inconsistency (or worse, as the final look) — #1277. Ask for a flat
 * line-art animatic frame instead: outline figures, no detail to be
 * inconsistent about.
 * Deliberately ignores the style config for the same reason — a photoreal
 * style would pull the sketch back toward realism.
 */
export function buildPreviewPrompt(shotText: string): string {
  const excerpt = shotText
    .slice(0, MAX_SHOT_TEXT_LENGTH)
    .trim()
    .replace(/\.+$/, '');

  return clampPrompt(
    [`Animatic frame. ${excerpt}.`, SKETCH_SUFFIX, NO_TEXT_SUFFIX].join(' ')
  );
}
