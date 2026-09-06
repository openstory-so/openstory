/**
 * Regenerates the Storybook fixture for `ScenesView` from real local D1 rows.
 *
 * Pulls one fully-generated sequence (its sequence row + style + scenes + shots)
 * out of the local **dev** D1 via the CF Explorer API, maps snake_case → camelCase,
 * parses the JSON/date columns, swaps stored `/r2/…` media URLs for public
 * placeholders (the stored paths are origin-relative and don't resolve from the
 * Storybook origin), and writes a typed fixture module.
 *
 * Prereq: `bun dev` running (serves the Explorer API on :3000).
 * Usage:  bun scripts/generate-scenes-view-fixture.ts [sequenceId]
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:3000/cdn-cgi/explorer/api';
const DB = 'dev-local-d1';
// Default: the 9:16 "MAKEUP AD" sequence. Override via argv.
const SEQ = process.argv[2] ?? '01KT2TPG5WYQ15H79SAV88EH45';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'src/components/scenes/scenes-view.fixture.ts');

// Portrait placeholders (default sequence is 9:16). Cycled across shots/scenes.
const VIDEOS = [
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
  'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
  'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4',
];

type Row = Record<string, unknown>;

async function q(sql: string): Promise<Row[]> {
  const res = await fetch(`${BASE}/d1/database/${DB}/raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Explorer API returns untyped JSON
  const json = (await res.json()) as {
    result?: { results?: { columns: string[]; rows: unknown[][] } }[];
  };
  const r = json.result?.[0]?.results;
  if (!r) throw new Error(`no results: ${JSON.stringify(json).slice(0, 300)}`);
  return r.rows.map((row) =>
    Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))
  );
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// SQLite stores these as 0/1; the typed shapes want real booleans.
const BOOL_COLS = new Set([
  'auto_generate_motion',
  'auto_generate_music',
  'include_music',
  'is_public',
  'is_template',
]);

// Sentinels we string-replace into real expressions after JSON.stringify.
const dateMark = (iso: string) => ({ __date__: iso });
const brandMark = (id: unknown) => ({ __sceneId__: id });

function mapValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (BOOL_COLS.has(key)) return value === 1 || value === true;
  if (key.endsWith('_at')) {
    // Date columns are stored as unix SECONDS.
    return typeof value === 'number'
      ? dateMark(new Date(value * 1000).toISOString())
      : value;
  }
  if (typeof value === 'string' && /^[[{]/.test(value.trim())) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function mapRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[camel(k)] = mapValue(k, v);
  return out;
}

function swapShotMedia(shot: Row, i: number): Row {
  const seed = String(shot.id);
  if (shot.thumbnailUrl)
    shot.thumbnailUrl = `https://picsum.photos/seed/${seed}/720/1280`;
  if (shot.previewThumbnailUrl)
    shot.previewThumbnailUrl = `https://picsum.photos/seed/${seed}-p/720/1280`;
  if (shot.variantImageUrl)
    shot.variantImageUrl = `https://picsum.photos/seed/${seed}-v/720/1280`;
  if (shot.videoUrl) shot.videoUrl = VIDEOS[i % VIDEOS.length];
  return shot;
}

function requireRow(rows: Row[], what: string): Row {
  const row = rows[0];
  if (!row) throw new Error(`no ${what} found for sequence ${SEQ}`);
  return row;
}

const seqRow = requireRow(
  await q(`SELECT * FROM sequences WHERE id='${SEQ}'`),
  'sequence'
);
const styleRow = requireRow(
  await q(
    `SELECT * FROM styles WHERE id=(SELECT style_id FROM sequences WHERE id='${SEQ}')`
  ),
  'style'
);
// A scene's script is its SELECTED `scene_script_versions` row — the scene
// table holds no copy (#1067), so the fixture joins it in as `script`.
const sceneRows = await q(
  `SELECT s.*, v.content AS script FROM scenes s
   LEFT JOIN scene_script_versions v ON v.id = s.selected_script_version_id
   WHERE s.sequence_id='${SEQ}' ORDER BY s.order_index`
);
const shotRows = await q(
  `SELECT * FROM shots WHERE sequence_id='${SEQ}' ORDER BY order_index`
);

const sequence = mapRow(seqRow);
if (sequence.posterUrl) sequence.posterUrl = null;
if (sequence.musicUrl) sequence.musicUrl = null;

const style = mapRow(styleRow);
if (style.previewUrl) style.previewUrl = null;

const scenes = sceneRows.map(mapRow);
// SceneRow.id carries the DbSceneId brand — emit via the brand constructor.
for (const s of scenes) s.id = brandMark(s.id);
const shots = shotRows.map(mapRow).map(swapShotMedia);

// Serialize, then turn sentinels into real expressions.
function emit(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(
      /\{\s*"__date__":\s*("[^"]+")\s*\}/g,
      (_, iso) => `new Date(${iso})`
    )
    .replace(
      /\{\s*"__sceneId__":\s*("[^"]+")\s*\}/g,
      (_, id) => `dbSceneId(${id})`
    );
}

const file = `// AUTO-GENERATED Storybook fixture — real rows from local D1 (sequence ${SEQ}),
// media URLs swapped for public placeholders. Do NOT hand-edit.
// Regenerate via: bun scripts/generate-scenes-view-fixture.ts
import type { SceneWithScript } from '@/hooks/use-scenes';
import { dbSceneId } from '@/shared/scene-id';
import type { Shot } from '@/lib/db/schema';
import type { Sequence, Style } from '@/lib/db/schema';

export const fixtureSequence: Sequence = ${emit(sequence)};

export const fixtureStyle: Style = ${emit(style)};

export const fixtureScenes: SceneWithScript[] = ${emit(scenes)};

export const fixtureShots: Shot[] = ${emit(shots)};
`;

writeFileSync(OUT, file);
process.stdout.write(
  `wrote ${OUT}\n  sequence: ${String(sequence.title)}\n  scenes: ${scenes.length}\n  shots: ${shots.length}\n`
);
