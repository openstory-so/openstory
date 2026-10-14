#!/usr/bin/env bun
/**
 * Builds `src/sequences/server/enhance-seeds.data.ts` (#2076): the lists the
 * enhancer draws a name, town, kind of place and job from. Every list is
 * downloaded from published data. None is written by a model, because a
 * model-written list carries the same narrow taste the draw exists to replace.
 *
 *   bun scripts/build-enhance-seeds.ts
 *
 * Sources:
 * - Names: sigpwned/popular-names-by-country-dataset (CC0), the most popular
 *   given names per country as published by national statistics offices.
 * - Towns: GeoNames cities15000 (CC BY 4.0), largest first.
 * - Kinds of place: OpenStreetMap tag values by use, from taginfo (ODbL).
 * - Jobs: O*NET "Sample of Reported Titles" (CC BY 4.0, US Department of
 *   Labor), one reported title per occupation.
 *
 * Server JS is heap (#1893), so the lists are capped and stored as one string
 * per list.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NAMES_URL =
  'https://raw.githubusercontent.com/sigpwned/popular-names-by-country-dataset/main/common-forenames-by-country.csv';
const TOWNS_URL = 'https://download.geonames.org/export/dump/cities15000.zip';
const JOBS_URL =
  'https://www.onetcenter.org/dl_files/database/db_29_0_text/Sample%20of%20Reported%20Titles.txt';
const taginfoUrl = (key: string) =>
  `https://taginfo.openstreetmap.org/api/4/key/values?key=${key}&sortname=count_all&sortorder=desc&rp=60&page=1`;

const TOWNS_PER_COUNTRY = 30;
const VENUE_KEYS = ['amenity', 'shop', 'leisure', 'tourism'] as const;
/**
 * OpenStreetMap values that are not somewhere a scene can happen: street
 * furniture, parts of a car park, placeholders. Only ever removes.
 */
const NOT_A_VENUE = new Set(
  `parking parking_space bench waste_basket bicycle_parking shelter recycling
  toilets post_box vending_machine drinking_water waste_disposal hunting_stand
  parking_entrance atm charging_station fountain parcel_locker bicycle_rental
  telephone public_bookcase letter_box motorcycle_parking bbq water_point
  grit_bin shower clock watering_place trolley_bay bicycle_repair_station
  lounger ticket_validator payment_terminal compressed_air car_sharing
  weighbridge sanitary_dump_station vacuum_cleaner taxi public_building
  yes vacant outpost trade general ticket
  pitch picnic_table track fitness_station outdoor_seating slipway bleachers
  firepit common hot_tub barefoot hammock practice_pitch schoolyard
  information artwork attraction apartment camp_pitch checkpoint photopoint
  tours lean_to`.split(/\s+/)
);

async function text(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

async function names(): Promise<Record<string, string>> {
  const rows = (await text(NAMES_URL)).split(/\r?\n/).slice(1);
  const women = new Map<string, Set<string>>();
  const men = new Map<string, Set<string>>();
  for (const row of rows) {
    const cols = row.split(',');
    const country = cols[0];
    const gender = cols[9];
    const name = cols[11]?.trim();
    // A name is one word; anything else is a quoted field this split broke.
    if (!country || !name || !/^[\p{L}'-]+$/u.test(name)) continue;
    if (gender !== 'F' && gender !== 'M') continue;
    const byCountry = gender === 'F' ? women : men;
    const set = byCountry.get(country) ?? new Set();
    set.add(name);
    byCountry.set(country, set);
  }
  // "women;men", and only countries that have both.
  const w = joined(women);
  const m = joined(men);
  return Object.fromEntries(
    Object.keys(w)
      .filter((country) => m[country])
      .map((country) => [country, `${w[country]};${m[country]}`])
  );
}

async function towns(): Promise<Record<string, string>> {
  const dir = mkdtempSync(path.join(tmpdir(), 'geonames-'));
  const zip = path.join(dir, 'cities15000.zip');
  const res = await fetch(TOWNS_URL);
  if (!res.ok) throw new Error(`${TOWNS_URL}: ${res.status}`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('unzip', ['-oq', zip, '-d', dir]);
  const rows = readFileSync(path.join(dir, 'cities15000.txt'), 'utf8')
    .split('\n')
    .map((line) => line.split('\t'))
    // PPLX is a suburb or district of another town on the list.
    .filter((c) => c[6] === 'P' && c[7] !== 'PPLX' && c[8])
    .sort((a, b) => Number(b[14]) - Number(a[14]));
  const byCountry = new Map<string, Set<string>>();
  for (const c of rows) {
    const country = c[8] ?? '';
    const set = byCountry.get(country) ?? new Set();
    if (set.size < TOWNS_PER_COUNTRY && c[1]) set.add(c[1]);
    byCountry.set(country, set);
  }
  return joined(byCountry);
}

async function venues(): Promise<string> {
  const out = new Set<string>();
  for (const key of VENUE_KEYS) {
    const body: unknown = JSON.parse(await text(taginfoUrl(key)));
    const data =
      body && typeof body === 'object' && 'data' in body ? body.data : [];
    if (!Array.isArray(data)) throw new Error(`taginfo ${key}: no data`);
    for (const row of data) {
      if (!row?.in_wiki || NOT_A_VENUE.has(row.value)) continue;
      const label = String(row.value).replaceAll('_', ' ');
      out.add(key === 'shop' ? `${label} (shop)` : label);
    }
  }
  return [...out].join('|');
}

async function jobs(): Promise<string> {
  // One title per occupation code: the first one O*NET shows the public.
  const byCode = new Map<string, string>();
  for (const row of (await text(JOBS_URL)).split(/\r?\n/).slice(1)) {
    const [code, title, shown] = row.split('\t');
    if (!code || !title || shown !== 'Y' || byCode.has(code)) continue;
    byCode.set(code, title.replace(/\s*\(.*\)$/, ''));
  }
  return [...new Set(byCode.values())].join('|');
}

function joined(map: Map<string, Set<string>>): Record<string, string> {
  return Object.fromEntries(
    [...map]
      .filter(([, set]) => set.size > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([country, set]) => [country, [...set].join('|')])
  );
}

const data = {
  names: await names(),
  towns: await towns(),
  venues: await venues(),
  jobs: await jobs(),
};

const out = path.join(
  import.meta.dirname,
  '../src/sequences/server/enhance-seeds.data.ts'
);
writeFileSync(
  out,
  `// Generated by scripts/build-enhance-seeds.ts (#2076). Do not edit by hand.
// Each list is one string, items separated by "|". A country's names are
// "women;men".
export const ENHANCE_SEED_DATA = ${JSON.stringify(data, null, 2)} as const;
`
);
const count = (s: string) => s.split('|').length;
console.log(
  `names ${Object.keys(data.names).length} countries, towns ${Object.keys(data.towns).length} countries, venues ${count(data.venues)}, jobs ${count(data.jobs)} -> ${out} (${Math.round(Buffer.byteLength(JSON.stringify(data)) / 1024)} KB)`
);
