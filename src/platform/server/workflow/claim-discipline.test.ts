/**
 * Claim discipline: every generation domain lands through a claim (#1130).
 *
 * The contract (docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § The claim contract): a run's result reaches a selection pointer only
 * through a claim the trigger took, a completion that consumes that claim in
 * one guarded UPDATE, and a failure that clears the claim only while it still
 * holds it. Each domain below names the three `scopedDb` methods that do that,
 * plus the unguarded selector a workflow must never call instead.
 *
 * What makes this a wiring test rather than a list: the domains are not typed
 * in by hand. Every schema table that a workflow writes results into (it has a
 * `…WorkflowRunId` column) or that holds generated history (`*_variants`,
 * `*_versions`) must be owned by a claim domain or sit on `EXCEPTIONS` with a
 * reason. Add a generated table without either and this fails; drop one of a
 * domain's claim methods and this fails; call a domain's unguarded selector
 * from a workflow and this fails.
 */

import { globSync, readFileSync } from 'node:fs';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, test, vi } from 'vitest';
import * as schema from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';

/** `domain.method` on `ScopedDb`, so a rename is also a type error. */
type ScopedMethod = {
  [D in keyof ScopedDb]: `${D}.${keyof ScopedDb[D] & string}`;
}[keyof ScopedDb];

type ClaimDomain = {
  /** Tables whose rows this domain generates or whose pointer it moves. */
  tables: readonly string[];
  /** Takes the claim at the trigger (last kickoff wins). */
  claim: ScopedMethod;
  /** Clears the claim on failure ONLY if this run still holds it. */
  clear: ScopedMethod;
  /** Moves the pointer and consumes the claim in one guarded UPDATE. */
  promote: ScopedMethod;
  /** The user's selector: moves the pointer unconditionally. Never from a run. */
  userSelect: ScopedMethod;
};

const CLAIM_DOMAINS: Record<string, ClaimDomain> = {
  // The canonical shape: a pointer claim on the parent row. Previews
  // (`frame_variants.kind = 'preview'`, #1101) share the table but are never
  // selectable, so they never take a claim — enforced at the select doors.
  stills: {
    tables: ['frame_variants', 'frames'],
    claim: 'frames.setPendingPromoteVersionId',
    clear: 'frames.clearPendingPromoteVersionIdIf',
    promote: 'frameVariants.selectIfPendingPromoteIs',
    userSelect: 'frameVariants.select',
  },
  video: {
    tables: ['video_variants', 'render_segments'],
    claim: 'renderSegments.setPendingPromoteVersionId',
    clear: 'renderSegments.clearPendingPromoteVersionIdIf',
    promote: 'videoVariants.selectIfPendingPromoteIs',
    userSelect: 'videoVariants.select',
  },
  // Sheets (#1113): pointer claims on the parent row naming the id the run's
  // result will carry. The row is appended at completion (no pending row),
  // so a claim miss parks it as divergent in the same batch.
  'character sheets': {
    tables: ['character_sheet_variants'],
    claim: 'characters.claimSheet',
    clear: 'characters.failSheetClaim',
    promote: 'characterSheetVariants.promoteIfPending',
    userSelect: 'characterSheetVariants.select',
  },
  'location sheets': {
    tables: ['location_sheet_variants'],
    claim: 'sequenceLocations.claimReference',
    clear: 'sequenceLocations.failReferenceClaim',
    promote: 'locationSheetVariants.promoteIfPending',
    userSelect: 'locationSheetVariants.select',
  },
  // The library location keeps its reference on the row; its parked results
  // share `location_sheet_variants` with the sequence locations above.
  'library location references': {
    tables: ['location_library'],
    claim: 'locations.claimReference',
    clear: 'locations.clearReferenceClaimIf',
    promote: 'locations.updateReferenceIfClaimed',
    userSelect: 'locationSheetVariants.promoteAtomically',
  },
  'talent sheets': {
    tables: ['talent_sheets', 'talent_sheet_variants'],
    claim: 'talent.claimSheet',
    clear: 'talent.clearSheetClaimIf',
    promote: 'talent.landSheet',
    userSelect: 'talentSheetVariants.promoteAtomically',
  },
  // Pointer claim, taken together with the generating husk (#1715).
  voices: {
    tables: ['character_voice_versions'],
    claim: 'characters.createPendingVoiceClaim',
    clear: 'characters.markVoiceClaimTerminal',
    promote: 'characters.promoteVoiceClaimIfPending',
    userSelect: 'characters.selectVoiceVersion',
  },
  // Prompts dialect: the claim is the pending row itself (live status +
  // `pendingInputHash`), not a pointer column. Same five rules (#1085/#1095).
  'image prompts': {
    tables: ['frame_prompt_versions'],
    claim: 'framePromptVersions.createPending',
    clear: 'framePromptVersions.markTerminal',
    promote: 'framePromptVersions.completePendingAiVersion',
    userSelect: 'framePromptVersions.select',
  },
  'motion prompts': {
    tables: ['shot_prompt_versions'],
    claim: 'shotPromptVersions.createPending',
    clear: 'shotPromptVersions.markTerminal',
    promote: 'shotPromptVersions.completePendingAiVersion',
    userSelect: 'shotPromptVersions.select',
  },
  // Claims-table dialect (#1657): a recording's section rows cannot be their
  // own placeholder, so the claim is a `shot_dialogue_claims` row.
  dialogue: {
    tables: [
      'shot_dialogue_claims',
      'dialogue_recordings',
      'shot_dialogue_sections',
    ],
    claim: 'shotDialogue.claimRecording',
    clear: 'shotDialogue.failClaims',
    promote: 'shotDialogue.appendRecording',
    userSelect: 'shotDialogue.selectSection',
  },
};

/**
 * Generated tables that are NOT on the claim flow, and why. Shrinking this is
 * the goal; growing it is a reviewed act.
 */
const EXCEPTIONS: Record<string, string> = {
  // Music parks a divergent variant and promotes by copying onto
  // `sequences.music*` — the pre-claim shape sheets had before #1113.
  // The music prompt run appends and mirrors onto `sequences.musicPrompt`
  // with no claim. Both music tables move together.
  sequence_music_variants: 'music: divergent-variant model, not yet claimed',
  sequence_music_prompt_versions: 'music: appended and mirrored, no claim',
  // `sequences.workflowRunId` is the pipeline's run slot
  // (`sequences.claimWorkflowSlot`), not a selection.
  sequences: 'run slot, not a selection pointer',
  // Every studio run is its own asset; nothing selects between them.
  generated_assets: 'no selection pointer',
  // An export is a file per request; nothing selects between them.
  sequence_exports: 'no selection pointer',
  // A compliance record of a generation, not a generation result.
  content_provenance: 'audit record, not a result',
  // Legacy per-model outputs; no workflow writes it since #990 (video moved to
  // `video_variants`). Read and discard only.
  shot_variants: 'legacy, no workflow writes it',
  // Authored, not generated: split seeds a scene's script and each shot's
  // lines in the run that (re)creates them, and a re-analysis replaces the
  // selection by design — its output IS the new source. User edits append.
  scene_script_versions: 'authored; re-analysis replaces by design',
  shot_dialogue_versions: 'authored; re-analysis replaces by design',
  // Bible history (#1600): authored, not generated. Analysis, a person's
  // edit and a recast each append; nothing is generated into it async.
  character_bible_versions: 'authored; analysis and edits append',
  location_bible_versions: 'authored; analysis and edits append',
};

/**
 * Writers that move a claim domain's pointer with NO claim: `write` /
 * `writeAiVersion` append and select unless `select: false`, and demote live
 * claims like a user edit. Each workflow call site is pinned here with why, so
 * a new unclaimed promote fails the test. Shrinking this is the goal.
 */
const UNCLAIMED_WRITERS: readonly ScopedMethod[] = [
  'framePromptVersions.write',
  'framePromptVersions.writeAiVersion',
  'shotPromptVersions.write',
  'shotPromptVersions.writeAiVersion',
  'characters.updateVoice',
  'characters.updateSheet',
  'sequenceLocations.updateReference',
  'locations.updateReference',
];
const UNCLAIMED_CALL_SITES: Record<string, string> = {
  // The pipeline's prompt passes take no claim: their output is selected,
  // superseding a user override (which stays in history).
  'src/sequences/server/workflows/analyze-script-workflow.ts: framePromptVersions.writeAiVersion':
    'pipeline: derived prompts selected, no claim',
  'src/stills/server/workflows/frame-prompt-workflow.ts: framePromptVersions.writeAiVersion':
    'run with no targetVersionId (pipeline) selects, no claim',
  'src/motion/server/workflows/motion-prompt-workflow.ts: shotPromptVersions.writeAiVersion':
    'run with no targetVersionId (pipeline) selects, no claim',
  'src/motion/server/workflows/motion-prompt-batch-workflow.ts: shotPromptVersions.writeAiVersion':
    'pipeline batch selects, no claim',
  // A run queued before #1786 carries the user's typed edit (drain path);
  // the other write in motion-workflow passes `select: false`.
  'src/stills/server/workflows/image-workflow.ts: framePromptVersions.write':
    'pre-#1786 payload: the user edit, written at run time',
  'src/motion/server/workflows/motion-workflow.ts: shotPromptVersions.write':
    'pre-#1786 user edit; the rescue write is select: false',
  'src/stills/server/workflows/soften-image-prompt.ts: framePromptVersions.write':
    'select: false, lands unselected (#1786)',
  // A sheet payload queued before #1113 carries no claim (drain path). The
  // library talent twin is `talent.sheets.create`, nested past this scan.
  'src/cast/server/workflows/character-sheet-workflow.ts: characters.updateSheet':
    'pre-#1113 payload, no claim',
  'src/cast/server/workflows/location-sheet-workflow.ts: sequenceLocations.updateReference':
    'pre-#1113 payload, no claim',
  'src/cast/server/workflows/library-location-sheet-workflow.ts: locations.updateReference':
    'pre-#1113 payload, no claim',
  // A pre-#1715 payload has no husk to claim (drain path).
  'src/cast/server/workflows/character-voice-workflow.ts: characters.updateVoice':
    'pre-#1715 payload, no husk',
};

/** Every table a workflow writes results into or that holds generated history. */
function generatedTables(): string[] {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const name = getTableName(value);
    const runColumn = Object.keys(getTableColumns(value)).some((key) =>
      /workflowRunId$/i.test(key)
    );
    if (runColumn || /_(variants|versions)$/.test(name)) names.add(name);
  }
  return [...names].sort();
}

const WORKFLOW_SOURCES = [
  ...globSync('src/**/server/workflows/*.ts').filter(
    (f) => !f.endsWith('.test.ts')
  ),
  // A workflow-step helper, not a workflow (#1651, #1657).
  'src/motion/server/record-dialogue.ts',
].sort();

describe('claim discipline (#1130)', () => {
  test('every generated table is owned by a claim domain or excepted', () => {
    const owned = Object.values(CLAIM_DOMAINS).flatMap((d) => d.tables);
    const covered = new Set([...owned, ...Object.keys(EXCEPTIONS)]);
    const uncovered = generatedTables().filter((t) => !covered.has(t));
    expect(
      uncovered,
      'A generated table has no claim surface. Give it claim/clear/promote ' +
        'and add it to CLAIM_DOMAINS, or add it to EXCEPTIONS with a reason.'
    ).toEqual([]);
  });

  test('no table is both claimed and excepted, and no entry is stale', () => {
    const generated = new Set(generatedTables());
    const owned = Object.values(CLAIM_DOMAINS).flatMap((d) => d.tables);
    expect(owned.filter((t) => t in EXCEPTIONS)).toEqual([]);
    // A domain may own a pointer table the scan does not see (render_segments
    // has no run column); an exception must name a table the scan does see.
    expect(Object.keys(EXCEPTIONS).filter((t) => !generated.has(t))).toEqual(
      []
    );
  });

  test('every claim domain exposes claim, clear and promote', async () => {
    vi.doMock('#db-client', () => ({ getDb: () => ({}) }));
    const { createScopedDb } = await import('@/platform/server/db/scoped');
    const scopedDb = createScopedDb('team', 'user');

    const missing: string[] = [];
    for (const [name, domain] of Object.entries(CLAIM_DOMAINS)) {
      for (const role of ['claim', 'clear', 'promote', 'userSelect'] as const) {
        const [module = '', method = ''] = domain[role].split('.');
        const methods: unknown = Reflect.get(scopedDb, module);
        const fn: unknown =
          typeof methods === 'object' && methods !== null
            ? Reflect.get(methods, method)
            : undefined;
        if (typeof fn !== 'function') {
          missing.push(`${name}.${role}: ${domain[role]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('no workflow promotes through a user selector', () => {
    const offenders: string[] = [];
    for (const path of WORKFLOW_SOURCES) {
      const source = readFileSync(path, 'utf8');
      for (const domain of Object.values(CLAIM_DOMAINS)) {
        if (source.includes(`.${domain.userSelect}(`)) {
          offenders.push(`${path}: ${domain.userSelect}`);
        }
      }
    }
    expect(
      offenders,
      'A run moved a selection pointer without consuming its claim. Use the ' +
        "domain's promote method; a claim miss lands in history."
    ).toEqual([]);
  });

  test('every unclaimed pointer write from a workflow is pinned', () => {
    const found: string[] = [];
    for (const path of WORKFLOW_SOURCES) {
      const source = readFileSync(path, 'utf8');
      for (const method of UNCLAIMED_WRITERS) {
        if (source.includes(`.${method}(`)) found.push(`${path}: ${method}`);
      }
    }
    expect(
      found.sort(),
      'A run moves a selection pointer with no claim. Take a claim, pass ' +
        '`select: false`, or pin the call site in UNCLAIMED_CALL_SITES.'
    ).toEqual(Object.keys(UNCLAIMED_CALL_SITES).sort());
  });
});
