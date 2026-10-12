/**
 * Reorder a `wrangler d1 export --no-schema` dump parent-first (#897 cutover).
 *
 * D1's import path ingests large SQL files in multiple internal transactions,
 * and the dump's single leading `PRAGMA defer_foreign_keys=TRUE` does not
 * span them — so the export's alphabetical table order (`account` before
 * `user`, …) fails at a chunk commit with "FOREIGN KEY constraint failed"
 * and rolls the whole import back. Topologically ordering the per-table
 * INSERT blocks (parents before children) needs no deferral at all, so it
 * survives any chunking. Verified: a reordered dump replays cleanly into the
 * migrations-built schema with IMMEDIATE foreign_keys=ON enforcement.
 *
 * Usage:
 *   bun scripts/reorder-d1-dump.ts <input.sql> <output.sql>
 *
 * The FK edge list below is a snapshot of the REFERENCES clauses in a
 * production schema export as of #2017 (2026-10-09; `wrangler d1 export
 * --no-data`, one edge per REFERENCES). One-time cutover tooling, not kept in CI sync — the script
 * fails loudly on any dump table it doesn't know about — regenerate the list
 * from a migrated DB if that happens:
 *   SELECT m.name, f."table" FROM sqlite_master m,
 *     pragma_foreign_key_list(m.name) f WHERE m.type='table';
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , source, target] = process.argv;
if (!source || !target) {
  throw new Error(
    'Usage: bun scripts/reorder-d1-dump.ts <input.sql> <output.sql>'
  );
}

// child -> parent
const EDGES: Array<[string, string]> = [
  ['account', 'user'],
  ['audio', 'teams'],
  ['audio', 'user'],
  ['character_bible_versions', 'characters'],
  ['character_bible_versions', 'talent'],
  ['character_bible_versions', 'user'],
  ['character_look_versions', 'character_looks'],
  ['character_look_versions', 'user'],
  ['character_looks', 'characters'],
  ['character_sheet_variants', 'characters'],
  ['character_voice_versions', 'characters'],
  ['character_voice_versions', 'user'],
  ['characters', 'teams'],
  ['content_provenance', 'teams'],
  ['content_provenance', 'user'],
  ['content_reports', 'teams'],
  ['content_reports', 'user'],
  ['credit_batches', 'teams'],
  ['credit_batches', 'transactions'],
  ['credit_reservations', 'teams'],
  ['credit_reservations', 'user'],
  ['credits', 'teams'],
  ['dialogue_speeches', 'sequences'],
  ['enforcement_actions', 'content_reports'],
  ['enforcement_actions', 'teams'],
  ['enforcement_actions', 'user'],
  ['frame_prompt_versions', 'frames'],
  ['frame_prompt_versions', 'user'],
  ['frame_variants', 'frames'],
  ['frame_variants', 'sequences'],
  ['frames', 'sequences'],
  ['frames', 'shots'],
  ['generated_assets', 'teams'],
  ['generated_assets', 'user'],
  ['gift_token_redemptions', 'gift_tokens'],
  ['gift_token_redemptions', 'teams'],
  ['gift_token_redemptions', 'user'],
  ['gift_tokens', 'user'],
  ['location_bible_versions', 'sequence_locations'],
  ['location_bible_versions', 'user'],
  ['location_library', 'teams'],
  ['location_library', 'user'],
  ['location_sheets', 'location_library'],
  ['oauth_access_token', 'oauth_client'],
  ['oauth_access_token', 'oauth_refresh_token'],
  ['oauth_client_resource', 'oauth_client'],
  ['oauth_client_resource', 'oauth_resource'],
  ['oauth_consent', 'oauth_client'],
  ['oauth_refresh_token', 'oauth_client'],
  ['passkey', 'user'],
  ['render_segments', 'scenes'],
  ['render_segments', 'sequences'],
  ['scene_script_versions', 'scenes'],
  ['scene_script_versions', 'user'],
  ['scenes', 'sequences'],
  ['sequence_cast_looks', 'character_looks'],
  ['sequence_cast_looks', 'sequence_cast'],
  ['sequence_cast', 'characters'],
  ['sequence_cast', 'sequences'],
  ['sequence_elements', 'sequences'],
  ['sequence_events', 'sequences'],
  ['sequence_events', 'user'],
  ['sequence_exports', 'sequences'],
  ['sequence_locations', 'location_library'],
  ['sequence_locations', 'sequences'],
  ['sequence_music_prompt_versions', 'sequences'],
  ['sequence_music_prompt_versions', 'user'],
  ['sequence_music_variants', 'sequences'],
  ['sequence_style_versions', 'sequences'],
  ['sequence_style_versions', 'user'],
  ['sequences', 'styles'],
  ['sequences', 'teams'],
  ['sequences', 'user'],
  ['session', 'user'],
  ['shot_dialogue_claims', 'shots'],
  ['shot_dialogue_sections', 'shots'],
  ['shot_dialogue_versions', 'shots'],
  ['shot_dialogue_versions', 'user'],
  ['shot_prompt_versions', 'shots'],
  ['shot_prompt_versions', 'user'],
  ['shot_spec_versions', 'shots'],
  ['shot_spec_versions', 'user'],
  ['shot_variants', 'sequences'],
  ['shot_variants', 'shots'],
  ['shots', 'render_segments'],
  ['shots', 'scenes'],
  ['shots', 'sequences'],
  ['styles', 'teams'],
  ['styles', 'user'],
  ['talent_media', 'talent'],
  ['talent_sheet_variants', 'talent_sheets'],
  ['talent_sheets', 'talent'],
  ['talent', 'teams'],
  ['talent', 'user'],
  ['team_api_keys', 'teams'],
  ['team_api_keys', 'user'],
  ['team_billing_settings', 'teams'],
  ['team_invitations', 'teams'],
  ['team_invitations', 'user'],
  ['team_members', 'teams'],
  ['team_members', 'user'],
  ['transactions', 'teams'],
  ['transactions', 'user'],
  ['upload_attestations', 'teams'],
  ['upload_attestations', 'user'],
  ['vfx', 'teams'],
  ['vfx', 'user'],
  ['video_variants', 'render_segments'],
  ['video_variants', 'sequences'],
  ['welcome_card_claims', 'teams'],
];

// Tables that genuinely carry no FK constraints in the schema snapshot.
// `location_sheet_variants` is polymorphic (`parent_type` + `parent_id`, no FK),
// so it carries no insert-ordering constraint.
const KNOWN_FK_FREE = new Set([
  'apikey',
  'app_metadata',
  'd1_migrations',
  'location_sheet_variants',
  'user',
  'teams',
  'verification',
  'model_pricing',
  'model_pricing_history',
  'model_usage_observations',
  'device_code',
  'jwks',
  'byteplus_assets',
  'sqlite_sequence',
]);

const knownTables = new Set<string>(KNOWN_FK_FREE);
for (const [child, parent] of EDGES) {
  knownTables.add(child);
  knownTables.add(parent);
}

const lines = readFileSync(source, 'utf8').split('\n');

const header: string[] = [];
const buckets = new Map<string, string[]>();
let current: string[] = header;

const insertRe = /^INSERT INTO "(\w+)"/;
for (const line of lines) {
  const match = insertRe.exec(line);
  if (match?.[1]) {
    const table = match[1];
    let bucket = buckets.get(table);
    if (!bucket) {
      bucket = [];
      buckets.set(table, bucket);
    }
    current = bucket;
  }
  current.push(line);
}

const tables = [...buckets.keys()];
const unknown = tables.filter((t) => !knownTables.has(t));
if (unknown.length > 0) {
  throw new Error(
    `[reorder-d1-dump] dump contains tables missing from the FK edge list: ${unknown.join(', ')} — regenerate EDGES (see header) before trusting the output`
  );
}

// Kahn's algorithm: parents before children.
const tableSet = new Set(tables);
const dependsOn = new Map<string, Set<string>>();
for (const t of tables) dependsOn.set(t, new Set());
for (const [child, parent] of EDGES) {
  if (tableSet.has(child) && tableSet.has(parent) && child !== parent) {
    dependsOn.get(child)?.add(parent);
  }
}

const ordered: string[] = [];
const placed = new Set<string>();
while (ordered.length < tables.length) {
  const ready = tables
    .filter((t) => !placed.has(t))
    .filter((t) =>
      [...(dependsOn.get(t) ?? [])].every((parent) => placed.has(parent))
    )
    .sort();
  if (ready.length === 0) {
    throw new Error(
      `[reorder-d1-dump] FK cycle among: ${tables.filter((t) => !placed.has(t)).join(', ')}`
    );
  }
  for (const t of ready) {
    ordered.push(t);
    placed.add(t);
  }
}

const out: string[] = header.filter((l) => l.trim() !== '');
for (const table of ordered) {
  const bucket = buckets.get(table);
  if (bucket) out.push(...bucket);
}

writeFileSync(target, out.join('\n') + '\n');
console.log(`[reorder-d1-dump] ${tables.length} tables → ${target}`);
console.log(`[reorder-d1-dump] order: ${ordered.join(', ')}`);
