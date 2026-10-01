/**
 * Wiring consistency checks for Cloudflare Workflows.
 *
 * Every workflow needs entries in three places:
 *
 *   1. `wrangler.jsonc` workflows[]   — declares the runtime binding so
 *                                       miniflare/CF actually creates it
 *   2. `src/server.ts` re-export      — keeps the class in the Worker bundle
 *   3. `src/platform/server/workflow/trigger-bindings.ts` `TRIGGER_TO_BINDING`
 *                                     — maps the trigger path that
 *                                       `triggerWorkflow('/foo', ...)` uses
 *                                       to the env binding name
 *
 * Missing any one of these silently breaks the workflow:
 *   - wrangler.jsonc missing → "env binding is missing or not a Workflow"
 *   - server.ts missing → wrangler can't find the class on deploy
 *   - trigger map missing → "no workflow binding mapped for trigger path"
 *
 * (TypeScript's view of the bindings is generated from wrangler.jsonc by
 * `bun cf:typegen` into `worker-configuration.d.ts`, so a missing binding
 * also fails `bun typecheck` on the `this.env.X` access — no hand-written
 * declaration to keep in sync.)
 *
 * These tests fail loudly the next time someone adds a workflow and forgets
 * one of the three steps.
 *
 * Plus one structural check on instance IDs: every output of `buildInstanceId`
 * must match CF's `^[a-zA-Z0-9_-]+$` rule.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildInstanceId } from '@/platform/server/workflow/instance-id';

const WRANGLER_PATH = 'wrangler.jsonc';
const SERVER_PATH = 'src/server.ts';
const TRIGGER_BINDINGS_PATH =
  'src/platform/server/workflow/trigger-bindings.ts';

type WranglerWorkflowEntry = {
  name: string;
  binding: string;
  class_name: string;
};

function captureAll(text: string, regex: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(regex)) {
    const captured = m[1];
    if (captured) out.push(captured);
  }
  return out;
}

function parseWranglerWorkflows(): WranglerWorkflowEntry[] {
  // wrangler.jsonc uses JSONC (comments + trailing commas + unquoted keys
  // sometimes). Skip a real parser and regex out the workflow entries —
  // they follow a strict shape:
  //   { "name": "...", "binding": "...", "class_name": "..." }
  const text = readFileSync(WRANGLER_PATH, 'utf8');
  const block = text.match(/"workflows"\s*:\s*\[([\s\S]*?)\]/);
  const inner = block?.[1];
  if (!inner) return [];
  const entries: WranglerWorkflowEntry[] = [];
  const entryRegex =
    /"name"\s*:\s*"([^"]+)"\s*,\s*"binding"\s*:\s*"([^"]+)"\s*,\s*"class_name"\s*:\s*"([^"]+)"/g;
  for (const m of inner.matchAll(entryRegex)) {
    if (m[1] && m[2] && m[3]) {
      entries.push({ name: m[1], binding: m[2], class_name: m[3] });
    }
  }
  return entries;
}

function parseAllWranglerWorkflowBlocks(): WranglerWorkflowEntry[][] {
  // There are three `workflows[]` arrays: the top-level (local dev) block plus
  // one each inside [env.production] and [env.test]. Wrangler does NOT inherit
  // bindings across env blocks, so all three must be kept in lockstep — a
  // missing entry in an env block is exactly what broke STORYBOARD_WORKFLOW in
  // the full-pipeline e2e (which runs under CLOUDFLARE_ENV=test).
  const text = readFileSync(WRANGLER_PATH, 'utf8');
  const blocks: WranglerWorkflowEntry[][] = [];
  const entryRegex =
    /"name"\s*:\s*"([^"]+)"\s*,\s*"binding"\s*:\s*"([^"]+)"\s*,\s*"class_name"\s*:\s*"([^"]+)"/g;
  for (const blockMatch of text.matchAll(/"workflows"\s*:\s*\[([\s\S]*?)\]/g)) {
    const inner = blockMatch[1] ?? '';
    const entries: WranglerWorkflowEntry[] = [];
    for (const m of inner.matchAll(entryRegex)) {
      if (m[1] && m[2] && m[3]) {
        entries.push({ name: m[1], binding: m[2], class_name: m[3] });
      }
    }
    blocks.push(entries);
  }
  return blocks;
}

function extractTriggerMapValues(): Set<string> {
  const text = readFileSync(TRIGGER_BINDINGS_PATH, 'utf8');
  const block = text.match(/TRIGGER_TO_BINDING[^=]*=\s*\{([\s\S]*?)\};/);
  const inner = block?.[1];
  if (!inner) {
    throw new Error(
      'Could not find TRIGGER_TO_BINDING block in trigger-bindings.ts'
    );
  }
  return new Set(captureAll(inner, /'([A-Z][A-Z0-9_]+)'/g));
}

function extractServerExports(): Set<string> {
  const text = readFileSync(SERVER_PATH, 'utf8');
  // `export { ClassName } from '@/<domain>/server/workflows/...';`
  return new Set(
    captureAll(
      text,
      /export\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*['"]@\/[^'"]*\/server\/workflows\//g
    )
  );
}

describe('CF workflow wiring is consistent across all three declaration sites', () => {
  const wranglerWorkflows = parseWranglerWorkflows();
  const wranglerBindings = new Set(wranglerWorkflows.map((w) => w.binding));
  const wranglerClasses = new Set(wranglerWorkflows.map((w) => w.class_name));
  const triggerMapBindings = extractTriggerMapValues();
  const serverExports = extractServerExports();

  test('every wrangler binding has a matching server.ts re-export of its class', () => {
    const missing = wranglerWorkflows.filter(
      (w) => !serverExports.has(w.class_name)
    );
    expect(missing.map((w) => w.class_name)).toEqual([]);
  });

  test('every binding referenced by TRIGGER_TO_BINDING exists in wrangler.jsonc', () => {
    const missing = [...triggerMapBindings].filter(
      (b) => !wranglerBindings.has(b)
    );
    // Surface the actual missing binding names in the failure for fast fixup.
    expect(missing).toEqual([]);
  });

  test('every wrangler binding has either a TRIGGER_TO_BINDING entry or a comment-tracked exemption', () => {
    // Some bindings may legitimately not have a trigger path (e.g. only
    // invoked as Pattern 3 children from other workflows). For now, every
    // binding in wrangler.jsonc should also exist in the trigger map —
    // none of our ports are children-only today.
    const unrouted = [...wranglerBindings].filter(
      (b) => !triggerMapBindings.has(b)
    );
    expect(unrouted).toEqual([]);
  });

  test('every server.ts CF re-export has a matching wrangler workflow entry', () => {
    const orphaned = [...serverExports].filter(
      (cls) => !wranglerClasses.has(cls)
    );
    expect(orphaned).toEqual([]);
  });

  test('all three wrangler workflow blocks (default, production, test) declare identical bindings', () => {
    const blocks = parseAllWranglerWorkflowBlocks();
    // Default + [env.production] + [env.test]. If this ever drops below three,
    // an env block lost its workflows[] (bindings are non-inheritable).
    expect(blocks.length).toBe(3);
    const fingerprint = (entries: WranglerWorkflowEntry[]) =>
      entries
        .map((e) => `${e.name}|${e.binding}|${e.class_name}`)
        .sort()
        .join('\n');
    const [defaultBlock, ...envBlocks] = blocks;
    const expected = fingerprint(defaultBlock ?? []);
    for (const block of envBlocks) {
      expect(fingerprint(block)).toBe(expected);
    }
  });
});

describe('Pattern 3 childIds are CF-valid after sanitization', () => {
  // Mirror of the sanitizer inside spawnAndAwaitChild (private). If the
  // helper's sanitization regex ever changes, update this duplicate.
  const sanitize = (raw: string): string =>
    raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100);
  const CF_VALID = /^[a-zA-Z0-9_-]+$/;

  // Catch the historical "colons in childId crash CF" footgun by sampling
  // the actual childId shapes our codebase passes.
  const realCallsiteIds = [
    'image:seq-123:shot-7',
    'image:seq-123:shot-7:nano_banana_2',
    'motion:seq-123:shot-7',
    'analyze-script:01KS23834FEGDBN8074VVPR3Q8',
    'character-sheet:recast:01KS23',
    'regenerate-shots:character:01KS23',
    'music-prompt:01KS23',
    'shot-spec-rewrite:01KS23',
  ];

  for (const id of realCallsiteIds) {
    test(`childId ${id} sanitizes to a CF-valid ID`, () => {
      const sanitized = sanitize(id);
      expect(sanitized).toMatch(CF_VALID);
      expect(sanitized.length).toBeLessThanOrEqual(100);
    });
  }
});

describe('buildInstanceId always emits CF-valid IDs', () => {
  const CF_VALID = /^[a-zA-Z0-9_-]+$/;

  const cases: Array<{ env: string; suffix: string }> = [
    { env: 'https://openstory.so', suffix: '01KS23834FEGDBN8074VVPR3Q8' },
    { env: 'https://pr-42.openstory.dev', suffix: 'seq-123:shot.7' },
    { env: '', suffix: 'a/b/c*d e' },
    { env: 'https://openstory.so', suffix: 'image:seq-123:shot-7:variant.0' },
  ];

  for (const { env, suffix } of cases) {
    test(`env=${env || 'unset'} suffix=${suffix}`, () => {
      const id = buildInstanceId({
        env: { VITE_APP_URL: env || undefined },
        workflowName: 'image',
        suffix,
      });
      expect(id).toMatch(CF_VALID);
      expect(id.length).toBeLessThanOrEqual(100);
    });
  }
});
