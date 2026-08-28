/**
 * Client/server import-boundary guard (#1253, #1257).
 *
 * In dev, rolldown-vite serves the browser the transitive import graph with
 * no dead-code elimination — a client-reachable module that imports one pure
 * helper from a server-heavy module ships that module's entire dependency
 * tree. This once put the @tanstack/ai adapter family (~10MB), the Stripe
 * Node SDK, and drizzle-orm/libsql in the browser on every sequence page.
 *
 * The walk starts from the client-side roots (`src/components`, `src/hooks`,
 * and `src/functions` — the RPC surface the client imports for its stubs) and
 * fails if any path reaches a server-only module.
 *
 * Server fn / middleware files are walked THE WAY THE START COMPILER SHIPS
 * THEM (#1257), using the compiler's own building blocks from
 * `@tanstack/router-utils`: `.handler(…)` / `.server(…)` arguments are
 * compiled out of the client bundle, and `deadCodeElimination` then drops
 * now-unreferenced private declarations and imports. What survives — and
 * therefore ships — is anything still referenced from module level or an
 * EXPORTED helper. That is exactly why heavy server logic must live in
 * `src/lib/**` and be referenced ONLY inside handler bodies: an exported
 * helper in a `functions/` file ships its whole graph to the browser.
 * (The model errs conservative in one spot: the real compiler also strips
 * `.validator(…)` schemas client-side; this walk keeps them.)
 *
 * Files the Start compiler does NOT transform (no createServerFn /
 * createMiddleware / … marker) are served verbatim in dev, so every one of
 * their value imports is followed — no DCE is assumed there.
 *
 * If this test fails: don't extend the allowlist — move the offending helper
 * out of the `functions/` file into a server-side `src/lib/**` module (see
 * `src/lib/ai/script-enhancement.ts`), or move the pure part you need into a
 * client-safe module (see `src/lib/motion/snap-duration.ts`).
 */

import type { Node } from '@babel/types';
import {
  deadCodeElimination,
  findReferencedIdentifiers,
  parseAst,
} from '@tanstack/router-utils';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC = resolve(__dirname, '..', '..');

/** Bare specifiers (or prefixes) that must never be reachable from client code. */
const SERVER_ONLY = [
  'stripe',
  '#db-client',
  '#storage',
  '@tanstack/ai', // core: chat orchestrator + otel middleware — server-side only
  '@tanstack/ai-openrouter',
  '@tanstack/ai-grok',
  '@tanstack/ai-byteplus',
  '@tanstack/ai-fal',
  '@opentelemetry/',
  '@libsql/',
  'drizzle-orm/libsql',
  'better-auth', // server package; client-safe subpaths are allowlisted below
  'cloudflare:workers',
];
// `#env` is deliberately NOT listed: client modules import it today and the
// browser build resolves it to a runtime shim with no baked-in secrets.

/** Client-side entry points of packages whose root is server-only. */
const CLIENT_SAFE = ['better-auth/client', 'better-auth/react'];

const CLIENT_ROOTS = ['src/components', 'src/hooks', 'src/functions'];

function isServerOnly(spec: string): boolean {
  if (CLIENT_SAFE.some((s) => spec === s || spec.startsWith(`${s}/`))) {
    return false;
  }
  return SERVER_ONLY.some(
    (s) => spec === s || spec.startsWith(s.endsWith('/') ? s : `${s}/`)
  );
}

function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null; // bare specifier — checked against SERVER_ONLY, not walked
  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * `routes/api/**` files reach the client only through the generated
 * routeTree, where the Start compiler strips their `server.handlers` the same
 * way it strips server-fn handlers — their graphs are not walked here.
 */
function isServerRoute(file: string): boolean {
  return file.includes('/routes/api/');
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(p);
    else if (/\.tsx?$/.test(p) && !/\.(test|spec|stories)\./.test(p)) yield p;
  }
}

function isAstNode(value: object): value is Node {
  return 'type' in value && typeof value.type === 'string';
}

/** Recursively collect nodes, no @babel/traverse needed. */
function* walkAst(value: unknown): Generator<Node> {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) yield* walkAst(item);
    return;
  }
  if (!isAstNode(value)) return;
  yield value;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'loc' ||
      key === 'leadingComments' ||
      key === 'trailingComments'
    ) {
      continue;
    }
    yield* walkAst(child);
  }
}

/**
 * Does the Start compiler transform this module for the client? Mirrors the
 * plugin's own source-text detection. Untransformed modules are served
 * verbatim by vite dev, so no stripping or DCE may be assumed for them.
 */
const COMPILED_RE =
  /\bcreateServerFn\b|\bcreateMiddleware\b|\bcreateIsomorphicFn\b|\bcreateServerOnlyFn\b|\.\s*handler\s*\(/;

/**
 * The value imports of a module as the CLIENT receives it in dev.
 *
 * For compiler-transformed modules this replays the compiler's client pass
 * with its own primitives: `.handler(…)` / `.server(…)` arguments are
 * emptied (the compiler substitutes RPC stubs for handlers and removes
 * middleware server phases), then `deadCodeElimination` — the same
 * babel-dead-code-elimination the Start plugin runs — removes declarations
 * and imports nothing references any more. Everything else is returned
 * verbatim. Type-only imports pull no runtime dependency and are skipped.
 * Dynamic `import()` is the sanctioned escape hatch for genuinely shared
 * modules — Vite loads it lazily, so it never ships unless executed.
 */
export function clientRetainedImports(source: string): string[] {
  const ast = parseAst({ code: source });

  if (COMPILED_RE.test(source)) {
    const referenced = findReferencedIdentifiers(ast);
    for (const node of walkAst(ast.program)) {
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        node.callee.property.type === 'Identifier' &&
        (node.callee.property.name === 'handler' ||
          node.callee.property.name === 'server')
      ) {
        node.arguments = [];
      }
    }
    deadCodeElimination(ast, referenced);
  }

  const specs: string[] = [];
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') {
      if (node.importKind === 'type') continue;
      const hasValueBinding =
        node.specifiers.length === 0 || // side-effect import
        node.specifiers.some(
          (s) => s.type !== 'ImportSpecifier' || s.importKind !== 'type'
        );
      if (hasValueBinding) specs.push(node.source.value);
      continue;
    }
    // Value re-exports (`export … from 'x'`) always survive the transform.
    if (
      (node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source &&
      node.exportKind !== 'type'
    ) {
      specs.push(node.source.value);
    }
  }
  return specs;
}

describe('client/server import boundary', () => {
  // The repo walk below can only catch the model being too strict (a leak it
  // wrongly reports). These cases pin the opposite direction — the one a
  // regression would silently disarm: imports that MUST be treated as
  // shipping to the client.
  describe('clientRetainedImports', () => {
    test('an exported helper keeps its import — the #1257 leak shape', () => {
      const specs = clientRetainedImports(`
        import { secret } from '@srv/secret';
        import { createServerFn } from '@tanstack/react-start';
        export function leak() { return secret(); }
        export const fn = createServerFn().handler(() => leak());
      `);
      expect(specs).toContain('@srv/secret');
    });

    test('a handler-only import is dropped, via a private helper too', () => {
      const specs = clientRetainedImports(`
        import { getAuth } from '@srv/auth';
        import { createMiddleware } from '@tanstack/react-start';
        async function resolveSession() { return getAuth(); }
        export const mw = createMiddleware().server(async () => resolveSession());
      `);
      expect(specs).not.toContain('@srv/auth');
      expect(specs).toContain('@tanstack/react-start');
    });

    test('side-effect imports and value re-exports always survive', () => {
      const specs = clientRetainedImports(`
        import '@srv/polyfill';
        export { widget } from '@srv/widgets';
        import { createServerFn } from '@tanstack/react-start';
        export const fn = createServerFn().handler(() => 1);
      `);
      expect(specs).toContain('@srv/polyfill');
      expect(specs).toContain('@srv/widgets');
    });

    test('an untransformed module keeps every value import verbatim', () => {
      const specs = clientRetainedImports(`
        import { unused } from '@srv/unused';
        export const plain = 1;
      `);
      expect(specs).toContain('@srv/unused');
    });

    test('type-only imports are never followed', () => {
      const specs = clientRetainedImports(`
        import type { T } from '@srv/types';
        import { type U, real } from '@srv/mixed';
        export const use = () => real();
      `);
      expect(specs).not.toContain('@srv/types');
      expect(specs).toContain('@srv/mixed');
    });

    test('createIsomorphicFn .server() import is dropped — the #1354 shape', () => {
      const specs = clientRetainedImports(`
        import { getPostHogClient } from '@/lib/posthog-server';
        import { createIsomorphicFn } from '@tanstack/react-start';
        export const capture = createIsomorphicFn()
          .client(() => {})
          .server((p) => { getPostHogClient()?.capture(p); });
      `);
      expect(specs).not.toContain('@/lib/posthog-server');
      expect(specs).toContain('@tanstack/react-start');
    });

    test('billing-observability does not retain posthog-server on the client', () => {
      const source = readFileSync(
        join(SRC, 'src/lib/billing/billing-observability.ts'),
        'utf8'
      );
      expect(clientRetainedImports(source)).not.toContain(
        '@/lib/posthog-server'
      );
    });
  });

  test('no server-only module is reachable from client components/hooks/functions', () => {
    const visited = new Set<string>();
    // file → the import edge that got us there, for a readable failure trail.
    const cameFrom = new Map<string, string>();
    const queue: string[] = [];
    for (const root of CLIENT_ROOTS) {
      for (const f of walkFiles(join(SRC, root))) queue.push(f);
    }

    const violations: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop();
      if (!file || visited.has(file)) continue;
      visited.add(file);

      for (const spec of clientRetainedImports(readFileSync(file, 'utf8'))) {
        if (isServerOnly(spec)) {
          const trail: string[] = [file.replace(`${SRC}/`, '')];
          for (let at = file; cameFrom.has(at);) {
            const prev = cameFrom.get(at);
            if (prev === undefined) break;
            trail.unshift(prev.replace(`${SRC}/`, ''));
            at = prev;
          }
          violations.push(`${trail.join('\n    → ')}\n    → "${spec}"`);
          continue;
        }
        const target = resolveLocal(file, spec);
        if (!target || visited.has(target) || isServerRoute(target)) continue;
        cameFrom.set(target, file);
        queue.push(target);
      }
    }

    expect(
      violations,
      `Server-only imports reachable from client code:\n\n${violations.join('\n\n')}\n\nMove the offending helper into a server-side src/lib module (referenced only from handler bodies) instead of widening this list.`
    ).toEqual([]);
  });
});
