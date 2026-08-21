/**
 * The scoped-DB surface a Cloudflare Workflow is allowed to touch.
 *
 * A workflow runs minutes-to-hours after the click that started it, replays
 * its steps from a durable cache, and races its own children. So a live read
 * of mutable state can hand a step a value the user never asked for — and can
 * hand two steps of the SAME run two different values. The rule (see
 * docs/architecture/workflow-snapshots-and-content-hash-staleness.md): anything
 * that should be frozen at trigger time is snapshotted onto the payload by the
 * server fn that triggers the run, never re-read inside it.
 *
 * `WorkflowScopedDb` makes that rule a type error rather than a code-review
 * habit: it is `ScopedDb` with every read-shaped method removed from every
 * domain. Writes are untouched — writing is what a workflow is for.
 *
 * What a run legitimately cannot know at the trigger reaches it through three
 * NAMED hatches, not one catch-all — the name at the call site is the
 * argument for why the read is allowed, so a reviewer reads the justification
 * without leaving the line:
 *
 *   `scopedDb.credentials.…`  a secret, not a row (see {@link WorkflowCredentials})
 *   `scopedDb.claims.…`       an append-only row by an id this run holds ({@link WorkflowClaims})
 *   `scopedDb.liveRead.…`     genuinely live by design ({@link WorkflowLiveReads})
 *
 * The split is load-bearing, not cosmetic: `claims` cannot express a selection
 * pointer and `credentials` cannot express a row, so the two failure modes
 * that motivated this (rendering from a pointer a concurrent edit moved;
 * treating a key lookup as licence to read data) are unspellable rather than
 * merely discouraged. Each surface is enumerated below and pinned by
 * src/lib/workflow/no-mid-run-reads.test.ts, which also asserts that a read's
 * bucket matches the hatch it came through. Adding a method to any of them is
 * the reviewable act; before you do, check the value isn't knowable at the
 * trigger.
 *
 * The narrowing is type-level: `toWorkflowScopedDb` hands back the same object
 * it was given, with `claims` / `liveRead` aliasing it (`credentials` is a
 * four-field re-shape). No proxy, no copy, and no second construction path to
 * keep in sync with `createScopedDb`'s 35 domains.
 */

import type { ScopedDb } from '@/lib/db/scoped';

/**
 * Read-shaped method names — the same prefixes the enforcement test scans for.
 * Writes (`create`, `update`, `append`, `select`, `claim`, `delete`, `set`,
 * `write`, `record`, `ensure`, `check`, …) fall through untouched.
 */
type ReadMethodName<K extends string> = K extends
  | `get${string}`
  | `list${string}`
  | `find${string}`
  | `latest${string}`
  | `current${string}`
  | `resolve${string}`
  | `by${string}`
  | `has${string}`
  ? K
  : never;

type WritesOnly<T> = Omit<T, ReadMethodName<Extract<keyof T, string>>>;

/**
 * Every domain with its reads stripped. Callable members (`scopedDb.sequence(id)`)
 * and scalars (`teamId`, `userId`) pass through as-is — `Omit` on a function
 * type would drop its call signature.
 */
type WorkflowDomains = {
  [K in keyof ScopedDb]: ScopedDb[K] extends (...args: never[]) => unknown
    ? ScopedDb[K]
    : ScopedDb[K] extends object
      ? WritesOnly<ScopedDb[K]>
      : ScopedDb[K];
};

/**
 * Hatch 1 — CREDENTIALS. Secret resolution, not a data read: it returns a key,
 * never a row a generation decision could turn on. Flat (`resolveKey`, not
 * `apiKeys.resolveKey`) so a helper that needs nothing but key access can
 * declare exactly that. Resolved inside the step that spends it, because a
 * replayed step may run in a fresh isolate with an unconfigured client.
 *
 * `hasUsableKey` is deliberately NOT here — "does this team own a key" is a
 * billing fact that gates a charge, so it lives under `liveRead.apiKeys`.
 */
type WorkflowCredentials = Pick<ScopedDb, 'teamId' | 'userId'> &
  Pick<
    ScopedDb['apiKeys'],
    'resolveKey' | 'resolveOptionalKey' | 'resolveLlmKey'
  >;

/**
 * Hatch 2 — CLAIMS. Reads of append-only rows by an id the run already holds:
 * the claim it created, or the row that claim retired into on a unique-index
 * collision (named by the child's `finalVersionId`). These are safe by
 * construction — the id names one immutable row, so there is nothing for a
 * concurrent edit to substitute.
 *
 * Every method here takes an explicit id. Selection POINTERS never appear:
 * a pointer can move between the read and the render, which is exactly the
 * bug this split exists to make unspellable.
 */
type WorkflowClaims = {
  /** The visual-prompt version this run's frame-prompt child left live. */
  framePromptVersions: Pick<ScopedDb['framePromptVersions'], 'getByIdForFrame'>;
  /** The motion twin. */
  shotPromptVersions: Pick<ScopedDb['shotPromptVersions'], 'getByIdForShot'>;
  /** This run's own still render, and its pending-promote claim. */
  frameVariants: Pick<ScopedDb['frameVariants'], 'getById'>;
  /** This run's own clip render, and its pending-promote claim. */
  videoVariants: Pick<ScopedDb['videoVariants'], 'getById'>;
};

/**
 * Hatch 3 — LIVE READS. What is genuinely live BY DESIGN: the value's whole
 * purpose is that it may have moved since the trigger. Divergence
 * recomputation, sibling-workflow polling, balance and spawn-time billing
 * guards, existence guards, and the bibles an update-stale run re-renders
 * against. Anything here that could have been frozen at the trigger is a bug.
 *
 * Each domain is a `Pick` off the real `ScopedDb`, so signatures stay in
 * lockstep with the query modules and no method is hand-written.
 */
type WorkflowLiveReads = Pick<ScopedDb, 'teamId' | 'userId'> & {
  /** Whether the team owns a usable key — the BYOK half of a charge gate. */
  apiKeys: Pick<ScopedDb['apiKeys'], 'hasUsableKey'>;
  /** Balance at charge time (and the top-up it triggers) — the point is that it moved. */
  billing: Pick<
    ScopedDb['billing'],
    'hasEnoughCredits' | 'checkAutoTopUp' | 'getBalance'
  >;
  /** `getById`: divergence recompute. `listWithSheets`: live bibles for a re-render. */
  characters: Pick<ScopedDb['characters'], 'getById' | 'listWithSheets'>;
  /**
   * `getSelected` only, and only for `getAnchorImageUrl`
   * (src/lib/shots/frame-image.ts) — a thumbnail for a realtime event and the
   * last-resort still for the #929 motion-prompt refresh. Render inputs never
   * come from here: they resolve through `claims` by explicit id.
   */
  frameVariants: Pick<ScopedDb['frameVariants'], 'getSelected'>;
  /** Existence guards, plus the anchor fallback for triggers that carry no `frameId`. */
  frames: Pick<ScopedDb['frames'], 'getAnchorByShot' | 'getById'>;
  /** `getById`: divergence recompute. `getByIds`: wait-for-sheets polling. */
  locations: Pick<ScopedDb['locations'], 'getById' | 'getByIds'>;
  /** Existence guard on the segment a motion render promotes into. */
  renderSegments: Pick<ScopedDb['renderSegments'], 'getById'>;
  /** Idempotency guards, live bibles, and element-vision polling. */
  sequenceElements: Pick<
    ScopedDb['sequenceElements'],
    'getById' | 'getByToken' | 'list' | 'listByIds'
  >;
  /** `getById`: divergence recompute. `listWithReferences`: live bibles for a re-render. */
  sequenceLocations: Pick<
    ScopedDb['sequenceLocations'],
    'getById' | 'listWithReferences'
  >;
  /** Existence guards, plus the music spawn-time billing guards (music has no claim rows). */
  sequences: Pick<ScopedDb['sequences'], 'getById' | 'getForUser'>;
  /**
   * Existence guards, plus the ready-email clip/duration line (#1276) —
   * those numbers are this run's own writes, not knowable at the trigger.
   */
  shots: Pick<ScopedDb['shots'], 'getById' | 'getByIds' | 'listBySequence'>;
  /** `getByIds`: wait-for-sheets polling. `getWithRelations`: divergence recompute. */
  talent: Pick<ScopedDb['talent'], 'getByIds' | 'getWithRelations'>;
  /** Spawn-time billing guards — video has no claim rows to hold the slot. */
  videoVariants: Pick<
    ScopedDb['videoVariants'],
    'getSelectedByShot' | 'listBySegment'
  >;
  /**
   * Spawn-time enforcement — a ban applied after the parent started must
   * stop work that has not started yet. Same class as a billing guard.
   */
  compliance: Pick<ScopedDb['compliance'], 'listEnforcementFor'>;
};

export type WorkflowScopedDb = WorkflowDomains & {
  credentials: WorkflowCredentials;
  claims: WorkflowClaims;
  liveRead: WorkflowLiveReads;
  /**
   * The unnarrowed surface, for exactly ONE consumer: the update-stale
   * planner (`src/lib/shots/update-stale-plan.ts` and the scene / style /
   * image-input loaders it calls).
   *
   * Staleness planning IS a live-state comparison — it diffs ~27 live rows
   * against stored content hashes to decide what to regenerate — so there is
   * nothing to snapshot: the live rows ARE the input. It also runs verbatim
   * in the server fns that render the "what's stale" preview, so it cannot
   * take the narrowed type without forking. It runs once, inside a single
   * `step.do` at the top of the run, and the plan it returns is the frozen
   * snapshot every later step consumes.
   *
   * Do not reach for this anywhere else — a second consumer means an
   * unaudited live read, which is the whole thing this type prevents.
   * src/lib/workflow/no-mid-run-reads.test.ts fails if another workflow
   * references it.
   */
  stalenessPlanning: ScopedDb;
};

export function toWorkflowScopedDb(scopedDb: ScopedDb): WorkflowScopedDb {
  return {
    ...scopedDb,
    // `credentials` is the one hatch that is re-shaped rather than aliased:
    // flattening the two resolvers is what lets a helper declare "I need a key"
    // without also declaring a read surface. Delegating (rather than detaching
    // the two functions) keeps the `apiKeys` access at CALL time, so building a
    // WorkflowScopedDb never depends on that domain being present — which
    // matters for the partial `createScopedDb` stubs the workflow tests use.
    credentials: {
      teamId: scopedDb.teamId,
      userId: scopedDb.userId,
      resolveKey: (provider) => scopedDb.apiKeys.resolveKey(provider),
      resolveOptionalKey: (provider) =>
        scopedDb.apiKeys.resolveOptionalKey(provider),
      resolveLlmKey: (model) => scopedDb.apiKeys.resolveLlmKey(model),
    },
    claims: scopedDb,
    liveRead: scopedDb,
    stalenessPlanning: scopedDb,
  };
}

/**
 * What the media generation helpers (`image-generation`, `motion-generation`,
 * `music-generation`) actually depend on: resolve a key (team or platform),
 * look for an optional native-provider key (#1216), and know whose run this
 * is for observability. BytePlus Ark is platform-only — `ARK_API_KEY` comes
 * from env, is not on `API_KEY_PROVIDERS`, and is never resolved here (#1157).
 * Satisfied by `scopedDb.credentials`.
 */
export type CredentialScopedDb = Pick<ScopedDb, 'userId'> &
  Pick<ScopedDb['apiKeys'], 'resolveKey' | 'resolveOptionalKey'>;
