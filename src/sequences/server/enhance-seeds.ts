import type { EnhanceSeeds } from '@/sequences/script-enhancer';
import { ENHANCE_SEED_DATA } from './enhance-seeds.data';

/**
 * A model asked to invent a person and a place picks from a very small pool,
 * and every call is independent, so the prompt cannot tell it what it chose
 * last time (#2076: one name in 17 of 20 scripts for the same brief). So the
 * draw happens here, from published lists, and the enhancer is told to start
 * from it.
 */

// IMDb's genre list.
const GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Biography',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'Film-Noir',
  'History',
  'Horror',
  'Music',
  'Musical',
  'Mystery',
  'Romance',
  'Sci-Fi',
  'Sport',
  'Thriller',
  'War',
  'Western',
] as const;

// ponytail: word count stands in for "the user left the choices open". A short
// brief that does name its person or place is covered by the prompt wording
// (the brief wins). Swap for a classifier if short specific briefs get bent.
const THIN_BRIEF_WORDS = 15;

const NAMES: Readonly<Record<string, string>> = ENHANCE_SEED_DATA.names;
const TOWNS: Readonly<Record<string, string>> = ENHANCE_SEED_DATA.towns;
const COUNTRIES_WITH_NAMES = Object.keys(NAMES).filter((c) => c in TOWNS);

function pick(list: string | readonly string[], random: () => number): string {
  const items = typeof list === 'string' ? list.split('|') : list;
  return items[Math.floor(random() * items.length)] ?? '';
}

/**
 * The starting points for one enhance call, or `undefined` when the brief is
 * specific: the user already made the choices.
 *
 * Names and towns follow the user's country. With no country, one is drawn so
 * the name and the town still belong together. A country with no name list
 * gets no name rather than another country's.
 */
export function drawEnhanceSeeds(
  input: {
    script: string;
    invent: boolean;
    hasStyle: boolean;
    country: string | undefined;
  },
  random: () => number = Math.random
): EnhanceSeeds | undefined {
  const words = input.script.trim().split(/\s+/).filter(Boolean).length;
  if (!input.invent && words >= THIN_BRIEF_WORDS) return undefined;

  const country = input.country || pick(COUNTRIES_WITH_NAMES, random);
  const names = NAMES[country];
  const towns = TOWNS[country];
  const countryName = new Intl.DisplayNames(['en'], { type: 'region' }).of(
    country
  );
  return {
    name: names ? pick(names, random) : null,
    town: towns ? `${pick(towns, random)}, ${countryName ?? country}` : null,
    venue: pick(ENHANCE_SEED_DATA.venues, random),
    occupation: pick(ENHANCE_SEED_DATA.jobs, random),
    // A style is the genre. A brief has its own; only a blank page needs one.
    genre: input.invent && !input.hasStyle ? pick(GENRES, random) : null,
  };
}
