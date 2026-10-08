/**
 * Local scene fields derived from a verbatim script slice (#1218).
 *
 * Scene-split's LLM call only annotates boundaries. Title, location,
 * time of day and duration are read off the slice the splitter already
 * cut — no second generation, no re-emitted script text. Dialogue is only
 * previewed here (screenplay cues); the shot-list call supplies it (#1585).
 * Continuity tags are assigned later from bibles ∩ slice.
 *
 * Text before the first scene heading is not a scene (#2077). The boundary
 * partition still covers it; `filmmableSlices` is what becomes a scene. The
 * bibles call is given the whole script, so a character list written there
 * is still cast.
 */

import { DIALOGUE_WORDS_PER_SECOND } from '@/motion/dialogue-tts';
import { plainSceneTitle } from '@/platform/markdown-plain';
import type {
  Continuity,
  DialogueLine,
  SceneMetadata,
} from '@/shots/scene-analysis.schema';

/**
 * Action is watched, not spoken (#2077). Three times the speaking rate: a
 * wordy action line takes a third of the time it would take to say.
 */
const ACTION_WORDS_PER_SECOND = DIALOGUE_WORDS_PER_SECOND * 3;

const SCENE_HEADING_PREFIX = /^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.)(?:\s|$)/i;
const TIME_WORD = 'DAY|NIGHT|DAWN|DUSK|EVENING|MORNING|CONTINUOUS|LATER|SAME';
const TIME_SUFFIX = new RegExp(
  `\\s*[-–—]\\s*((?:EARLY|LATE|MID)\\s+)?(${TIME_WORD})\\b.*$`,
  'i'
);
/** Enhancer labels like `Scene 3 — 5s` — scene total, not a location heading. */
const SCENE_DURATION_LABEL = /^Scene\s+\d+\s*[–—-]\s*(\d+)\s*s\b/i;
/**
 * `Shot 1 — 4s` — a label Enhance no longer writes (#1621), but still shows
 * up in already-enhanced scripts from before this change. Recognized only to
 * skip past it while hunting for the real heading line below it — never
 * parsed for a value, never used to lock shot count or duration.
 */
const LEGACY_SHOT_LABEL_LINE = /^Shot\s+\d+\s*[–—-]\s*\d+\s*s\b/i;
const TRANSITION =
  /^(?:CUT TO:|DISSOLVE TO:|FADE IN:|FADE OUT[.:]?|SMASH CUT TO:|MATCH CUT TO:|WIPE TO:)\s*$/i;
const PARENTHETICAL = /^\([^)]+\)$/;
const CHARACTER_CUE = /^[A-Z][A-Z0-9 .'-]*(?:\s*\([^)]+\))?\s*$/;
const INLINE_CUE = /^([A-Z][A-Z0-9 .'-]{1,39}):\s+(.+)$/;

const EMPTY_CONTINUITY: Continuity = {
  characterTags: [],
  environmentTag: '',
  elementTags: null,
  colorPalette: '',
  lightingSetup: '',
  styleTag: '',
};

export type SceneHeading = {
  title: string;
  location: string;
  timeOfDay: string;
};

export function parseSceneHeading(firstLine: string): SceneHeading {
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) {
    return { title: '', location: '', timeOfDay: '' };
  }
  // Scripts are authored in a markdown editor; strip sigils before matching
  // INT./EXT. so `**INT. OFFICE - DAY**` parses as a real slugline.
  const heading = plainSceneTitle(trimmed) || trimmed;

  const timeMatch = heading.match(TIME_SUFFIX);
  const timeOfDay = [timeMatch?.[1]?.trim(), timeMatch?.[2]]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .toLowerCase();
  const isHeading = SCENE_HEADING_PREFIX.test(heading) || timeMatch !== null;

  if (!isHeading) {
    const fallback =
      heading.length > 50 ? `${heading.slice(0, 47)}...` : heading;
    return { title: fallback, location: '', timeOfDay: '' };
  }

  const withoutPrefix = heading.replace(
    /^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.)\s*/i,
    ''
  );
  const core = withoutPrefix.replace(TIME_SUFFIX, '').trim();
  return {
    title: core || heading,
    location: heading,
    timeOfDay,
  };
}

function parseDurationLabel(trimmed: string, pattern: RegExp): number | null {
  const match = trimmed.match(pattern);
  if (!match?.[1]) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

function isDurationLabel(trimmed: string): boolean {
  return (
    SCENE_DURATION_LABEL.test(trimmed) || LEGACY_SHOT_LABEL_LINE.test(trimmed)
  );
}

type SliceLead = {
  headingLine: string;
  durationSeconds: number | null;
};

function sliceLead(slice: string): SliceLead {
  let durationSeconds: number | null = null;
  for (const line of slice.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (isDurationLabel(trimmed)) {
      const labeled = parseDurationLabel(trimmed, SCENE_DURATION_LABEL);
      if (labeled !== null && durationSeconds === null) {
        durationSeconds = labeled;
      }
      continue;
    }
    return { headingLine: trimmed, durationSeconds };
  }
  return { headingLine: '', durationSeconds };
}

function isSceneHeading(trimmed: string): boolean {
  return SCENE_HEADING_PREFIX.test(trimmed) || TIME_SUFFIX.test(trimmed);
}

function isCharacterCue(trimmed: string): boolean {
  if (trimmed.length < 2 || trimmed.length > 40) return false;
  if (isSceneHeading(trimmed) || TRANSITION.test(trimmed)) return false;
  if (!CHARACTER_CUE.test(trimmed)) return false;
  return /[A-Z]{2}/.test(trimmed);
}

function cueName(trimmed: string): string {
  return trimmed.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Streaming PREVIEW value only. Understands screenplay cues (`SARAH` /
 * `NAME: line`), not prose speech. Seeded into the split script version
 * mid-stream, then overwritten in `persist-scenes` by the shot-list call's
 * per-shot lines (#1585, `dialogueFromShots`).
 */
export function extractDialogueFromSlice(slice: string): DialogueLine[] {
  const lines = slice.split('\n');
  const dialogue: DialogueLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? '';
    if (trimmed.length === 0) continue;

    const inline = trimmed.match(INLINE_CUE);
    if (inline?.[1] && inline[2] && !isSceneHeading(inline[1])) {
      dialogue.push({
        character: cueName(inline[1]),
        line: inline[2],
        tone: '',
      });
      continue;
    }

    if (!isCharacterCue(trimmed)) continue;

    const character = cueName(trimmed);
    const parts: string[] = [];
    i += 1;
    while (i < lines.length) {
      const next = lines[i]?.trim() ?? '';
      if (next.length === 0) {
        if (parts.length > 0) break;
        i += 1;
        continue;
      }
      if (PARENTHETICAL.test(next)) {
        i += 1;
        continue;
      }
      if (
        isCharacterCue(next) ||
        isSceneHeading(next) ||
        TRANSITION.test(next)
      ) {
        i -= 1;
        break;
      }
      parts.push(next);
      i += 1;
    }
    if (parts.length > 0) {
      dialogue.push({ character, line: parts.join(' '), tone: '' });
    }
  }

  return dialogue;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Playing time of prose with no scene heading and no speaker cue. The rule
 * of thumb (a page is a minute, ~170 words) is about three words a second.
 * No ceiling — a pasted feature's two-page scene is two minutes, and its
 * shot budget follows (#1593). Floor keeps a one-liner renderable.
 */
function estimateSecondsFromText(text: string): number {
  return Math.max(3, Math.round(wordCount(text) / 3));
}

function plainLine(trimmed: string): string {
  return plainSceneTitle(trimmed) || trimmed;
}

/** A slugline, a location-time heading, or an enhancer `Scene N — Xs` label. */
function isSceneStartLine(trimmed: string): boolean {
  const plain = plainLine(trimmed);
  return SCENE_DURATION_LABEL.test(plain) || isSceneHeading(plain);
}

/**
 * Offset where the first filmable scene starts. `null` when the script has
 * no scene heading and no `Scene N — Xs` label — a prose paste has no front
 * matter to find (#2077).
 */
function sceneStartOffset(script: string): number | null {
  let offset = 0;
  const lines = script.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length > 0 && isSceneStartLine(line.trim())) return offset;
    offset += line.length + (i < lines.length - 1 ? 1 : 0);
  }
  return null;
}

/**
 * Boundary offsets with the preamble before the first scene heading removed
 * (#2077). Offsets are unchanged when the script has no scene start, or
 * already begins on one — including a prose split, which stays as the
 * boundary resolver cut it.
 */
export function filmableOffsets(script: string, offsets: number[]): number[] {
  const start = sceneStartOffset(script);
  if (start == null || start <= 0) return offsets;
  const kept = offsets.filter((offset) => offset >= start);
  if (kept.length === 0 || kept[0] !== start) kept.unshift(start);
  return kept;
}

/** Slices a filmable-offset list the way `sliceScenes` slices a partition. */
export function filmableSlices(script: string, offsets: number[]): string[] {
  const played = filmableOffsets(script, offsets);
  if (played.length === 0) return script.length > 0 ? [script] : [];
  return played.map((start, i) =>
    script.slice(start, played[i + 1] ?? script.length)
  );
}

function usesPlayedTiming(text: string): boolean {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const plain = plainLine(trimmed);
    if (isSceneHeading(plain) || SCENE_DURATION_LABEL.test(plain)) return true;
    if (isCharacterCue(trimmed)) return true;
    const inline = trimmed.match(INLINE_CUE);
    if (inline?.[1] && inline[2] && !isSceneHeading(plainLine(inline[1]))) {
      return true;
    }
  }
  return false;
}

/**
 * Words that play. Sluglines, enhancer scene labels and speaker names do
 * not. Dialogue follows the cue walk in `extractDialogueFromSlice`.
 */
function playedWords(text: string): { dialogue: number; action: number } {
  const lines = text.split('\n');
  let dialogue = 0;
  let action = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? '';
    if (trimmed.length === 0) continue;
    const plain = plainLine(trimmed);
    if (isSceneHeading(plain) || SCENE_DURATION_LABEL.test(plain)) continue;

    const inline = trimmed.match(INLINE_CUE);
    if (inline?.[1] && inline[2] && !isSceneHeading(plainLine(inline[1]))) {
      dialogue += wordCount(inline[2]);
      continue;
    }

    if (!isCharacterCue(trimmed)) {
      action += wordCount(trimmed);
      continue;
    }

    let spoken = 0;
    i += 1;
    while (i < lines.length) {
      const next = lines[i]?.trim() ?? '';
      if (next.length === 0) {
        if (spoken > 0) break;
        i += 1;
        continue;
      }
      if (PARENTHETICAL.test(next)) {
        i += 1;
        continue;
      }
      if (
        isCharacterCue(next) ||
        isSceneHeading(plainLine(next)) ||
        SCENE_DURATION_LABEL.test(plainLine(next)) ||
        TRANSITION.test(next)
      ) {
        i -= 1;
        break;
      }
      spoken += wordCount(next);
      i += 1;
    }
    dialogue += spoken;
  }

  return { dialogue, action };
}

/**
 * Playing time of one unlabelled slice (#2077). Screenplay structure
 * (a heading or a speaker cue) times dialogue at the speaking rate and
 * action faster; sluglines and speaker names are free. Anything else — a
 * prose paste with no heading to find — stays at three words a second.
 * Floor keeps a one-liner renderable. A `Scene N — Xs` label is read by
 * `buildSceneFromSlice` and never reaches here.
 */
function estimatePlayingSeconds(text: string): number {
  if (!usesPlayedTiming(text)) return estimateSecondsFromText(text);
  const { dialogue, action } = playedWords(text);
  const seconds =
    dialogue / DIALOGUE_WORDS_PER_SECOND + action / ACTION_WORDS_PER_SECOND;
  return Math.max(3, Math.round(seconds));
}

/**
 * Playing time of a whole unlabelled script, for the credit pre-flight.
 * Front matter before the first scene heading is not timed. A script with
 * no scene heading uses {@link estimateSecondsFromText} on all of it.
 */
export function estimateUnlabelledScriptSeconds(script: string): number {
  const start = sceneStartOffset(script);
  if (start == null) return estimateSecondsFromText(script);
  return estimatePlayingSeconds(script.slice(start));
}

export function buildSceneFromSlice(
  sceneId: string,
  index: number,
  slice: string
): {
  sceneId: string;
  sceneNumber: number;
  originalScript: { extract: string; dialogue: DialogueLine[] };
  metadata: SceneMetadata;
  continuity: Continuity;
} {
  const lead = sliceLead(slice);
  const heading = parseSceneHeading(lead.headingLine);
  const title = heading.title || `Scene ${index + 1}`;
  return {
    sceneId,
    sceneNumber: index + 1,
    originalScript: {
      extract: slice,
      dialogue: extractDialogueFromSlice(slice),
    },
    metadata: {
      title,
      durationSeconds: lead.durationSeconds ?? estimatePlayingSeconds(slice),
      location: heading.location,
      timeOfDay: heading.timeOfDay,
      storyBeat: '',
    },
    continuity: { ...EMPTY_CONTINUITY },
  };
}

/**
 * Continuation slices often have no slugline. Copy location/time from the
 * previous scene so environment tags still bind (screenplay default: stay
 * at the last heading until a new one appears).
 */
export function inheritMissingLocation<T extends { metadata: SceneMetadata }>(
  scene: T,
  previous: T | undefined
): T {
  if (scene.metadata.location || !previous?.metadata.location) return scene;
  return {
    ...scene,
    metadata: {
      ...scene.metadata,
      location: previous.metadata.location,
      timeOfDay: scene.metadata.timeOfDay || previous.metadata.timeOfDay,
    },
  };
}
