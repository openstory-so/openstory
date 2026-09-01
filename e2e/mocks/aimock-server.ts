/**
 * aimock Server for E2E Tests
 *
 * Standalone mock server that intercepts server-side AI traffic during E2E
 * tests. Handles OpenRouter (LLM) and fal.ai (image/video/audio) natively:
 *
 * - OpenRouter: aimock's OpenAI-compatible dispatcher matches against
 *   recorded fixtures under `fixtures/recorded/openrouter/<stage>/`.
 * - fal.ai: aimock's built-in `/fal/*` dispatcher (server.js dispatch at
 *   `FAL_PREFIX_RE`) reads the `x-fal-target-host` header that
 *   `src/lib/ai/fal-config.ts` already stamps on fal requests, and matches
 *   against recorded fixtures under `fixtures/recorded/fal/`. No `mount()`
 *   needed — the library handles it.
 *
 * Browser-side mocks (R2, QStash) remain in handlers.ts via Playwright routes.
 */

import {
  isAudioResponse,
  LLMock,
  loadFixtureFile,
  type ChatCompletionRequest,
  type Fixture,
  type JournalEntry,
} from '@copilotkit/aimock';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { E2E_RECORDING } from '../recording-mode';

const AIMOCK_PORT = 4010;
const FIXTURE_DIR = resolve(
  import.meta.dirname,
  '../fixtures/recorded/openrouter'
);
const FAL_FIXTURE_DIR = resolve(
  import.meta.dirname,
  '../fixtures/recorded/fal'
);
// aimock's recorder writes flat into a single directory; we point it here and
// `sortStagingFixtures()` (run on shutdown) classifies each new file by its
// provider-key prefix (`openai-…` vs `fal-…`) and moves it into the right
// sibling subfolder of `fixtures/recorded/` (`openrouter/<stage>/` or `fal/`).
const RECORD_STAGING_DIR = resolve(
  import.meta.dirname,
  '../fixtures/recorded/_unsorted'
);

// Maps a fixture's `userMessage` prefix to the stage subfolder it belongs in.
// First-match-wins; prefixes are disjoint (each comes from a distinct workflow
// step's prompt template). Add a new entry when introducing a new prompt
// family — otherwise its recordings get stuck in `_unsorted/` with a warning.
const STAGE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['Enhance the script inside <USER_SCRIPT>', 'script-enhance'],
  ['STYLE CATALOG (choose by index):', 'style-recommend'],
  ['Split the script within the USER_SCRIPT', 'script-analyze'],
  ['Extract a complete character bible', 'script-bibles'],
  ['Match the following library locations', 'location-match'],
  ['Cast the following talent', 'talent-cast'],
  ['Generate the visual prompt for the starting frame', 'visual-prompts'],
  ['Generate the motion prompt for this scene', 'motion-prompts'],
  ['Classify music design for each scene', 'music-design'],
  ['Uploaded filename:', 'element-vision'],
  ['Analyze this talent reference', 'talent-vision'],
];

// Diagnostic dump for unmatched requests — written on shutdown so we can diff
// the failing userMessage against the closest fixture and find what drifted.
const UNMATCHED_DUMP_PATH = resolve(
  import.meta.dirname,
  '../results/aimock-unmatched.json'
);

// OpenRouter SDK validates `system_fingerprint` as `z.nullable(z.string())`,
// rejecting `undefined`. aimock omits the field unless the fixture supplies
// `systemFingerprint`, so stamp a value on every text/tool-call response.
const AIMOCK_SYSTEM_FINGERPRINT = 'fp_aimock';

// Recorded OpenRouter fixtures never persist `usage.cost` (aimock emits it
// only when the fixture supplies it — never defaulted). Replay then has
// tokens but no cost, `llmCostFromUsage` bills $0, and every completed LLM
// step logs `Completed AI generation with no billable cost reported`.
// $0.02 matches `estimateLLMCost` so e2e deduction matches the credit gate.
const AIMOCK_LLM_COST_USD = 0.02;

/**
 * Unusable OpenRouter recordings — drop them so the request proxies live
 * instead of replaying a dead answer forever.
 *
 * Two shapes qualify, and #1218 produced both from one cause: a vision part
 * whose declared MIME type disagreed with its bytes made Anthropic return an
 * empty completion (mostly) or a 400 (occasionally). Recording either one
 * bakes the failure into the fixture set, where it resurfaces as a bogus
 * `empty completion` far from the real problem.
 */
function isUnusableOpenRouterFixtureFile(filePath: string): boolean {
  try {
    const data: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!data || typeof data !== 'object' || !('fixtures' in data)) {
      return false;
    }
    const fixtures = data.fixtures;
    if (!Array.isArray(fixtures) || fixtures[0] == null) return false;
    return isUnusableOpenRouterFixture(fixtures[0]);
  } catch {
    return false;
  }
}

function isUnusableOpenRouterFixture(fixture: unknown): boolean {
  if (!fixture || typeof fixture !== 'object' || !('response' in fixture)) {
    return false;
  }
  const response = fixture.response;
  if (typeof response === 'function') return false;
  if (!response || typeof response !== 'object') return false;
  // A recorded provider error replays that error on every future run.
  if ('error' in response) return true;
  if (!('content' in response)) return false;
  const content = response.content;
  if (typeof content !== 'string' || content.length > 0) return false;
  if (
    'toolCalls' in response &&
    Array.isArray(response.toolCalls) &&
    response.toolCalls.length > 0
  ) {
    return false;
  }
  return true;
}

function stampOne(fixture: Fixture): void {
  const response = fixture.response;
  // Response factories (aimock 1.35+) build their response per-request; our
  // recorded fixtures are always static objects, so skip the function form.
  if (typeof response === 'function') return;
  // Only completion responses (TextResponse / ToolCallResponse /
  // ContentWithToolCallsResponse) extend ResponseOverrides where
  // systemFingerprint lives. Narrow via `in` so other variants
  // (ImageResponse, ErrorResponse, …) are skipped. AudioResponse (added in
  // aimock 1.35) also carries `content` but no systemFingerprint — exclude it.
  if (isAudioResponse(response)) return;
  if (!('content' in response) && !('toolCalls' in response)) return;
  if (response.systemFingerprint === undefined) {
    response.systemFingerprint = AIMOCK_SYSTEM_FINGERPRINT;
  }
  if (response.usage?.cost === undefined) {
    response.usage = { ...response.usage, cost: AIMOCK_LLM_COST_USD };
  }
}

function stampSystemFingerprint(fixtures: Fixture[]): Fixture[] {
  for (const fixture of fixtures) stampOne(fixture);
  return fixtures;
}

// The recorder pushes newly-recorded fixtures straight onto LLMock's internal
// array. Wrap `push`/`unshift` so subsequent replays (e.g. workflow retries)
// also see the stamped `systemFingerprint`.
function patchFixturesArray(fixtures: Fixture[]): void {
  const keep = (items: Fixture[]): Fixture[] => {
    const kept: Fixture[] = [];
    for (const item of items) {
      if (isUnusableOpenRouterFixture(item)) {
        console.warn(
          '[e2e] aimock: dropping unusable OpenRouter recording so a workflow retry proxies instead of replaying it'
        );
        continue;
      }
      stampOne(item);
      kept.push(item);
    }
    return kept;
  };
  const originalPush = fixtures.push.bind(fixtures);
  fixtures.push = (...items: Fixture[]) => originalPush(...keep(items));
  const originalUnshift = fixtures.unshift.bind(fixtures);
  fixtures.unshift = (...items: Fixture[]) => originalUnshift(...keep(items));
}

// aimock's `loadFixturesFromDir` is non-recursive (logs and skips subdirs).
// Walk ourselves so stage-folders (`script-enhance/`, `visual-prompts/`, …)
// load.
function loadFixturesRecursive(dirPath: string): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      fixtures.push(...loadFixturesRecursive(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      fixtures.push(
        ...loadFixtureFile(fullPath).filter(
          (fixture) => !isUnusableOpenRouterFixture(fixture)
        )
      );
    }
  }
  return fixtures;
}

// Workflow prompts embed runtime ULIDs (talent/location/sequence IDs) that
// drift across fresh DB seeds — recorded `01KQRR…` won't substring-match a
// fresh CI run's `01KQW2…`. Rewrite each fixture's `userMessage` into a
// RegExp where ULIDs/UUIDs become wildcards so matching is ID-tolerant.
// Mirrors `fal-handler.ts:normalizeForHash`, which solves the same problem
// for fal request hashing.
const ULID_TOKEN_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const UUID_TOKEN_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ULID_OR_UUID_SPLIT_RE = new RegExp(
  `(${ULID_TOKEN_RE.source}|${UUID_TOKEN_RE.source})`,
  'i'
);

// fal request bodies for non-prompt models (ffmpeg-api/loudnorm/compose,
// kling image-to-video, nano-banana-2-edit) contain R2 URLs and fal CDN
// URLs that drift every run. aimock's built-in fal handler matches on the
// JSON-stringified body when no `prompt` field is present, so without
// normalization those fixtures never match across runs. Mirrors the
// deleted custom fal-handler.ts:normalizeForHash exactly:
//   - UPLOAD_SUFFIX: the ULID-tail shortHash baked into R2 filenames
//     (e.g. `merged/<8 hex>_openstory.mp4` or
//     `<slug>_<slug>_<6 hex>_openstory.<ext>`).
//   - FAL_CDN_PATH: fal output URLs of the shape
//     `/files/b/<8 hex>/<base62 id>_<rest>.<ext>`. Collapse the bucket+id
//     while preserving the `_<rest>.<ext>` suffix so different logical
//     outputs (normalized_audio.wav vs output.mp4) still differ.
const FAL_UPLOAD_SUFFIX_RE = /(?<=[_/])[0-9A-Za-z]{6,16}_openstory\./g;
const FAL_CDN_PATH_RE =
  /\/files\/b\/[0-9a-f]{6,12}\/[A-Za-z0-9_-]{10,}(?=[_.])/g;
//   - STORAGE_ORIGIN: our storage URL form drifts between record and replay.
//     Stored URLs are origin-relative (`/r2/...`, #894), so replay sends
//     bare `/r2/` paths, while older fixtures embed absolute local-route
//     URLs (http://localhost:3001/r2/...) or the storage-dev CDN domain.
//     Collapse those three to a single token so body-matched fixtures
//     (ffmpeg-style models with URL fields) survive the difference.
//     (Record runs hand real providers fal-storage URLs instead; those are
//     normalized separately by FAL_UPLOAD_SUFFIX_RE / FAL_CDN_PATH_RE, not
//     collapsed to <STORAGE>.)
const STORAGE_ORIGIN_RE =
  /(https?:\/\/(localhost:\d+\/r2|storage(-[a-z]+)?\.openstory\.so)\/|\/r2\/)/g;
//   - LOCAL_CDN_CGI_ORIGIN: derived transform URLs (variant-crop trim URLs)
//     are origin-relative too (`/cdn-cgi/image/...`), while older fixtures
//     recorded them absolute on the local origin. Strip the origin so both
//     forms normalize identically.
const LOCAL_CDN_CGI_ORIGIN_RE = /https?:\/\/localhost:\d+(?=\/cdn-cgi\/)/g;

function normalizeFalContent(content: string): string {
  return content
    .replace(ULID_TOKEN_RE, '<ULID>')
    .replace(UUID_TOKEN_RE, '<UUID>')
    .replace(FAL_UPLOAD_SUFFIX_RE, '<HASH>_openstory.')
    .replace(FAL_CDN_PATH_RE, '/files/b/<FAL>/<FAL>')
    .replace(LOCAL_CDN_CGI_ORIGIN_RE, '')
    .replace(STORAGE_ORIGIN_RE, '<STORAGE>/');
}

// aimock applies this to both the live request (router.js:38) and the
// recorder's fixture-match build (recorder.js:172), so record and replay
// stay symmetric — both sides see normalized content.
// Setting a transform also flips string matching from `.includes()` to
// `===` (router.js:39); openrouter fixtures are unaffected because
// `tolerateRuntimeIds` rewrites their userMessage matchers as RegExps,
// which always use `.test()`.
function falRequestTransform(
  req: ChatCompletionRequest
): ChatCompletionRequest {
  if (req._endpointType !== 'fal') return req;
  const messages = req.messages.map((msg) => {
    if (msg.role !== 'user' || typeof msg.content !== 'string') return msg;
    return { ...msg, content: normalizeFalContent(msg.content) };
  });
  return { ...req, messages };
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tolerantUserMessageRegex(userMessage: string): RegExp {
  const segments = userMessage.split(ULID_OR_UUID_SPLIT_RE);
  const pattern = segments
    .map((segment, idx) => {
      // Split keeps capture groups, so odd indices are matched tokens.
      if (idx % 2 === 0) return escapeRegex(segment);
      return segment.includes('-')
        ? '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
        : '[0-9A-HJKMNP-TV-Z]{26}';
    })
    .join('');
  return new RegExp(pattern);
}

// The OpenRouter fixtures were recorded when DEFAULT_ANALYSIS_MODEL was Opus 5
// (#1367 Fable 5, then Luna). They are replay stubs, not quality samples, so
// in replay they also answer for the current default rather than forcing a
// full re-record (every fal fixture downstream is keyed on the LLM output).
// Recording mode keeps the exact model so a re-record captures Luna.
const FIXTURE_MODEL_ALIASES: Record<string, RegExp> = {
  'anthropic/claude-opus-5':
    /^(anthropic\/claude-(opus|fable)-5|openai\/gpt-5\.6-luna)$/,
};

function tolerateRuntimeIds(fixtures: Fixture[]): Fixture[] {
  for (const fixture of fixtures) {
    const message = fixture.match.userMessage;
    if (typeof message === 'string') {
      fixture.match.userMessage = tolerantUserMessageRegex(message);
    }
    const model = fixture.match.model;
    if (
      !E2E_RECORDING &&
      typeof model === 'string' &&
      FIXTURE_MODEL_ALIASES[model]
    ) {
      fixture.match.model = FIXTURE_MODEL_ALIASES[model];
    }
  }
  return fixtures;
}

let mockServer: LLMock | null = null;

export async function startAimockServer(): Promise<string> {
  mockServer = new LLMock({
    port: AIMOCK_PORT,
    // Strict replay returns 503 on unmatched requests. aimock's fal
    // dispatcher (fal.js:240) checks strict mode BEFORE the record branch,
    // so leaving strict on during recording would 503 every fal call
    // instead of proxying upstream. Gate it on recording mode: strict for
    // CI replay, lenient while recording so the proxy/record path runs.
    // 503 alone is not fail-fast: image/LLM workflows retry 503s as
    // transient (content-soften 1/4, image 1/5), so Playwright would sit
    // on the spec timeout. abortPlaywrightOnStrictMiss() kills the run
    // on the first journaled miss.
    strict: !E2E_RECORDING,
    logLevel: 'info',
    // Recorded fixtures carry real streaming timings (ttft + inter-chunk
    // delays) which replay at 1x by default — a full-pipeline replay would
    // wait out every original LLM stream in real time. 100x fast-forwards
    // (a 30s reasoning gap becomes 300ms) while still yielding between
    // chunks, so concurrent streams keep interleaving like production.
    // Recording is unaffected — record mode streams live from upstream.
    // AIMOCK_REPLAY_SPEED overrides for demo/video runs where streaming
    // should be watchable (e.g. 10 keeps the script split visibly streaming).
    replaySpeed: Number(process.env.AIMOCK_REPLAY_SPEED ?? 100),
    requestTransform: falRequestTransform,
    // Record only when E2E_RECORD=1 (real key from .env.local). Default is
    // strict replay against the recorded fixtures — CI runs without the flag
    // so a missing fixture 503s instead of proxying to live OpenRouter.
    // Recordings land in `_unsorted/`; the record script sorts them into
    // stage subfolders post-run so they don't pollute the curated layout.
    ...(E2E_RECORDING && {
      record: {
        providers: { openai: 'https://openrouter.ai/api/v1' },
        fixturePath: RECORD_STAGING_DIR,
        // Reasoning models (e.g. Grok 4.5 + structured output under concurrent
        // load) routinely leave 30s+ gaps between SSE chunks while thinking,
        // which trips aimock's default 30s body-idle timer and truncates the
        // recorded stream — recordings for the slowest calls are silently
        // dropped (CopilotKit/aimock#197, shipped in >=1.35.0).
        bodyTimeoutMs: 120_000,
      },
    }),
  });

  // Load any previously recorded fixtures
  if (existsSync(FIXTURE_DIR)) {
    mockServer.addFixtures(
      tolerateRuntimeIds(
        stampSystemFingerprint(loadFixturesRecursive(FIXTURE_DIR))
      )
    );
  }

  // Stamp fixtures the recorder appends mid-run too. getFixtures() returns
  // the internal array typed as `readonly` for callers; we monkey-patch its
  // push/unshift, which is exactly what the readonly modifier exists to
  // prevent — hence the cast.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- intentional readonly→mutable widening to install push/unshift hooks
  patchFixturesArray(mockServer.getFixtures() as Fixture[]);

  // fal.ai fixtures: aimock's built-in /fal/* dispatcher matches against the
  // same fixture pool. Loaded raw — no ULID tolerance or fingerprint stamping
  // (those are OpenRouter-shaped concerns). When recording, `handleFal`
  // auto-derives `providers.fal = https://${x-fal-target-host}`, so no extra
  // record-providers entry is needed.
  if (existsSync(FAL_FIXTURE_DIR)) {
    mockServer.addFixtures(loadFixturesRecursive(FAL_FIXTURE_DIR));
  }

  const url = await mockServer.start();
  // Replay only: a STRICT 503 is otherwise retried by workflows, so the
  // spec keeps running. Kill Playwright on the first miss instead.
  if (!E2E_RECORDING) abortPlaywrightOnStrictMiss(mockServer);
  console.log(`[e2e] aimock server started at ${url}`);
  return url;
}

function isStrictMiss(entry: JournalEntry): boolean {
  return (
    entry.body !== null &&
    entry.response.fixture === null &&
    entry.response.status === 503 &&
    entry.response.source !== 'proxy' &&
    entry.response.source !== 'internal'
  );
}

// STRICT 503 is not enough: generate steps retry it. Hook the journal (same
// process as the Playwright runner — globalSetup is in-process) and exit
// on the first miss. A short debounce lets a parallel fan-out journal its
// siblings so the unmatched dump covers the burst, not just the first POST.
function abortPlaywrightOnStrictMiss(server: LLMock): void {
  const journal = server.journal;
  const originalAdd = journal.add.bind(journal);
  let scheduled = false;
  // Class method is on the prototype; an own-property wrapper shadows it
  // for every handler that calls journal.add(entry).
  journal.add = (entry: Parameters<typeof originalAdd>[0]) => {
    const full = originalAdd(entry);
    if (scheduled || !isStrictMiss(full)) return full;
    scheduled = true;
    setTimeout(() => {
      try {
        dumpUnmatchedRequests(server);
      } catch (error) {
        console.error('[e2e] Failed to dump unmatched aimock requests:', error);
      }
      console.error(
        [
          '',
          '[e2e] FATAL: aimock STRICT miss — no fixture matched.',
          `      ${full.method} ${full.path}`,
          `      Dump: ${UNMATCHED_DUMP_PATH}`,
          '      Re-record with: bun test:e2e:full:record',
          '',
        ].join('\n')
      );
      process.exit(1);
    }, 50);
    return full;
  };
}

export async function stopAimockServer(): Promise<void> {
  if (!mockServer) return;
  dumpUnmatchedRequests(mockServer);
  if (E2E_RECORDING) sortStagingFixtures();
  try {
    await mockServer.stop();
    console.log('[e2e] aimock server stopped');
  } catch {
    // Server may not have started successfully — ignore stop errors
  }
  mockServer = null;
}

type FixtureFile = {
  fixtures: Array<{ match: { userMessage?: string; model?: string } }>;
};

function classifyStage(filePath: string): string | null {
  const data: FixtureFile = JSON.parse(readFileSync(filePath, 'utf8'));
  const userMessage = data.fixtures[0]?.match.userMessage ?? '';
  return (
    STAGE_PREFIXES.find(([prefix]) => userMessage.startsWith(prefix))?.[1] ??
    null
  );
}

// Slugify the fal model path into a folder name. Strips the `fal-ai/` vendor
// prefix and replaces remaining `/` separators with `-`, so e.g.
// `fal-ai/kling-video/v3/pro/image-to-video` → `kling-video-v3-pro-image-to-video`.
// Returns `null` if the fixture lacks a usable model field — caller falls back
// to dropping it into `FAL_FIXTURE_DIR` directly.
function classifyFalModel(filePath: string): string | null {
  const data: FixtureFile = JSON.parse(readFileSync(filePath, 'utf8'));
  const model = data.fixtures[0]?.match.model;
  if (!model) return null;
  const tail = model.startsWith('fal-ai/')
    ? model.slice('fal-ai/'.length)
    : model;
  return tail.replace(/\//g, '-') || null;
}

// ── Stable fixture names ───────────────────────────────────────────────────
// aimock's recorder names files `<provider>-<ISO-timestamp>-<randomUUID8>.json`
// (recorder.js:55) — both halves are nondeterministic, so identical inputs get
// a brand-new filename every record run. That makes `git diff` between two
// recordings useless: every fixture reads as delete+add instead of modify. We
// rename each fixture here to a stable, content-derived name so an unchanged
// input keeps its filename across runs (→ no diff) and a changed input shows as
// an inline modify of one file. R2 fixtures already use stable hash names, so
// only the aimock (openrouter/fal) fixtures need this.

// Lowercase-slug a free-text fragment for use in a filename. Collapses
// whitespace/punctuation to single dashes and trims to a sane length.
function slugify(text: string, maxLen = 48): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLen).replace(/-+$/g, '') || 'untitled';
}

// 6-hex content hash of the fixture's *normalized* match input. Normalizing
// first (same transform replay uses) means runtime ULIDs / R2 URLs / fal CDN
// paths don't perturb the hash, so a logically-identical request hashes the
// same across runs.
function fixtureContentHash(userMessage: string): string {
  return createHash('sha256')
    .update(normalizeFalContent(userMessage))
    .digest('hex')
    .slice(0, 6);
}

// Derive a stable base name (no extension) for a fixture file. Per-scene
// openrouter stages key on the embedded `scene_NNN` id; openrouter singletons
// collapse to the stage name; fal fixtures (no scene id in the body) use a
// slug of their prompt lead plus a content hash. The hash both disambiguates
// distinct fal calls in one run and changes when the fal input changes — fal
// can't get a hash-free name because nothing in its body is a stable key.
function stableBaseName(
  userMessage: string,
  kind: 'openrouter' | 'fal'
): string {
  const sceneId = /\bscene_(\d+)\b/.exec(userMessage)?.[0];

  if (kind === 'openrouter') {
    // Per-scene stages → scene_003; singletons (no scene id) → handled by the
    // caller passing the stage name as the fallback base.
    return sceneId ?? '';
  }

  // fal: lead with the scene id when present, then a slug of the first line of
  // the prompt, then a short content hash to disambiguate + track input drift.
  const firstLine = userMessage.split('\n', 1)[0] ?? '';
  const lead = slugify(firstLine);
  const hash = fixtureContentHash(userMessage);
  return sceneId ? `${sceneId}-${lead}__${hash}` : `${lead}__${hash}`;
}

// Move `src` to `<destDir>/<base>.json`, guarding against two within-run
// fixtures resolving to the same name (which would silently overwrite). On
// collision, suffix with a short hash of the full content so both survive and
// the clash is visible. Cross-run "collisions" are the whole point — the new
// file replaces the old same-named one, which is the inline diff we want.
// A fixture hand-edited after recording (e.g. the #881 content-flag retry
// injection — a sequenceIndex-0 error + a no-index success) carries
// `"_preserveOnRecord": true`. A naive re-record would overwrite it with a
// fresh single-success fixture and silently drop the injected behaviour.
function isPreservedFixture(filePath: string): boolean {
  try {
    const data: { _preserveOnRecord?: unknown } = JSON.parse(
      readFileSync(filePath, 'utf8')
    );
    return data._preserveOnRecord === true;
  } catch {
    return false;
  }
}

function moveToStableName(
  src: string,
  destDir: string,
  base: string,
  userMessage: string
): void {
  mkdirSync(destDir, { recursive: true });
  let dest = resolve(destDir, `${base}.json`);
  // A hand-injected fixture (`_preserveOnRecord: true`) must NOT be silently
  // clobbered by a re-record. Discard the freshly-recorded response, keep the
  // injected file, and warn loudly so whoever re-records knows to re-apply the
  // injection if the prompt drifted.
  if (existsSync(dest) && isPreservedFixture(dest)) {
    console.warn(
      [
        '',
        '⚠️  [e2e] aimock: PRESERVED a hand-injected fixture — re-record overwrite SKIPPED:',
        `      ${dest}`,
        '      Marked "_preserveOnRecord": true (e.g. the #881 content-flag retry: a',
        '      sequenceIndex-0 error + a no-index success). The fresh recording was',
        '      DISCARDED so the injection survives. If the prompt changed, re-apply the',
        "      injected error entry by hand (see the file's _comment).",
        '',
      ].join('\n')
    );
    rmSync(src, { force: true });
    return;
  }
  // Only treat it as a real collision if the existing file came from THIS run
  // (i.e. we already wrote it this pass). We can't easily track that, so fall
  // back to content equality: if the target exists with different content,
  // suffix to avoid clobbering a sibling recorded moments earlier.
  if (existsSync(dest)) {
    const existing = readFileSync(dest, 'utf8');
    const incoming = readFileSync(src, 'utf8');
    if (existing !== incoming) {
      const suffix = createHash('sha256')
        .update(userMessage)
        .digest('hex')
        .slice(0, 8);
      dest = resolve(destDir, `${base}__${suffix}.json`);
    }
  }
  renameSync(src, dest);
}

// Read the (single) fixture's userMessage from a staged file.
function readUserMessage(filePath: string): string {
  const data: FixtureFile = JSON.parse(readFileSync(filePath, 'utf8'));
  const um = data.fixtures[0]?.match.userMessage;
  return typeof um === 'string' ? um : '';
}

// Walk `fixtures/recorded/_unsorted/` (sibling of `openrouter/` and `fal/`)
// and move each freshly-recorded fixture into the right curated subfolder,
// renaming it to a stable content-derived name (see stableBaseName) so diffs
// between recordings are meaningful. aimock's recorder names files
// `<providerKey>-…json` (recorder.js:196), so we route by prefix: `fal-…` into
// a model-keyed subfolder of `fixtures/recorded/fal/` and `openai-…` (OpenRouter)
// into a stage subfolder of `fixtures/recorded/openrouter/`.
// Runs on shutdown of any E2E_RECORD=1 run.
function sortStagingFixtures(): void {
  if (!existsSync(RECORD_STAGING_DIR)) return;

  const files = readdirSync(RECORD_STAGING_DIR).filter((name) =>
    name.endsWith('.json')
  );
  if (files.length === 0) {
    rmdirSync(RECORD_STAGING_DIR);
    return;
  }

  console.log(`[e2e] aimock: sorting ${files.length} new fixture(s)…`);
  let sorted = 0;
  for (const name of files) {
    const src = resolve(RECORD_STAGING_DIR, name);
    if (name.startsWith('openai-') && isUnusableOpenRouterFixtureFile(src)) {
      console.warn(
        `[e2e] aimock: discarding unusable OpenRouter recording ${name}`
      );
      rmSync(src);
      continue;
    }
    const userMessage = readUserMessage(src);
    if (name.startsWith('fal-')) {
      const modelSlug = classifyFalModel(src);
      const destDir = modelSlug
        ? resolve(FAL_FIXTURE_DIR, modelSlug)
        : FAL_FIXTURE_DIR;
      const base = stableBaseName(userMessage, 'fal');
      moveToStableName(src, destDir, base, userMessage);
      sorted++;
      continue;
    }
    const stage = classifyStage(src);
    if (stage === null) {
      console.warn(
        `[e2e] aimock: ${name} has no matching stage prefix — leaving in _unsorted/. Add it to STAGE_PREFIXES if it's a new prompt family.`
      );
      continue;
    }
    const stageDir = resolve(FIXTURE_DIR, stage);
    // Per-scene stages get a scene_NNN name; singletons (no scene id in the
    // prompt) collapse to the stage name itself (e.g. script-enhance.json).
    const base = stableBaseName(userMessage, 'openrouter') || stage;
    moveToStableName(src, stageDir, base, userMessage);
    sorted++;
  }
  console.log(`[e2e] aimock: sorted ${sorted}/${files.length} fixtures`);

  if (readdirSync(RECORD_STAGING_DIR).length === 0) {
    rmdirSync(RECORD_STAGING_DIR);
  }
}

// For each unmatched request, also pick the fixture whose userMessage shares
// the longest common prefix with the request — that's almost always the
// "intended" fixture, and the diff between them is exactly the drift we
// want to find.
function dumpUnmatchedRequests(server: LLMock): void {
  const unmatched = server.journal.getAll().filter((entry) => {
    return entry.body !== null && entry.response.fixture === null;
  });
  if (unmatched.length === 0) return;

  const fixtures = server.getFixtures();
  const report = unmatched.map((entry) => {
    const userMessage = extractUserMessage(entry.body);
    const closest = userMessage
      ? findClosestFixture(fixtures, userMessage)
      : null;
    return {
      timestamp: new Date(entry.timestamp).toISOString(),
      method: entry.method,
      path: entry.path,
      status: entry.response.status,
      requestModel: entry.body?.model ?? null,
      requestUserMessage: userMessage,
      closestFixturePrefix: closest?.fixturePrefix ?? null,
      commonPrefixLength: closest?.commonLength ?? 0,
      firstDivergenceContext: closest?.divergenceContext ?? null,
    };
  });

  mkdirSync(resolve(UNMATCHED_DUMP_PATH, '..'), { recursive: true });
  writeFileSync(UNMATCHED_DUMP_PATH, JSON.stringify(report, null, 2));
  console.log(
    `[e2e] aimock: ${unmatched.length} unmatched request(s) dumped to ${UNMATCHED_DUMP_PATH}`
  );
}

function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  return (
    typeof part === 'object' &&
    part !== null &&
    'type' in part &&
    part.type === 'text' &&
    'text' in part &&
    typeof part.text === 'string'
  );
}

// aimock's ChatCompletionRequest.messages is the OpenAI-shaped array; the
// last user message's text is what the matcher checks against. Mirror its
// extraction logic loosely so the dump shows what the matcher saw.
function extractUserMessage(
  body: { messages?: Array<{ role: string; content: unknown }> } | null
): string | null {
  if (!body?.messages) return null;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const msg = body.messages[i];
    if (!msg) continue;
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter(isTextPart)
        .map((p) => p.text)
        .join('');
      return text || null;
    }
    return null;
  }
  return null;
}

function findClosestFixture(
  fixtures: readonly Fixture[],
  request: string
): {
  fixturePrefix: string;
  commonLength: number;
  divergenceContext: string;
} | null {
  let best: {
    fixtureSource: string;
    commonLength: number;
  } | null = null;

  for (const fixture of fixtures) {
    const matcher = fixture.match.userMessage;
    // We rewrap recorded strings as RegExps in tolerateRuntimeIds(). Recover
    // the original literal by stripping the regex wildcards we inserted —
    // close enough for prefix comparison.
    const fixtureSource =
      typeof matcher === 'string'
        ? matcher
        : matcher
          ? matcher.source
              .replace(/\\([.*+?^${}()|[\]\\])/g, '$1')
              .replace(/\[0-9A-HJKMNP-TV-Z\]\{26\}/g, '<ULID>')
              .replace(
                /\[0-9a-fA-F\]\{8\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{12\}/g,
                '<UUID>'
              )
          : '';
    if (!fixtureSource) continue;

    const commonLength = commonPrefixLength(request, fixtureSource);
    if (best === null || commonLength > best.commonLength) {
      best = { fixtureSource, commonLength };
    }
  }

  if (!best) return null;

  const ctxStart = Math.max(0, best.commonLength - 80);
  const reqCtx = request.slice(ctxStart, best.commonLength + 200);
  const fixCtx = best.fixtureSource.slice(ctxStart, best.commonLength + 200);
  return {
    fixturePrefix: best.fixtureSource.slice(0, 80),
    commonLength: best.commonLength,
    divergenceContext: `REQUEST   : …${JSON.stringify(reqCtx)}\nFIXTURE   : …${JSON.stringify(fixCtx)}`,
  };
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
