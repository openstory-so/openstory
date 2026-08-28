/**
 * Build an image-generation prompt that art-directs a SCENE in a style.
 *
 * Two deliberate choices fix the "too literal" failure mode (issue #718):
 *  1. We never inject the style *name*. For medium-named styles ("Pop-Up Book",
 *     "Animatic", "As Seen On Phone") the name makes the model render the
 *     artifact (a book, a storyboard sheet) instead of a scene in that look.
 *  2. We frame the scene as the subject and the style fields as *treatment*,
 *     and forbid grids / panels / collage so e.g. an animatic renders one frame,
 *     not a sheet of numbered panels.
 *
 * The aesthetic comes entirely from `config` (artStyle/mood/lighting/cameraWork/
 * colorGrading/referenceFilms). Shared by the preview thumbnails
 * (`generate-style-previews.ts`) and the sample-video stills
 * (`generate-style-sample-videos.ts`) so the framing lives in one place.
 */
import type { StyleConfig } from '@/lib/db/schema/libraries';

const STILL_NEGATIVE =
  'Render the described scene as the subject, in this visual style — do not depict the medium, format, or a title card as the subject. ' +
  'A single full-frame image only. No grid, no panels, no collage, no montage, no split screen, no contact sheet, no multiple frames, no margins or frame numbers. ' +
  'No text, no words, no titles, no captions, no watermarks, no logos. ' +
  'No celebrities, no famous people, no real identifiable individuals. ' +
  'Anatomically correct: natural hands with exactly five fingers, no extra or missing limbs, hands, or fingers.';

/** Compose the full image prompt for `scene` rendered in `config`'s style. */
export function buildStyledImagePrompt(
  scene: string,
  config: StyleConfig
): string {
  const { look, motion, references } = config;
  return [
    `A single, full-frame cinematic still of the following scene, art-directed in the style described below: ${scene}`,
    `Art Style: ${look.artStyle}`,
    look.medium ? `Medium: ${look.medium}` : '',
    `Mood: ${look.mood}`,
    `Lighting: ${look.lighting}`,
    `Camera: ${motion.camera}`,
    motion.shots ? `Shot selection: ${motion.shots}` : '',
    `Color Grading: ${look.colorGrading}`,
    references.length ? `Inspired by: ${references.join(', ')}` : '',
    STILL_NEGATIVE,
  ]
    .filter(Boolean)
    .join('. ');
}
