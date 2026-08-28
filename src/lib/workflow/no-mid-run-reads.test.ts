/**
 * Source scan: no unsanctioned mid-run DB reads inside Cloudflare Workflows.
 *
 * The rule (docs/architecture/workflow-snapshots-and-content-hash-staleness.md):
 * a content-generation workflow must not read mutable DB state for anything
 * that should be frozen at trigger time. A workflow runs minutes-to-hours after
 * the click that started it, replays its steps from a durable cache, and races
 * its own children — so a live re-read of a selection pointer, a prompt row, or
 * a bible can hand a step a value the user never asked for, and can hand two
 * steps of the SAME run two different values.
 *
 * `WorkflowScopedDb` (src/lib/db/scoped.ts) removes read methods from the
 * `scopedDb` handed to `runImpl`, so an accidental read is a type error. This
 * test is the second half: it pins the *sanctioned* reads — the ones that
 * deliberately go through `scopedDb.liveRead` — to an explicit list, so
 * widening the escape hatch is a reviewed act rather than a silent one.
 *
 * Every surviving read is filed under a named bucket (`ReadBucket` below).
 * The bucket is the argument for why the value could not be frozen; a read
 * that fits none of them is a bug, and the type makes "no bucket" unwritable.
 *
 * Failing this test means one of two things: you added a read that should have
 * been snapshotted into the workflow payload at the trigger, or you removed one
 * and the allow-list entry below is now stale. Both need editing here.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';

const WORKFLOWS_DIR = 'src/lib/workflows';

/**
 * Method-name prefixes that denote a read. Writes (`create`, `update`,
 * `append`, `select`, `claim`, `delete`, `set`, `write`, `record`, …) are
 * unrestricted — a workflow's job is to write.
 */
const READ_METHOD = /^(get|list|find|latest|current|resolve|by|has)/;

/**
 * `scopedDb.<domain>.<method>(`, and the same through any of the three named
 * hatches: `scopedDb.liveRead.…`, `scopedDb.claims.…`, `scopedDb.credentials.…`.
 * All normalise to `domain.method` so the allow-list records WHICH reads exist,
 * not how they're spelled — but the hatch is captured too, because the test
 * below asserts it matches the entry's bucket. Matches any receiver ending in
 * `scopedDb` (`params.scopedDb`, `callContext.scopedDb`, …).
 *
 * `credentials` is flat (`scopedDb.credentials.resolveKey(`), so its "domain"
 * group is the method and the method group is absent — handled in `scanFile`.
 */
const SCOPED_READ =
  /\bscopedDb\s*\.\s*(?:(liveRead|claims|credentials)\s*\.\s*)?([A-Za-z0-9_]+)\s*(?:\.\s*([A-Za-z0-9_]+)\s*)?\(/g;

/** Which hatch a call site came through, or `null` for a bare `scopedDb.x.y(`. */
type Hatch = 'liveRead' | 'claims' | 'credentials';

const HATCHES: readonly Hatch[] = ['liveRead', 'claims', 'credentials'];

function isHatch(s: string): s is Hatch {
  return (HATCHES as readonly string[]).includes(s);
}

/** Local credential-resolution indirection in llm-call-helper. */
const RESOLVE_CALL_KEY = /\bresolveCallKey\s*\(/;

/**
 * Drop comment lines before scanning. Prose that *documents* a read (JSDoc
 * showing `scopedDb.apiKeys.resolveKey('fal')`, a comment explaining why a
 * read was removed) must not register as a call site. Only whole comment lines
 * are dropped — never a trailing `//` — so a real call can't hide behind one.
 */
function stripCommentLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
        ? ''
        : line;
    })
    .join('\n');
}

type ScannedRead = { read: string; hatch: Hatch | null };

function scanFileDetailed(file: string): ScannedRead[] {
  const text = stripCommentLines(
    readFileSync(`${WORKFLOWS_DIR}/${file}`, 'utf8')
  );
  const hits = new Map<string, Hatch | null>();
  for (const match of text.matchAll(SCOPED_READ)) {
    const [, rawHatch, first, second] = match;
    const hatch = rawHatch !== undefined && isHatch(rawHatch) ? rawHatch : null;
    // Flat hatch: `scopedDb.credentials.resolveKey(` has no second segment.
    const read = second ? `${first}.${second}` : (first ?? '');
    const leaf = second ?? first ?? '';
    if (read && READ_METHOD.test(leaf)) hits.set(read, hatch);
  }
  // The local credential indirection in llm-call-helper; it wraps a
  // `scopedDb.credentials` call, so it files under the same hatch.
  if (RESOLVE_CALL_KEY.test(text)) hits.set('resolveCallKey', 'credentials');
  return [...hits]
    .map(([read, hatch]) => ({ read, hatch }))
    .sort((a, b) => a.read.localeCompare(b.read));
}

function scanFile(file: string): string[] {
  return scanFileDetailed(file).map((hit) => hit.read);
}

function workflowSourceFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();
}

/**
 * Why a read could not be snapshotted. Every allow-list entry names one — the
 * type makes an unclassified read unwritable, which is the point: "it was
 * already there" is not a justification.
 *
 * All eight are settled justifications. The two escape buckets the sweep
 * surfaced (STANDING-SELECTION, LEGACY-PAYLOAD-FALLBACK) are gone — every read
 * that wore them is now pinned at the trigger or defaulted statically. The
 * provisional machinery below is kept empty for the next one.
 */
type ReadBucket =
  /** The run's designed observation moment — the plan step that decides what to regenerate. */
  | 'TRIGGER-SNAPSHOT'
  /** Recompute an input hash from CURRENT state to compare against the frozen one. */
  | 'DIVERGENCE-CHECK'
  /** Poll for a SIBLING workflow's late write. A snapshot would defeat the wait. */
  | 'WAIT-GATE'
  /** Read the run's OWN write back by explicit ULID. Never a selection pointer. */
  | 'CLAIM-BY-ID'
  /** Confirm the row still exists; deleted-mid-run is a stand-down. */
  | 'EXISTENCE-GUARD'
  /** Spawn-time double-render check where no claim row exists to hold the slot. */
  | 'BILLING-GUARD'
  /** Resolve a key inside the step that spends it (a replayed step gets a fresh isolate). */
  | 'CREDENTIAL'
  /** The team's balance at charge time — the whole point is that it moved. */
  | 'BALANCE';

/**
 * Which hatch spellings a bucket may be reached through. This correspondence
 * is the point of the three-way split: a claim read taken via `liveRead` is a
 * claim read a reviewer cannot distinguish from a pointer read at the call
 * site, and a credential taken via `liveRead` is key access wearing a
 * data-read's clothes. Those two stay single-valued and strict.
 *
 * `null` means "no hatch at this call site", which is legitimate in two cases:
 *   - a SERVER-FN snapshot builder that happens to live in this directory
 *     (recast-snapshot.ts), spelled plainly against a full `ScopedDb`; and
 *   - a helper module that declares a narrowed dependency type
 *     (`SheetSnapshotReadDb`, `WaitForSheetsReadDb`) and is HANDED
 *     `scopedDb.liveRead` by its workflow caller — the hatch is applied at the
 *     caller, and the narrowed type is what keeps the helper honest inside.
 */
const BUCKET_HATCH: Record<ReadBucket, readonly (Hatch | null)[]> = {
  // The run's designed observation moment: either the server-fn builder, or
  // the single load-refs step at the top of an update-stale run.
  'TRIGGER-SNAPSHOT': [null, 'liveRead'],
  // sheet-snapshots' *Current helpers take SheetSnapshotReadDb.
  'DIVERGENCE-CHECK': ['liveRead', null],
  // wait-for-sheets takes WaitForSheetsReadDb.
  'WAIT-GATE': ['liveRead', null],
  // Strict: the whole reason `claims` exists is that it cannot name a pointer.
  'CLAIM-BY-ID': ['claims'],
  'EXISTENCE-GUARD': ['liveRead'],
  'BILLING-GUARD': ['liveRead'],
  // Strict: a key is not a row, and the spelling has to say so.
  CREDENTIAL: ['credentials'],
  BALANCE: ['liveRead'],
};

type SanctionedRead = {
  /** `domain.method`, as the scanner normalises it. */
  read: string;
  bucket: ReadBucket;
  /** Why this specific call cannot be a trigger-time snapshot. */
  why: string;
};

/**
 * Exact allow-list — file → sanctioned reads. No wildcards: a file with no
 * entry may not read at all.
 */
const ALLOWED_LIVE_READS: Record<string, SanctionedRead[]> = {
  'analyze-script-workflow.ts': [
    {
      read: 'sequenceElements.listByIds',
      bucket: 'WAIT-GATE',
      why: "/element-vision writes description + visionStatus late, so the row must be live — but only for the trigger's elementIds, never a re-enumeration.",
    },
  ],
  'asset-generation-workflow.ts': [
    {
      read: 'resolveKey',
      bucket: 'CREDENTIAL',
      why: 'Re-resolved inside each step that talks to fal, because a replayed step may run in a fresh isolate with an unconfigured singleton.',
    },
  ],
  'element-sheet-workflow.ts': [
    {
      read: 'sequenceElements.getById',
      bucket: 'EXISTENCE-GUARD',
      why: 'Idempotency: a replayed run must not violate the (sequenceId, token) unique index.',
    },
    {
      read: 'sequenceElements.getByToken',
      bucket: 'EXISTENCE-GUARD',
      why: 'The uniqueness half of the same guard — catches a concurrent upload of the same token under a different id.',
    },
  ],
  'element-vision-workflow.ts': [
    {
      read: 'resolveLlmKey',
      bucket: 'CREDENTIAL',
      why: 'Resolved inside the step that spends it.',
    },
  ],
  'frame-prompt-workflow.ts': [
    {
      read: 'resolveLlmKey',
      bucket: 'CREDENTIAL',
      why: 'Resolved inside the step that spends it.',
    },
  ],
  'image-workflow.ts': [
    {
      read: 'frameVariants.getById',
      bucket: 'CLAIM-BY-ID',
      why: 'The pending-promote claim, read back to confirm THIS run owns it before clearing it on failure.',
    },
    {
      read: 'frames.getById',
      bucket: 'EXISTENCE-GUARD',
      why: "The trigger's frame, confirmed to still exist and settled when a render is cancelled mid-flight.",
    },
  ],
  'soften-image-prompt.ts': [
    {
      read: 'framePromptVersions.getByIdForFrame',
      bucket: 'CLAIM-BY-ID',
      why: 'The prompt version this run rendered from, named by the trigger snapshot — copied onto the softened row so staleness keeps the same upstream hash.',
    },
  ],
  'llm-call-helper.ts': [
    {
      read: 'resolveLlmKey',
      bucket: 'CREDENTIAL',
      why: 'Resolved inside the durable step that spends it.',
    },
    {
      read: 'resolveCallKey',
      bucket: 'CREDENTIAL',
      why: 'The local indirection wrapping the above; listed so the scanner cannot be dodged by renaming.',
    },
  ],
  'motion-workflow-persist.ts': [
    {
      read: 'shots.getById',
      bucket: 'EXISTENCE-GUARD',
      why: 'Shot deleted mid-flight: finalize the version, skip the selection repoint.',
    },
    {
      read: 'renderSegments.getById',
      bucket: 'EXISTENCE-GUARD',
      why: 'The segment this render promotes into, confirmed present before touching its pointer.',
    },
    {
      read: 'videoVariants.getById',
      bucket: 'CLAIM-BY-ID',
      why: 'The pending-promote claim, read back to confirm THIS run owns it before clearing it.',
    },
  ],
  'motion-workflow.ts': [
    {
      read: 'resolveKey',
      bucket: 'CREDENTIAL',
      why: 'Resolved inside the charging step; usedOwnKey rides the step result so the gate and the deduction agree on one pinned read.',
    },
    {
      read: 'billing.hasEnoughCredits',
      bucket: 'BALANCE',
      why: 'A key or balance change mid-run must not let a charge land on a balance the gate never checked.',
    },
    {
      read: 'shots.getById',
      bucket: 'EXISTENCE-GUARD',
      why: 'Shot deleted mid-run is a stand-down, not a failure.',
    },
    {
      read: 'shotPromptVersions.getByIdForShot',
      bucket: 'CLAIM-BY-ID',
      why: 'The motion prompt version this clip renders from, named by the trigger snapshot — its hash + model are copied onto the softened row (#1373), as soften-image-prompt does for stills.',
    },
  ],
  'recast-snapshot.ts': [
    {
      read: 'characters.listWithSheets',
      bucket: 'TRIGGER-SNAPSHOT',
      why: 'buildRecastRegenerateSnapshots runs in the recast SERVER FNs, not a workflow — these reads ARE the trigger-time snapshot. The workflow-side export from this module is pure.',
    },
    {
      read: 'sequenceLocations.listWithReferences',
      bucket: 'TRIGGER-SNAPSHOT',
      why: 'Same server-fn snapshot builder.',
    },
    {
      read: 'sequenceElements.list',
      bucket: 'TRIGGER-SNAPSHOT',
      why: 'Same server-fn snapshot builder.',
    },
    {
      read: 'shots.getByIds',
      bucket: 'TRIGGER-SNAPSHOT',
      why: 'Same server-fn snapshot builder.',
    },
    {
      read: 'frames.getAnchorsByShots',
      bucket: 'TRIGGER-SNAPSHOT',
      why: 'Same server-fn snapshot builder.',
    },
    {
      read: 'framePromptVersions.getSelectedByFrameIds',
      bucket: 'TRIGGER-SNAPSHOT',
      why: 'Same server-fn snapshot builder — the pointer is read once, at the click, and frozen into the payload.',
    },
  ],
  'replace-element-workflow.ts': [
    {
      read: 'resolveLlmKey',
      bucket: 'CREDENTIAL',
      why: 'Resolved inside the step that spends it.',
    },
    {
      read: 'sequenceElements.getById',
      bucket: 'EXISTENCE-GUARD',
      why: 'Reads the element being replaced so a vision failure downgrades the status it actually observed rather than a guessed one.',
    },
    {
      read: 'shots.getByIds',
      bucket: 'EXISTENCE-GUARD',
      why: 'Ids only — every field the fan-out needs comes from the trigger-time snapshot.',
    },
  ],
  'regenerate-shots-workflow.ts': [
    {
      read: 'compliance.listEnforcementFor',
      bucket: 'BILLING-GUARD',
      why: 'Spawn-time enforcement: a ban applied after the parent started must stop work that has not started yet.',
    },
  ],
  'scene-split-workflow.ts': [
    {
      read: 'resolveLlmKey',
      bucket: 'CREDENTIAL',
      why: 'Resolved inside the step that spends it.',
    },
    {
      read: 'compliance.listEnforcementFor',
      bucket: 'BILLING-GUARD',
      why: 'Spawn-time enforcement: a ban applied after the parent started must stop work that has not started yet.',
    },
  ],
  'shot-images-workflow.ts': [
    {
      read: 'compliance.listEnforcementFor',
      bucket: 'BILLING-GUARD',
      why: 'Spawn-time enforcement: a ban applied after the parent started must stop work that has not started yet.',
    },
  ],
  'sheet-snapshots.ts': [
    {
      read: 'characters.getById',
      bucket: 'DIVERGENCE-CHECK',
      why: "Resolves the character's current talent assignment for the *Current hash. Freezing it would make divergence unrepresentable.",
    },
    {
      read: 'talent.getWithRelations',
      bucket: 'DIVERGENCE-CHECK',
      why: "The upstream talent sheet's inputHash. NOTE the identity it resolves: sheets come back ordered isDefault DESC, createdAt DESC, and resolveTalentSheetHash takes the first NON-DIVERGED one — so with no explicit default the NEWEST convergent sheet wins (src/lib/db/scoped/talent.ts:265). A new sheet therefore shifts the hash and re-stales downstream character sheets by design.",
    },
    {
      read: 'sequenceLocations.getById',
      bucket: 'DIVERGENCE-CHECK',
      why: "Resolves the sequence location's library parent for the *Current hash.",
    },
    {
      read: 'locations.getById',
      bucket: 'DIVERGENCE-CHECK',
      why: "The library location's current reference hash / name / description, recomputed live so a mid-run rename registers as divergence.",
    },
  ],
  'shot-variant-workflow.ts': [
    {
      read: 'frames.getById',
      bucket: 'EXISTENCE-GUARD',
      why: "The trigger's frame, checked for existence only.",
    },
  ],
  'storyboard-workflow.ts': [
    {
      read: 'sequences.getForUser',
      bucket: 'EXISTENCE-GUARD',
      why: 'Throws if the sequence was deleted (or moved teams) since the trigger; on the failure path, checks whether the child already wrote a more specific error.',
    },
  ],
  // compute-plan now runs at the trigger, so the plan arrives on the payload.
  // The three TRIGGER-SNAPSHOT reads below stayed deliberately: they are the
  // `load-render-refs` step, which is kept OUT of the payload because the
  // combined plan + scene-context + refs would put a user-supplied input
  // (script length) against the same 1 MiB cap as everything else.
  'update-stale-shots-workflow.ts': [
    {
      read: 'characters.listWithSheets',
      bucket: 'TRIGGER-SNAPSHOT',
      why: 'load-render-refs, once at run start: this workflow re-renders stale artifacts against CURRENT sheets, and the plan hashed those same rows moments earlier.',
    },
    {
      read: 'sequenceLocations.listWithReferences',
      bucket: 'TRIGGER-SNAPSHOT',
      why: 'Same load-render-refs step.',
    },
    {
      read: 'sequenceElements.list',
      bucket: 'TRIGGER-SNAPSHOT',
      why: 'Same load-render-refs step.',
    },
    {
      read: 'shots.getById',
      bucket: 'EXISTENCE-GUARD',
      why: 'A shot deleted mid-update aborts its own target, not the run.',
    },
    {
      read: 'frames.getAnchorByShot',
      bucket: 'EXISTENCE-GUARD',
      why: 'Same per-target guard on the anchor frame.',
    },
    {
      read: 'framePromptVersions.getByIdForFrame',
      bucket: 'CLAIM-BY-ID',
      why: "This run's own visual-prompt claim, else the row it retired into on the collision path — named by the child's finalVersionId, never the selection pointer.",
    },
    {
      read: 'shotPromptVersions.getByIdForShot',
      bucket: 'CLAIM-BY-ID',
      why: 'The motion twin of the above.',
    },
    {
      read: 'frameVariants.getById',
      bucket: 'CLAIM-BY-ID',
      why: "This run's own render, read back by claim id to chain the video (and the #929 motion-prompt still) off what it actually produced.",
    },
    {
      read: 'videoVariants.getSelectedByShot',
      bucket: 'BILLING-GUARD',
      why: 'Video has no claim rows, so a concurrent Update all / manual render is only detectable live. Skips quietly rather than double-billing.',
    },
    {
      read: 'videoVariants.listBySegment',
      bucket: 'BILLING-GUARD',
      why: 'Same guard: a segment already rendering is producing the fix.',
    },
    {
      read: 'sequences.getById',
      bucket: 'BILLING-GUARD',
      why: 'The music twin: musicPromptInputHash / musicStatus are the only in-flight signal, since music has no claim rows either.',
    },
  ],
  'upscale-shot-variant-workflow.ts': [
    {
      read: 'frameVariants.getById',
      bucket: 'CLAIM-BY-ID',
      why: "This run's framing version, by the id snapshotted at click (complete that row, do not append another) and, on failure, the pending-promote claim to check this run still owns it before clearing (#1129).",
    },
    {
      read: 'frames.getById',
      bucket: 'EXISTENCE-GUARD',
      why: "The trigger's frame, checked but never re-resolved, so the render step and the promote step write to the same one. On the failure path it also yields the pending-promote claim id.",
    },
  ],
  'wait-for-sheets.ts': [
    {
      read: 'talent.getByIds',
      bucket: 'WAIT-GATE',
      why: "Polls for /library-talent-sheet's write. NOTE defaultSheet's identity: the isDefault sheet, else a newest-first (createdAt DESC) scan of non-diverged sheets (src/lib/db/scoped/talent.ts:234) — so the gate opens on the newest convergent sheet, not necessarily the one the user will see as default later.",
    },
    {
      read: 'locations.getByIds',
      bucket: 'WAIT-GATE',
      why: "Polls for /library-location-sheet's referenceImageUrl.",
    },
    {
      read: 'sequenceElements.listByIds',
      bucket: 'WAIT-GATE',
      why: "Polls /element-vision's visionStatus to a terminal value.",
    },
  ],
};

/**
 * Buckets that are an open question, not a settled justification. Empty: both
 * former members were resolved rather than argued. Kept so the next escape
 * bucket lands in a list whose membership a test pins.
 */
const PROVISIONAL_BUCKETS = [] as const satisfies readonly ReadBucket[];

/**
 * Compile-time guard on the types doing the actual prevention. `WritesOnly` is
 * a conditional-type filter over method names — if it ever silently degrades to
 * a no-op (a `keyof` that resolves to `never`, a prefix list that stops
 * matching), every source scan below still passes while the type stops
 * protecting anything. The hatch assertions pin the property that makes the
 * three-way split load-bearing rather than cosmetic: `claims` cannot express a
 * selection pointer, and `credentials` cannot express a row at all. These fail
 * `bun typecheck`, not the test run.
 */
type Has<T, K extends string> = K extends keyof T ? true : false;
const _frameReadRemoved: Has<WorkflowScopedDb['frames'], 'getById'> = false;
const _frameWriteKept: Has<
  WorkflowScopedDb['frames'],
  'setImageGenerationStatus'
> = true;
const _liveReadKeepsIt: Has<WorkflowScopedDb['liveRead']['frames'], 'getById'> =
  true;
const _unsanctionedReadAbsent: Has<
  WorkflowScopedDb['liveRead']['frames'],
  'listBySequence'
> = false;
/** `claims` reaches an append-only row by id … */
const _claimsReachById: Has<
  WorkflowScopedDb['claims']['frameVariants'],
  'getById'
> = true;
/** … and cannot reach the selection pointer, which is the whole point. */
const _claimsCannotFollowPointer: Has<
  WorkflowScopedDb['claims']['frameVariants'],
  'getSelected'
> = false;
/** `credentials` resolves a key … */
const _credentialsResolve: Has<WorkflowScopedDb['credentials'], 'resolveKey'> =
  true;
const _credentialsResolveOptional: Has<
  WorkflowScopedDb['credentials'],
  'resolveOptionalKey'
> = true;
/** … and exposes no data domain to read from. */
const _credentialsHaveNoDomains: Has<
  WorkflowScopedDb['credentials'],
  'frames'
> = false;

describe('workflows read no unsanctioned mutable DB state mid-run', () => {
  test('WorkflowScopedDb strips reads, keeps writes, and liveRead is narrow', () => {
    expect([
      _frameReadRemoved,
      _frameWriteKept,
      _liveReadKeepsIt,
      _unsanctionedReadAbsent,
      _claimsReachById,
      _claimsCannotFollowPointer,
      _credentialsResolve,
      _credentialsResolveOptional,
      _credentialsHaveNoDomains,
    ]).toEqual([false, true, true, false, true, false, true, true, false]);
  });

  const files = workflowSourceFiles();

  test('the workflows directory is actually being scanned', () => {
    // Guard against a silently-empty scan (renamed dir, changed cwd) making
    // every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(30);
  });

  for (const file of files) {
    test(`${file} reads only what its allow-list entry sanctions`, () => {
      const found = scanFile(file);
      const allowed = (ALLOWED_LIVE_READS[file] ?? []).map((e) => e.read);
      const unsanctioned = found.filter((hit) => !allowed.includes(hit));
      expect(
        unsanctioned,
        `${file} reads mutable DB state that no allow-list entry covers: ${unsanctioned.join(', ')}.\n` +
          `Snapshot it into the workflow payload at the trigger instead. If the read is genuinely ` +
          `unavoidable (billing balance, credential, sibling-workflow polling, divergence recompute, ` +
          `own-write claim read, existence guard), route it through scopedDb.liveRead and add it to ` +
          `ALLOWED_LIVE_READS in ${'src/lib/workflow/no-mid-run-reads.test.ts'} with a ReadBucket and a ` +
          `one-line justification. If no bucket fits, that IS the answer: the value belongs on the payload.`
      ).toEqual([]);
    });
  }

  test('scopedDb.stalenessPlanning has exactly one consumer', () => {
    // The wide escape hatch (see scoped-workflow.ts): the update-stale planner
    // diffs ~27 live rows against stored content hashes, which is what
    // staleness IS. A second consumer would be an unaudited live read wearing
    // the planner's name.
    const users = workflowSourceFiles().filter((file) =>
      stripCommentLines(
        readFileSync(`${WORKFLOWS_DIR}/${file}`, 'utf8')
      ).includes('stalenessPlanning')
    );
    expect(
      users,
      'Only update-stale-shots-workflow.ts may use scopedDb.stalenessPlanning. ' +
        'Everything else snapshots at the trigger or goes through scopedDb.liveRead.'
    ).toEqual(['update-stale-shots-workflow.ts']);
  });

  test('each read comes through the hatch its bucket requires', () => {
    // The regex records which of `credentials` / `claims` / `liveRead` the call
    // site used; the allow-list records what the read IS. They must agree —
    // otherwise the hatch name stops being an argument and becomes decoration.
    const mismatched: string[] = [];
    for (const [file, entries] of Object.entries(ALLOWED_LIVE_READS)) {
      if (!files.includes(file)) continue;
      const byRead = new Map(
        scanFileDetailed(file).map((hit) => [hit.read, hit.hatch])
      );
      for (const entry of entries) {
        const actual = byRead.get(entry.read);
        if (actual === undefined) continue; // the stale-entry test owns this
        const allowedHatches = BUCKET_HATCH[entry.bucket];
        if (!allowedHatches.includes(actual)) {
          const names = allowedHatches.map((h) => h ?? 'no hatch').join(' or ');
          mismatched.push(
            `${file} → ${entry.read}: bucket ${entry.bucket} requires ` +
              `${names}, call site uses ${actual ?? 'no hatch'}`
          );
        }
      }
    }
    expect(
      mismatched,
      'A read must be spelled through the hatch that matches what it is. ' +
        'Reaching a claim via scopedDb.liveRead (or a key via anything but ' +
        'scopedDb.credentials) hides the justification from the call site.'
    ).toEqual([]);
  });

  test('every sanctioned read names a bucket and says why', () => {
    // The type already forbids an unbucketed entry; this catches an empty or
    // placeholder justification, which is the same failure in prose form.
    const unjustified: string[] = [];
    for (const [file, entries] of Object.entries(ALLOWED_LIVE_READS)) {
      for (const entry of entries) {
        if (entry.why.trim().length < 20) {
          unjustified.push(`${file} → ${entry.read} (${entry.bucket})`);
        }
      }
    }
    expect(unjustified).toEqual([]);
  });

  test('the provisional buckets have exactly the members recorded here', () => {
    // A provisional bucket is an open question, not a justification. Pinning
    // membership stops one becoming the place a new live read goes to avoid an
    // argument — growing it is a deliberate edit to this list. Both former
    // members are gone: STANDING-SELECTION when the plan started pinning the
    // standing still / motion version ids at the trigger, and
    // LEGACY-PAYLOAD-FALLBACK when its four reads were replaced with static
    // defaults (null frame provenance, a 'sequence' filename slug,
    // 'ai-generated' music provenance) or finished threading (variant frameId).
    const members = Object.entries(ALLOWED_LIVE_READS)
      .flatMap(([file, entries]) =>
        entries.map((entry) => ({ ...entry, file }))
      )
      .filter((entry) =>
        (PROVISIONAL_BUCKETS as readonly string[]).includes(entry.bucket)
      )
      .map((entry) => `${entry.bucket}: ${entry.file} → ${entry.read}`)
      .sort();

    expect(members).toEqual([]);
  });

  test('no allow-list entry outlives the read it sanctions', () => {
    const stale: string[] = [];
    for (const [file, allowed] of Object.entries(ALLOWED_LIVE_READS)) {
      if (!files.includes(file)) {
        stale.push(`${file} (file no longer exists)`);
        continue;
      }
      const found = scanFile(file);
      for (const entry of allowed) {
        if (!found.includes(entry.read)) stale.push(`${file} → ${entry.read}`);
      }
    }
    expect(
      stale,
      `These allow-list entries no longer match a call site — delete them so the ` +
        `escape hatch stays as narrow as the code: ${stale.join(', ')}`
    ).toEqual([]);
  });
});
