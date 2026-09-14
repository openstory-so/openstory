/**
 * Character voices (#1553) — the client-safe rules.
 */

import type { CharacterBibleEntry, Scene } from '@/shots/scene-analysis.schema';

/**
 * Does this character get a designed voice? `characters.useVoice` NULL
 * inherits `sequences.generateVoices` — the same shape as `usesStartFrame`.
 */
export function usesVoice(
  character: { useVoice: boolean | null },
  sequence: { generateVoices: boolean }
): boolean {
  return character.useVoice ?? sequence.generateVoices;
}

/**
 * Tokens that name nobody: articles and honorifics shared across a cast
 * ("The Stranger" / "The Barista", "Dr. Chen" / "Dr. Patel"). A false match
 * here is a paid design call and an account-wide slot.
 */
const STOP_TOKENS = new Set([
  'the',
  'an',
  'of',
  'mr',
  'mrs',
  'ms',
  'dr',
  'miss',
  'sir',
  'st',
]);

// ponytail: a shared first name still matches ("Sarah" / "Sarah's Mother");
// per-cue disambiguation is the upgrade path if that bills in practice.
// NFKC folds full-width Latin ("ＳＡＲＡＨ") onto ASCII; the split keeps every
// script's letters, digits and combining marks (#1609).
const normalizeName = (name: string): string =>
  name.normalize('NFKC').toLowerCase().trim();

const nameTokens = (name: string): string[] =>
  normalizeName(name)
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((token) => token.length >= 2 && !STOP_TOKENS.has(token));

/** Whole normalized names are equal — how a one-character name ("李") matches. */
const sameName = (cue: string, name: string): boolean => {
  const a = normalizeName(cue);
  return a !== '' && a === normalizeName(name);
};

const sharesToken = (cue: string, name: string): boolean => {
  const tokens = nameTokens(name);
  return nameTokens(cue).some((token) => tokens.includes(token));
};

/**
 * Bible ids of the characters with a dialogue line in the analysed scenes.
 * Speaker cues are the LLM's spelling of the name ("SARAH"), the bible's is
 * the full one ("Detective Sarah Chen"), so they match on a shared name
 * token rather than exact text. The lines come from the shot-list call
 * (#1585), which sees the cast list and is told to spell speakers as it
 * does, to speak narration through the voice-only entry, and to leave the
 * speaker empty ONLY for a voice nobody could attribute — so a blank cue
 * means "could be anyone", and every character is treated as speaking.
 * No dialogue at all (montage, pure narration with no narrator entry) means
 * no voices: Voices on is not a request to design voices nobody uses.
 */
export function speakingCharacterIds(
  bible: readonly Pick<CharacterBibleEntry, 'characterId' | 'name'>[],
  scenes: readonly Pick<Scene, 'originalScript'>[]
): string[] {
  const cues = scenes.flatMap((scene) =>
    scene.originalScript.dialogue.map((line) => line.character)
  );
  if (cues.some((cue) => cue.trim() === '')) {
    return bible.map((c) => c.characterId);
  }
  return bible
    .filter((character) =>
      cues.some(
        (cue) =>
          sameName(cue, character.name) || sharesToken(cue, character.name)
      )
    )
    .map((character) => character.characterId);
}

/**
 * The character a speaker cue names, or undefined when nobody matches.
 *
 * Blank cues are narration: they match only when exactly one voice-only
 * character is in the list (the usual narrator). Matching everyone would
 * synthesise the same line in every voice. A whole-name match wins over a
 * shared token ("Sarah" over "Sarah's Mother"), whatever the cast order.
 */
export function matchSpeaker<T extends { name: string; voiceOnly?: boolean }>(
  speaker: string,
  characters: readonly T[]
): T | undefined {
  if (speaker.trim() === '') {
    const narrators = characters.filter((character) => character.voiceOnly);
    return narrators.length === 1 ? narrators[0] : undefined;
  }
  return (
    characters.find((character) => sameName(speaker, character.name)) ??
    characters.find((character) => sharesToken(speaker, character.name))
  );
}

/** Where a catalog pick came from (#1629). */
type CatalogVoiceSource = 'premade' | 'library';

export type VoiceGenderFilter = 'male' | 'female' | 'neutral';
export type VoiceAgeFilter = 'young' | 'middle_aged' | 'old';
export type VoiceQualityFilter = 'studio' | 'any';

export const DEFAULT_VOICE_LANGUAGE = 'en';

export const VOICE_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'ar', label: 'Arabic' },
  { value: 'zh', label: 'Chinese' },
  { value: 'cs', label: 'Czech' },
  { value: 'da', label: 'Danish' },
  { value: 'nl', label: 'Dutch' },
  { value: 'fil', label: 'Filipino' },
  { value: 'fi', label: 'Finnish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'el', label: 'Greek' },
  { value: 'hi', label: 'Hindi' },
  { value: 'id', label: 'Indonesian' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'pl', label: 'Polish' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ro', label: 'Romanian' },
  { value: 'ru', label: 'Russian' },
  { value: 'es', label: 'Spanish' },
  { value: 'sv', label: 'Swedish' },
  { value: 'tr', label: 'Turkish' },
  { value: 'uk', label: 'Ukrainian' },
] as const;

/** English-language accents / nationalities, A–Z. */
export const VOICE_NATIONALITIES = [
  { value: 'american', label: 'American' },
  { value: 'australian', label: 'Australian' },
  { value: 'british', label: 'British' },
  { value: 'canadian', label: 'Canadian' },
  { value: 'indian', label: 'Indian' },
  { value: 'irish', label: 'Irish' },
  { value: 'new zealand', label: 'New Zealand' },
  { value: 'scottish', label: 'Scottish' },
  { value: 'south african', label: 'South African' },
  { value: 'welsh', label: 'Welsh' },
] as const;

export const OTHER_VOICE_LANGUAGES = VOICE_LANGUAGES.filter(
  (language) => language.value !== DEFAULT_VOICE_LANGUAGE
);

export type VoiceLanguageFilter = (typeof VOICE_LANGUAGES)[number]['value'];
export type VoiceNationalityFilter =
  (typeof VOICE_NATIONALITIES)[number]['value'];

/** Filters the unified ElevenLabs Voice Library understands. */
export type CatalogVoiceFilters = {
  gender?: VoiceGenderFilter;
  age?: VoiceAgeFilter;
  quality?: VoiceQualityFilter;
  language?: VoiceLanguageFilter;
  accent?: VoiceNationalityFilter;
};

export function inferVoiceGender(
  gender: string | null | undefined
): VoiceGenderFilter | undefined {
  const value = gender?.normalize('NFKC').toLowerCase() ?? '';
  if (!value) return;
  if (/female|woman|girl|she\b|her\b|actress/.test(value) || value === 'f') {
    return 'female';
  }
  if (/non[- ]?binary|neutral|androgyn|agender/.test(value)) {
    return 'neutral';
  }
  if (/male|man|boy|he\b|him\b|actor/.test(value) || value === 'm') {
    return 'male';
  }
  return;
}

export function inferVoiceAge(
  age: string | null | undefined
): VoiceAgeFilter | undefined {
  const value = age?.normalize('NFKC').toLowerCase().trim() ?? '';
  if (!value) return;
  if (/old|elder|senior|retire/.test(value)) return 'old';
  if (/child|teen|young|youth|adolesc/.test(value)) return 'young';
  if (/middle/.test(value)) return 'middle_aged';
  if (/twenties/.test(value)) return 'young';
  if (/thirties|forties|fifties|adult/.test(value)) return 'middle_aged';
  const years = value.match(/\d{1,3}/);
  if (!years) return;
  const n = Number.parseInt(years[0], 10);
  if (n >= 60) return 'old';
  if (n < 30) return 'young';
  return 'middle_aged';
}

export function inferVoiceAccent(
  ethnicity: string | null | undefined
): VoiceNationalityFilter | undefined {
  const value = ethnicity?.normalize('NFKC').toLowerCase() ?? '';
  if (!value) return;
  for (const { value: accent, label } of VOICE_NATIONALITIES) {
    if (value.includes(accent) || value.includes(label.toLowerCase())) {
      return accent;
    }
  }
  if (/\buk\b|united kingdom|england|english/.test(value)) return 'british';
  if (/\busa\b|united states|\bus\b/.test(value)) return 'american';
  return;
}

export function voiceLocaleKey(
  language: VoiceLanguageFilter = DEFAULT_VOICE_LANGUAGE,
  accent?: VoiceNationalityFilter
): string {
  return accent && language === DEFAULT_VOICE_LANGUAGE
    ? `${language}|${accent}`
    : language;
}

export function parseVoiceLocale(
  value: string
): Pick<CatalogVoiceFilters, 'language' | 'accent'> {
  const [language, accent] = value.split('|');
  const languageMatch = VOICE_LANGUAGES.find(
    (option) => option.value === language
  );
  const accentMatch = VOICE_NATIONALITIES.find(
    (option) => option.value === accent
  );
  return {
    language: languageMatch?.value ?? DEFAULT_VOICE_LANGUAGE,
    ...(accentMatch ? { accent: accentMatch.value } : {}),
  };
}

/** Bible → library filters so Browse opens on a shortlist for this character. */
export function recommendVoiceFilters(character: {
  gender?: string | null;
  age?: string | null;
  ethnicity?: string | null;
}): CatalogVoiceFilters {
  const gender = inferVoiceGender(character.gender);
  const age = inferVoiceAge(character.age);
  const accent = inferVoiceAccent(character.ethnicity);
  return {
    language: DEFAULT_VOICE_LANGUAGE,
    ...(gender ? { gender } : {}),
    ...(age ? { age } : {}),
    ...(accent ? { accent } : {}),
  };
}

/** One ElevenLabs default or Voice Library entry the picker can assign. */
export type CatalogVoice = {
  voiceId: string;
  /** Library only — needed to add the shared voice to the platform account. */
  publicOwnerId?: string;
  name: string;
  description: string;
  previewUrl: string | null;
  labels: string[];
  category: string;
  source: CatalogVoiceSource;
};

export type CatalogVoicePage = {
  voices: CatalogVoice[];
  hasMore: boolean;
  nextPage?: number;
  nextPageToken?: string;
};

/** Live metadata for the character's saved `voiceId`. */
export type SavedVoiceMeta = {
  voiceId: string;
  name: string;
  category: string;
  previewUrl: string | null;
  /** Default ElevenLabs voices do not consume an account slot. */
  isPremade: boolean;
};

const PREMADE_LABEL_KEYS = [
  'gender',
  'age',
  'accent',
  'language',
  'use_case',
  'descriptive',
] as const;

function labelsFromRecord(
  labels: Record<string, string> | undefined
): string[] {
  if (!labels) return [];
  const out: string[] = [];
  for (const key of PREMADE_LABEL_KEYS) {
    const value = labels[key]?.trim();
    if (value) out.push(value);
  }
  return out;
}

function labelsFromLibrary(voice: {
  gender?: string;
  age?: string;
  accent?: string;
  language?: string;
  useCase?: string;
  descriptive?: string;
}): string[] {
  return [
    voice.gender,
    voice.age,
    voice.accent,
    voice.language,
    voice.useCase,
    voice.descriptive,
  ].flatMap((value) => {
    const trimmed = value?.trim();
    return trimmed ? [trimmed] : [];
  });
}

export function toCatalogVoiceFromPremade(input: {
  voiceId: string;
  name?: string;
  description?: string;
  previewUrl?: string;
  category?: string;
  labels?: Record<string, string>;
}): CatalogVoice {
  return {
    voiceId: input.voiceId,
    name: input.name?.trim() || 'Untitled voice',
    description: input.description?.trim() ?? '',
    previewUrl: input.previewUrl ?? null,
    labels: labelsFromRecord(input.labels),
    category: input.category ?? 'premade',
    source: 'premade',
  };
}

export function toCatalogVoiceFromLibrary(input: {
  voiceId: string;
  publicOwnerId: string;
  name: string;
  description?: string;
  previewUrl?: string;
  category: string;
  gender?: string;
  age?: string;
  accent?: string;
  language?: string;
  useCase?: string;
  descriptive?: string;
}): CatalogVoice {
  return {
    voiceId: input.voiceId,
    publicOwnerId: input.publicOwnerId,
    name: input.name,
    description: input.description?.trim() ?? '',
    previewUrl: input.previewUrl ?? null,
    labels: labelsFromLibrary(input),
    category: input.category,
    source: input.category === 'premade' ? 'premade' : 'library',
  };
}

/**
 * Premade defaults are shared platform-wide and must never be deleted.
 * Designed voices and library copies we added consume an account slot.
 */
export function voiceConsumesAccountSlot(
  category: string | null | undefined
): boolean {
  return category !== 'premade';
}

/** Short bible line for a catalog pick so the Voice field is not left blank. */
export function catalogVoiceBrief(voice: {
  name: string;
  description?: string;
  labels: string[];
}): string {
  const parts = [voice.name.trim()].filter(Boolean);
  if (voice.labels.length > 0) parts.push(voice.labels.join(', '));
  const description = voice.description?.trim();
  if (description && description !== voice.name.trim()) {
    parts.push(description);
  }
  return parts.join('. ');
}

/**
 * A Voice Design take is in use only when the saved voice is still that
 * designed voice (category `generated`, or unknown while metadata loads)
 * and it sits at the front of `voicePreviews`.
 */
export function designedTakeIsInUse(
  index: number,
  voiceId: string | null | undefined,
  category: string | null | undefined
): boolean {
  if (!voiceId || index !== 0) return false;
  return category == null || category === 'generated';
}
