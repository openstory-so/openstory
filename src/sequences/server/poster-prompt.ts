import type { StyleConfig } from '@/platform/server/db/schema/libraries';
import { REFERENCE_LIKENESS_INSTRUCTION } from '@/cast/character-prompt';
import { UNTITLED_SEQUENCE_TITLE } from '@/sequences/untitled-sequence-title';
import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import type { ShotSpec } from '@/shots/shot-list.schema';

const MAX_PROMPT_LENGTH = 2000;
const MAX_SCRIPT_LENGTH = 500;
// The whole drawable spec fits (#2094): framing, action, camera and direction
// are structured, not a slice of the script. Still bounded so one runaway
// field cannot crowd out the drawing instructions.
const MAX_SHOT_TEXT_LENGTH = 1600;
const MAX_CAST_IN_SHOT = 4;
const MAX_CHARACTER_LENGTH = 400;
const MAX_PREVIEW_PROMPT_LENGTH = 4000;

/** Scene fields the preview prompt reads. Narrower than SceneSplittingScene. */
export type PreviewShotScene = {
  shots?: ReadonlyArray<
    Pick<
      ShotSpec,
      'shotNumber' | 'framing' | 'action' | 'cameraMovement' | 'direction'
    >
  >;
  originalScript: { extract: string };
  metadata: { title: string; location: string; timeOfDay: string };
};

/** Bible fields a preview draws a character from. */
export type PreviewCharacter = Pick<
  CharacterBibleEntry,
  | 'name'
  | 'age'
  | 'gender'
  | 'physicalDescription'
  | 'standardClothing'
  | 'voiceOnly'
>;

const SKETCH_SUFFIX =
  "Drawn as a storyboard artist's animatic frame: confident pencil line with flat grey marker tones, three or four values, greyscale only even where the description names a colour. Clear silhouettes, correct perspective and depth, the set blocked in with simple shapes. Figures have readable poses, gestures and simple expressive faces. Draw the single opening moment of the shot: each character appears exactly once, and what happens next is shown only by a few bold arrows for the camera move and the way subjects travel. A rough pre-production drawing: not a finished illustration, not a photo, not a 3D render. The drawing fills the whole image edge to edge: no border, no frame line, no paper margin, no grid of panels.";

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

function clampPrompt(prompt: string, max = MAX_PROMPT_LENGTH): string {
  if (prompt.length <= max) return prompt;
  return prompt.slice(0, max - 3) + '...';
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

/**
 * Animatic text for one shot's preview (#1642). Shot spec is the source of
 * truth, including on a 1-shot scene; the scene slice is the empty-spec
 * fallback. Every drawable field goes in (#2094); sound and dialogue are not
 * drawable and stay out. Style stays out (#1277). Location/time-of-day live
 * on the scene and already show up inside composition — appending them draws
 * signage.
 */
export function previewTextForShot(
  scene: PreviewShotScene,
  shotNumber: number
): string {
  const spec = scene.shots?.find((shot) => shot.shotNumber === shotNumber);
  if (spec) {
    const clean = (part: string) => part.trim().replace(/\.+$/, '');
    const camera = [spec.cameraMovement.move, spec.cameraMovement.pacing]
      .map(clean)
      .filter((part) => part.length > 0)
      .join(', ');
    const parts = [
      spec.framing.shotSize,
      spec.framing.angle,
      spec.framing.composition,
      spec.framing.subjectStartState,
      spec.action && `Then: ${spec.action}`,
      camera && `Camera: ${camera}`,
      spec.direction,
    ]
      .map(clean)
      .filter((part) => part.length > 0);
    if (parts.length > 0) return parts.join('. ');
  }
  return (
    scene.originalScript.extract || scene.metadata.title || 'A cinematic scene'
  );
}

/**
 * The characters a shot's text names, described from the bible (#2094). The
 * bibles call has finished before the first shot list lands, so a preview can
 * draw the cast as written without waiting for a sheet.
 */
function previewCastForShot(
  shotText: string,
  cast: ReadonlyArray<PreviewCharacter>
): string {
  const text = shotText.toLowerCase();
  return (
    cast
      // ponytail: a name match, so a shot that only says "she" draws a
      // generic figure. Resolve through the scene roster if that shows.
      .filter(
        (entry) =>
          !entry.voiceOnly &&
          entry.name.trim().length > 0 &&
          text.includes(entry.name.trim().toLowerCase())
      )
      .slice(0, MAX_CAST_IN_SHOT)
      .map((entry) => {
        const who = [
          entry.gender,
          entry.age,
          // A cast talent's bible points at a sheet the preview does not send.
          entry.physicalDescription.replace(REFERENCE_LIKENESS_INSTRUCTION, ''),
        ]
          .map((part) => part.trim().replace(/\.+$/, ''))
          .filter((part) => part.length > 0)
          .join(', ');
        const clothing = entry.standardClothing.trim().replace(/\.+$/, '');
        const line = [who, clothing && `wearing ${clothing}`]
          .filter((part) => part.length > 0)
          .join(', ');
        const text = `${entry.name.trim()}: ${line}`;
        return text.length > MAX_CHARACTER_LENGTH
          ? text.slice(0, MAX_CHARACTER_LENGTH).replace(/\s+\S*$/, '')
          : text;
      })
      .map((line) => `${line}.`)
      .join(' ')
  );
}

/**
 * Build an image generation prompt for a fast shot preview.
 *
 * Previews are stand-ins rendered before any character/location reference
 * exists, so anything rendered "for real" is wrong by construction and reads
 * as inconsistency (or worse, as the final look) — #1277. Ask for a grey
 * storyboard animatic panel instead (#2094): staged and posed like the shot,
 * drawn so nobody takes it for the still.
 * Deliberately ignores the style config for the same reason — a photoreal
 * style would pull the sketch back toward realism.
 */
export function buildPreviewPrompt(
  shotText: string,
  cast: ReadonlyArray<PreviewCharacter>
): string {
  const excerpt = shotText
    .slice(0, MAX_SHOT_TEXT_LENGTH)
    .trim()
    .replace(/\.+$/, '');
  const characters = previewCastForShot(excerpt, cast);

  return clampPrompt(
    [
      `Storyboard animatic frame. ${excerpt}.`,
      characters && `Characters: ${characters}`,
      SKETCH_SUFFIX,
      NO_TEXT_SUFFIX,
    ]
      .filter((part) => part)
      .join(' '),
    MAX_PREVIEW_PROMPT_LENGTH
  );
}
