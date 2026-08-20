/**
 * Detect newer versions of the AI models we already use.
 *
 * Reads our four model registries, then queries public, unauthenticated
 * endpoints to find newer sibling versions:
 *   - fal.ai catalog      → https://fal.ai/api/models?keywords=…&category=…
 *   - OpenRouter catalog  → https://openrouter.ai/api/v1/models
 *   - BytePlus Ark        → the installed @tanstack/ai-byteplus model catalog
 *     (offline — Ark has no public catalog)
 *
 * npm package updates (including our @tanstack/ai* deps) are intentionally NOT
 * checked here — Dependabot owns dependency bumps. This routine is only about
 * bumping model registry ids to a newer version of the same model.
 *
 * This is the deterministic backbone of the `update-model-versions` skill and
 * the daily "model freshness" routine. It only REPORTS candidates — deciding
 * whether a candidate is a genuine successor (vs a different product line) and
 * applying the bump is the skill's job. HTTP-only by design so it runs anywhere
 * (local, CI, or a headless cron agent) without genmedia/fal-MCP/FAL_KEY.
 *
 * Proxy handling: the agent/CI sandboxes route outbound HTTPS through a
 * TLS-intercepting proxy (HTTPS_PROXY). Bun's fetch cannot complete the
 * handshake through such a proxy, which silently turned every lookup into an
 * error on the cloud routine. So when a proxy is configured we make requests
 * via `curl` (a system tool, not an npm dep) — it honors HTTPS_PROXY, NO_PROXY,
 * and the system CA bundle on every runtime. Without a proxy, the built-in
 * fetch is used directly. `curl` must be on PATH behind a proxy (it is in CI,
 * cloud sandboxes, and standard dev machines).
 *
 * Usage:
 *   bun scripts/check-model-updates.ts            # human-readable report
 *   bun scripts/check-model-updates.ts --json     # machine-readable JSON
 *
 * Exit code is 0 when every lookup succeeded — whether or not updates were
 * found (it is a report, not a gate). It is NON-ZERO when one or more lookups
 * FAILED, so automation never mistakes a network outage for "all models
 * current". Branch on the JSON `ok` / `hasUpdates` fields (`ok: false` means
 * the report is incomplete — investigate connectivity, do not stop).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  BYTEPLUS_IMAGE_MODELS,
  BYTEPLUS_VIDEO_MODELS,
} from '@tanstack/ai-byteplus';

import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
} from '@/lib/ai/models';
import { SCRIPT_ANALYSIS_MODELS } from '@/lib/ai/models.config';

const jsonOutput = process.argv.includes('--json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Candidate = {
  id: string;
  title?: string;
  version: string | null;
};

type ModelReport = {
  source: 'fal-image' | 'fal-video' | 'fal-audio' | 'openrouter' | 'byteplus';
  key: string;
  currentId: string;
  currentVersion: string | null;
  /** Siblings in the same family that look NEWER than what we use. */
  newer: Candidate[];
  /** All same-family siblings, for context (may include older/variants). */
  family: Candidate[];
  error?: string;
};

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

const ORG_PREFIXES = new Set([
  'fal-ai',
  'xai',
  'x-ai',
  'openai',
  'google',
  'anthropic',
  'bytedance',
  'bytedance-seed',
  'z-ai',
  'deepseek',
  'mistralai',
  'meta-llama',
  'qwen',
  'minimax',
]);

/** Modality suffixes that are not part of the version/brand. */
const MODALITY_SUFFIXES =
  /\/(image-to-video|text-to-video|text-to-image|image-to-image|text-to-music|text-to-audio|text-to-speech|speech-to-text|reference-to-video|edit|pro|standard|lite|turbo|master|fast)$/;

/**
 * Leaf path segments that identify a model's modality/role. A candidate is only
 * treated as a successor if it shares the current model's leaf (apples-to-apples:
 * an image-to-video successor, not the same brand's text-to-video or TTS sibling).
 */
const MODALITY_LEAVES = new Set([
  'image-to-video',
  'text-to-video',
  'text-to-image',
  'image-to-image',
  'text-to-music',
  'music',
  'prompt-to-audio',
  'edit',
]);

/** Endpoint flavours that are not the primary base model (LoRA gear, trainers, etc.). */
const VARIANT_DENYLIST = [
  'lora',
  'trainer',
  'distilled',
  'gallery',
  'controlnet',
  'multiple-angles',
  'lighting',
  'remove-element',
  'face-to',
  'integrate-product',
  'add-background',
  'inpaint',
  'outpaint',
  'redux',
];

/** Endpoint ids we already use across every registry — never flag these as "new". */
const ADOPTED_IDS = new Set<string>([
  ...Object.values(IMAGE_MODELS).map((m) => m.id),
  ...Object.values(IMAGE_TO_VIDEO_MODELS).map((m) => m.id),
  ...Object.values(AUDIO_MODELS).map((m) => m.id),
]);

/** The modality leaf of an endpoint id (last path segment), or null if none. */
function modalityLeaf(id: string): string | null {
  const last = id.split('/').pop() ?? '';
  return MODALITY_LEAVES.has(last) ? last : null;
}

/** Pull the first numeric version run (e.g. "3", "2.5", "4.6") from a string. */
function extractVersion(id: string): string | null {
  const stripped = id.replace(MODALITY_SUFFIXES, '');
  const match = stripped.match(/v?(\d+(?:\.\d+)*)/i);
  return match?.[1] ?? null;
}

/** Compare dotted numeric versions. Returns >0 if a is newer than b. */
function compareVersions(a: string | null, b: string | null): number {
  const pa = (a ?? '0').split('.').map(Number);
  const pb = (b ?? '0').split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Derive a free-text search keyword (brand) from an endpoint id.
 * e.g. "fal-ai/kling-video/v3/pro/image-to-video" → "kling video"
 *      "fal-ai/nano-banana-2"                      → "nano banana"
 *      "fal-ai/bytedance/seedance/v1.5/pro/…"      → "seedance"
 */
function brandKeyword(id: string): string {
  const parts = id.split('/');
  let i = 0;
  while (i < parts.length - 1 && ORG_PREFIXES.has(parts[i] ?? '')) i++;
  const seg = parts[i] ?? parts[0] ?? id;
  return seg
    .replace(/-?v?\d+(?:\.\d+)*/gi, '') // drop version tokens
    .replace(/-+/g, ' ')
    .trim();
}

/** First alpha token of the brand, used to filter noisy search results. */
function brandStem(id: string): string {
  return brandKeyword(id).split(' ')[0] ?? '';
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

const USER_AGENT = 'openstory-model-update-checker';

const execFileAsync = promisify(execFile);

/** True when outbound HTTPS is routed through a proxy (agent/CI sandboxes). */
const PROXIED = Boolean(
  process.env.HTTPS_PROXY ??
  process.env.https_proxy ??
  process.env.HTTP_PROXY ??
  process.env.http_proxy
);

async function fetchJsonNative<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const data: T = await res.json();
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonViaCurl<T>(url: string, timeoutMs: number): Promise<T> {
  // -f → non-2xx exits non-zero (mirrors res.ok); -sS → quiet but show errors;
  // -L → follow redirects. curl reads HTTPS_PROXY/NO_PROXY and the system CA
  // bundle itself, which is why it traverses the proxy where Bun's fetch can't.
  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-fsSL',
        '--max-time',
        String(Math.ceil(timeoutMs / 1000)),
        '-H',
        `user-agent: ${USER_AGENT}`,
        url,
      ],
      { timeout: timeoutMs + 2_000, maxBuffer: 64 * 1024 * 1024 }
    );
    const data: T = JSON.parse(stdout);
    return data;
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr).trim()
        : '';
    throw new Error(`curl failed for ${url}${stderr ? `: ${stderr}` : ''}`);
  }
}

/**
 * Fetch + parse JSON. Routes through curl when an HTTPS proxy is configured
 * (Bun's fetch cannot traverse the agent/CI proxy's TLS interception); uses the
 * built-in fetch for direct, proxy-free environments.
 */
async function fetchJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  return PROXIED
    ? fetchJsonViaCurl<T>(url, timeoutMs)
    : fetchJsonNative<T>(url, timeoutMs);
}

type FalCatalogResponse = {
  items?: { id: string; title?: string; category?: string }[];
};

async function falCatalog(
  keyword: string,
  category: string
): Promise<Candidate[]> {
  const url = `https://fal.ai/api/models?keywords=${encodeURIComponent(
    keyword
  )}&category=${encodeURIComponent(category)}&page=1`;
  const data = await fetchJson<FalCatalogResponse>(url);
  return (data.items ?? []).map((i) => ({
    id: i.id,
    title: i.title,
    version: extractVersion(i.id),
  }));
}

// ---------------------------------------------------------------------------
// fal model checks
// ---------------------------------------------------------------------------

async function checkFalModel(
  source: ModelReport['source'],
  key: string,
  currentId: string,
  category: string
): Promise<ModelReport> {
  const currentVersion = extractVersion(currentId);
  const stem = brandStem(currentId);
  try {
    const results = await falCatalog(brandKeyword(currentId), category);
    // Keep same-brand siblings only (avoid unrelated search noise).
    const family = results
      .filter((c) => brandStem(c.id) === stem && c.id !== currentId)
      .sort((a, b) => compareVersions(b.version, a.version));

    const currentLeaf = modalityLeaf(currentId);
    const newer = family.filter((c) => {
      if (compareVersions(c.version, currentVersion) <= 0) return false;
      if (ADOPTED_IDS.has(c.id)) return false; // already used under another key
      if (VARIANT_DENYLIST.some((token) => c.id.includes(token))) return false;
      // Apples-to-apples: a same-role successor, not a cross-modality sibling.
      if (currentLeaf && modalityLeaf(c.id) !== currentLeaf) return false;
      return true;
    });
    return { source, key, currentId, currentVersion, newer, family };
  } catch (error) {
    return {
      source,
      key,
      currentId,
      currentVersion,
      newer: [],
      family: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// OpenRouter text-model checks
// ---------------------------------------------------------------------------

type OpenRouterResponse = { data?: { id: string; name?: string }[] };

/** Family key = prefix-before-version + suffix-after-version (keeps mini/pro/nano distinct). */
function openRouterFamily(id: string): {
  family: string;
  version: string | null;
} {
  const match = id.match(/^(.*?)(\d+(?:\.\d+)*)(.*)$/);
  if (!match) return { family: id, version: null };
  const prefix = match[1] ?? '';
  const version = match[2] ?? null;
  const suffix = match[3] ?? '';
  return { family: `${prefix}|${suffix}`, version };
}

async function checkTextModels(): Promise<ModelReport[]> {
  let catalog: OpenRouterResponse['data'] = [];
  let fetchError: string | undefined;
  try {
    catalog =
      (
        await fetchJson<OpenRouterResponse>(
          'https://openrouter.ai/api/v1/models'
        )
      ).data ?? [];
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
  }

  return SCRIPT_ANALYSIS_MODELS.map((model) => {
    const currentVersion = extractVersion(model.id);
    if (fetchError) {
      return {
        source: 'openrouter' as const,
        key: model.name,
        currentId: model.id,
        currentVersion,
        newer: [],
        family: [],
        error: fetchError,
      };
    }
    const { family: ourFamily } = openRouterFamily(model.id);
    const adoptedTextIds = new Set<string>(
      SCRIPT_ANALYSIS_MODELS.map((m) => m.id)
    );
    const siblings = catalog
      .filter((m) => !m.id.startsWith('~')) // skip "latest" aliases
      .filter((m) => !adoptedTextIds.has(m.id)) // already in our registry
      .filter(
        (m) => openRouterFamily(m.id).family === ourFamily && m.id !== model.id
      )
      .map((m) => ({
        id: m.id,
        title: m.name,
        version: openRouterFamily(m.id).version,
      }))
      .sort((a, b) => compareVersions(b.version, a.version));
    const newer = siblings.filter(
      (c) => compareVersions(c.version, currentVersion) > 0
    );
    return {
      source: 'openrouter' as const,
      key: model.name,
      currentId: model.id,
      currentVersion,
      newer,
      family: siblings,
    };
  });
}

// ---------------------------------------------------------------------------
// BytePlus (Ark) model checks
// ---------------------------------------------------------------------------
// Ark has no public unauthenticated catalog, so the freshness source is the
// installed @tanstack/ai-byteplus adapter's model lists — offline by design.

/**
 * Split an Ark model id into brand / version / tier.
 * Ids follow `[<org>-]<brand>-<major>-<minor>[-<tier>…]-<yymmdd>`, e.g.
 * `dreamina-seedance-2-5-260628` → seedance 2.5 (no tier),
 * `seedance-1-0-pro-fast-251015` → seedance 1.0 `pro-fast`.
 */
function arkParts(id: string): {
  brand: string;
  version: string | null;
  tier: string;
} {
  const match = id.match(/^(.*?)-(\d+)-(\d+)((?:-[a-z]+)*)-\d{6}$/);
  if (!match) return { brand: id, version: null, tier: '' };
  const brandTokens = (match[1] ?? '').split('-');
  return {
    brand: brandTokens[brandTokens.length - 1] ?? '',
    version: `${match[2]}.${match[3]}`,
    tier: (match[4] ?? '').replace(/^-/, ''),
  };
}

function checkBytePlusModels(): ModelReport[] {
  const registry = [
    ...Object.entries(IMAGE_MODELS),
    ...Object.entries(IMAGE_TO_VIDEO_MODELS),
  ].flatMap(([key, m]) =>
    'byteplusId' in m ? [{ key, byteplusId: m.byteplusId }] : []
  );
  const adopted = new Set<string>(registry.map((r) => r.byteplusId));
  const catalog: readonly string[] = [
    ...BYTEPLUS_VIDEO_MODELS,
    ...BYTEPLUS_IMAGE_MODELS,
  ];

  return registry.map(({ key, byteplusId }) => {
    const current = arkParts(byteplusId);
    const family = catalog
      .filter((id) => id !== byteplusId && arkParts(id).brand === current.brand)
      .map((id) => ({ id, version: arkParts(id).version }))
      .sort((a, b) => compareVersions(b.version, a.version));
    // Apples-to-apples: same tier only (a `-fast`/`-mini`/`-pro` sibling is a
    // different product, not a successor).
    const newer = family.filter(
      (c) =>
        compareVersions(c.version, current.version) > 0 &&
        !adopted.has(c.id) &&
        arkParts(c.id).tier === current.tier
    );
    return {
      source: 'byteplus' as const,
      key,
      currentId: byteplusId,
      currentVersion: current.version,
      newer,
      family,
    };
  });
}

// Main
// ---------------------------------------------------------------------------

async function main() {
  const falChecks: Promise<ModelReport>[] = [
    ...Object.entries(IMAGE_MODELS).map(([key, m]) =>
      checkFalModel('fal-image', key, m.id, 'text-to-image')
    ),
    ...Object.entries(IMAGE_TO_VIDEO_MODELS).map(([key, m]) =>
      checkFalModel('fal-video', key, m.id, 'image-to-video')
    ),
    ...Object.entries(AUDIO_MODELS).map(([key, m]) =>
      checkFalModel('fal-audio', key, m.id, 'text-to-music')
    ),
  ];

  const [falReports, textReports] = await Promise.all([
    Promise.all(falChecks),
    checkTextModels(),
  ]);

  const modelReports = [
    ...falReports,
    ...textReports,
    ...checkBytePlusModels(),
  ];
  const modelsWithUpdates = modelReports.filter((r) => r.newer.length > 0);
  const hasUpdates = modelsWithUpdates.length > 0;

  // A failed lookup is NOT "no update". Count failures so neither a human nor
  // automation can read a network/proxy outage as "all models current" — the
  // exact silent false-negative that hid behind `hasUpdates: false` when every
  // fetch errored. `ok: false` ⇒ the report is incomplete; exit non-zero too.
  const errorCount = modelReports.filter((r) => r.error).length;
  const ok = errorCount === 0;
  if (!ok) process.exitCode = 1;

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          ok,
          errorCount,
          hasUpdates,
          models: modelReports,
        },
        null,
        2
      )
    );
    return;
  }

  printReport(modelReports, hasUpdates, errorCount);
}

function printReport(
  modelReports: ModelReport[],
  hasUpdates: boolean,
  errorCount: number
) {
  const SOURCE_LABEL: Record<ModelReport['source'], string> = {
    'fal-image': 'Image (fal.ai)',
    'fal-video': 'Video / motion (fal.ai)',
    'fal-audio': 'Audio (fal.ai)',
    openrouter: 'Text (OpenRouter)',
    byteplus: 'BytePlus Ark (adapter catalog)',
  };

  console.log('\n=== Model freshness report ===\n');

  for (const source of [
    'fal-image',
    'fal-video',
    'fal-audio',
    'openrouter',
    'byteplus',
  ] as const) {
    const group = modelReports.filter((r) => r.source === source);
    console.log(`## ${SOURCE_LABEL[source]}`);
    for (const r of group) {
      if (r.error) {
        console.log(
          `  ⚠️  ${r.key} (${r.currentId}) — lookup failed: ${r.error}`
        );
      } else if (r.newer.length > 0) {
        console.log(
          `  🆕 ${r.key} (${r.currentId}, v${r.currentVersion ?? '?'}) → candidates:`
        );
        for (const c of r.newer) {
          console.log(
            `        ${c.id} (v${c.version ?? '?'})${c.title ? ` — ${c.title}` : ''}`
          );
        }
      } else {
        console.log(`  ✅ ${r.key} (${r.currentId}) — current`);
      }
    }
    console.log('');
  }

  if (errorCount > 0) {
    console.log(
      `\n=== ⚠️  ${errorCount} lookup(s) FAILED — report is INCOMPLETE ===\n` +
        'Do NOT treat this as "all models current". A failed lookup means we could\n' +
        'not check that model, not that it is up to date. Fix connectivity (behind\n' +
        'a proxy this needs `curl` on PATH — see the header) and re-run.\n'
    );
  } else {
    console.log(
      `\n=== ${hasUpdates ? 'UPDATES AVAILABLE — review candidates above' : 'Everything is up to date'} ===\n`
    );
  }
  console.log(
    'Candidates are heuristic (same brand, higher version number). Verify each\n' +
      'is a genuine successor before bumping — see the update-model-versions skill.\n'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
