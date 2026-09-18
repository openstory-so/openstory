/**
 * Client/server import-boundary guard (#1253, #1257).
 *
 * In dev, rolldown-vite serves the browser the transitive import graph with
 * no dead-code elimination — a client-reachable module that imports one pure
 * helper from a server-heavy module ships that module's entire dependency
 * tree. This once put the @tanstack/ai adapter family (~10MB), the Stripe
 * Node SDK, and drizzle-orm/libsql in the browser on every sequence page.
 *
 * The walk starts from client-side roots (UI, routes minus `routes/api`,
 * domain-root catalogs, and `*.fn.ts` — the server-fn stubs the client
 * imports) and fails if any path reaches a server-only module. Two things
 * count as server-only:
 *
 *  1. A `SERVER_ONLY` package specifier (below).
 *  2. Any file under a domain `server/` directory. The per-file half of this
 *     rule is `boundaries/no-server-imports` in `.oxlintrc.json` (the
 *     `@/<domain>/server/` pattern). `*.fn.ts` is exempt from that pattern
 *     because the compiler strips `.handler()`; this walk models that
 *     stripping.
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
 * `.validator(…)` arguments are compiled out the same way.
 *
 * Files the Start compiler does NOT transform (no createServerFn /
 * createMiddleware / … marker) are served verbatim in dev, so every one of
 * their value imports is followed — no DCE is assumed there.
 *
 * If this test fails: don't extend the allowlist — move the offending helper
 * into that domain's `server/` folder, or move the pure part to the domain root.
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
  '@tanstack/ai-gemini',
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

function isClientRootFile(file: string): boolean {
  const rel = file.replace(`${SRC}/`, '');
  if (rel.includes('/server/')) return false;
  if (rel.startsWith('src/mocks/')) return false;
  if (rel === 'src/server.ts' || rel === 'src/instrumentation.ts') return false;
  return true;
}

/** A file under a domain `server/` directory. */
function isServerOnlyFile(file: string): boolean {
  return file.includes('/server/');
}

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
 * `routes/api/**` files never reach the client at all: a route whose only
 * `createFileRoute` option is `server` is pruned out of the client route tree
 * entirely (`start-plugin-core`'s `pruneServerOnlySubtrees`). A route that
 * ALSO has client props keeps its node and instead has `ssr`/`server`/
 * `headers` deleted from the options — the shape handled below. Either way
 * their graphs are not walked here.
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
  /\bcreateServerFn\b|\bcreateMiddleware\b|\bcreateIsomorphicFn\b|\bcreateServerOnlyFn\b|\bcreateFileRoute\b|\.\s*handler\s*\(/;

/** The builders whose `.handler/.server/.validator(…)` the compiler strips. */
const SERVER_FN_BUILDERS = new Set([
  'createServerFn',
  'createMiddleware',
  'createIsomorphicFn',
  'createServerOnlyFn',
]);

/**
 * Does this member expression sit on a server-fn builder chain?
 *
 * The real compiler only strips `.handler/.server/.validator(…)` on chains it
 * has already identified as one of `SERVER_FN_BUILDERS` — so matching on the
 * method NAME alone would also empty an unrelated client-side call (a form's
 * `.validator(…)`, an emitter's `.handler(…)`) and silently DCE away a real
 * leak. `src/shared/mocks/tanstack-start.ts` already contains a plain
 * `builder.handler(handler)`, and every route file matches `COMPILED_RE`, so
 * this is a live shape, not a hypothetical one.
 */
function rootsAtServerFnBuilder(node: Node): boolean {
  let cur: Node = node;
  for (;;) {
    if (cur.type === 'MemberExpression') {
      cur = cur.object;
      continue;
    }
    if (cur.type === 'CallExpression') {
      if (
        cur.callee.type === 'Identifier' &&
        SERVER_FN_BUILDERS.has(cur.callee.name)
      ) {
        return true;
      }
      cur = cur.callee;
      continue;
    }
    return false;
  }
}

/**
 * The value imports of a module as the CLIENT receives it in dev.
 *
 * For compiler-transformed modules this replays the compiler's client pass
 * with its own primitives: `.handler(…)` / `.server(…)` arguments are
 * emptied (the compiler substitutes RPC stubs for handlers and removes
 * middleware server phases), a route file's `server: { handlers }` option is
 * dropped the same way, then `deadCodeElimination` — the same
 * babel-dead-code-elimination the Start plugin runs — removes declarations
 * and imports nothing references any more. Everything else is returned
 * verbatim. Only a TOP-LEVEL `import type` is skipped; the inline
 * `import { type X } from 'y'` form leaves a side-effect import and IS
 * followed (see the import handling below).
 *
 * Dynamic `import()` keeps a module out of the eager graph, but it is not a
 * free pass: `boundaries/no-server-imports` matches it too, so using it against
 * `@/lib/**` from a client file still needs an explicit `oxlint-disable`.
 */
export function clientRetainedImports(source: string): string[] {
  const ast = parseAst({ code: source });

  if (COMPILED_RE.test(source)) {
    // parseAst and babel-dead-code-elimination resolve different @babel/parser
    // copies; TS 7 hits excessive stack depth comparing the File types.
    const referenced = findReferencedIdentifiers(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- duplicate @babel/parser File types
      ast as Parameters<typeof findReferencedIdentifiers>[0]
    );
    for (const node of walkAst(ast.program)) {
      if (node.type !== 'CallExpression') continue;
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.property.type === 'Identifier' &&
        (node.callee.property.name === 'handler' ||
          node.callee.property.name === 'server' ||
          node.callee.property.name === 'validator') &&
        rootsAtServerFnBuilder(node.callee.object)
      ) {
        node.arguments = [];
      }
      // createFileRoute('/x')({ server: { handlers } , ...}) — the compiler
      // strips the `server` option from the client build.
      const options = node.arguments[0];
      if (
        node.callee.type === 'CallExpression' &&
        node.callee.callee.type === 'Identifier' &&
        node.callee.callee.name === 'createFileRoute' &&
        options?.type === 'ObjectExpression'
      ) {
        options.properties = options.properties.filter(
          (p) =>
            !(
              p.type === 'ObjectProperty' &&
              p.key.type === 'Identifier' &&
              p.key.name === 'server'
            )
        );
      }
    }
    deadCodeElimination(ast, referenced);
  }

  const specs: string[] = [];
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') {
      // Only the TOP-LEVEL `import type` form is erased. Under
      // `verbatimModuleSyntax` (tsconfig.json), an all-inline-type
      // `import { type X } from 'y'` compiles to `import {} from 'y'` — a
      // side-effect import that keeps y's whole graph — so every declaration
      // that is not `import type` leaves a runtime edge and is followed.
      // `typescript/no-import-type-side-effects` bans that form outright;
      // this is the transitive half of the same rule.
      if (node.importKind === 'type') continue;
      specs.push(node.source.value);
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

    test('a validator-only import is dropped', () => {
      const specs = clientRetainedImports(`
        import { inputSchema } from '@/lib/schemas/input';
        import { createServerFn } from '@tanstack/react-start';
        export const fn = createServerFn().validator(inputSchema).handler(() => 1);
      `);
      expect(specs).not.toContain('@/lib/schemas/input');
    });

    test("a route file's server handlers are dropped — the r2.$ shape", () => {
      const specs = clientRetainedImports(`
        import { createFileRoute } from '@tanstack/react-router';
        import { serve } from '@/platform/server/storage/serve-media';
        export const Route = createFileRoute('/r2/$')({
          server: { handlers: { GET: ({ params }) => serve(params) } },
        });
      `);
      expect(specs).not.toContain('@/platform/server/storage/serve-media');
      expect(specs).toContain('@tanstack/react-router');
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

    test('an all-inline-type import IS followed — it leaves a side effect', () => {
      // `import { type X } from 'y'` compiles to `import {} from 'y'` under
      // verbatimModuleSyntax, keeping y's whole graph. Treating it as free
      // shipped drizzle-orm + 4 db/schema modules to the browser (#1445).
      const specs = clientRetainedImports(`
        import { type Only } from '@srv/inline-type';
        export const x = 1;
      `);
      expect(specs).toContain('@srv/inline-type');
    });

    test('an unrelated .handler()/.validator() call does not disarm the file', () => {
      // Matching the method NAME alone would empty these arguments and DCE
      // the server-only imports away, silently blinding the whole file.
      const specs = clientRetainedImports(`
        import { createFileRoute } from '@tanstack/react-router';
        import { schema } from '@/platform/server/db/schema';
        import { emitter } from '@srv/emitter';
        function Page() {
          emitter.handler(() => 1);
          return useForm().validator(schema);
        }
        export const Route = createFileRoute('/x')({ component: Page });
      `);
      expect(specs).toContain('@/platform/server/db/schema');
      expect(specs).toContain('@srv/emitter');
    });

    test('createIsomorphicFn .server() import is dropped — the #1354 shape', () => {
      const specs = clientRetainedImports(`
        import { getPostHogClient } from '@/platform/server/observability/posthog-server';
        import { createIsomorphicFn } from '@tanstack/react-start';
        export const capture = createIsomorphicFn()
          .client(() => {})
          .server((p) => { getPostHogClient()?.capture(p); });
      `);
      expect(specs).not.toContain(
        '@/platform/server/observability/posthog-server'
      );
      expect(specs).toContain('@tanstack/react-start');
    });

    test('billing-observability does not retain posthog-server on the client', () => {
      const source = readFileSync(
        join(SRC, 'src/billing/billing-observability.ts'),
        'utf8'
      );
      expect(clientRetainedImports(source)).not.toContain(
        '@/platform/server/observability/posthog-server'
      );
    });
  });

  test('the lint rule does not punch holes in the server/ import ban', () => {
    const raw = readFileSync(join(SRC, '.oxlintrc.json'), 'utf8');
    const holes = raw.match(/"!@\/[^"]*server[^"]*"/g) ?? [];
    expect(holes).toEqual([]);
  });

  // Walks every client-reachable file synchronously, so it runs 5-9s and
  // tripped the 5s default whenever it shared a worker with other suites.
  test('no server-only module is reachable from client components/hooks/routes/functions', () => {
    const visited = new Set<string>();
    // file → the import edge that got us there, for a readable failure trail.
    const cameFrom = new Map<string, string>();
    const queue: string[] = [];
    for (const f of walkFiles(join(SRC, 'src'))) {
      if (!isServerRoute(f) && isClientRootFile(f)) queue.push(f);
    }

    const trailTo = (file: string): string[] => {
      const trail: string[] = [file.replace(`${SRC}/`, '')];
      for (let at = file; cameFrom.has(at);) {
        const prev = cameFrom.get(at);
        if (prev === undefined) break;
        trail.unshift(prev.replace(`${SRC}/`, ''));
        at = prev;
      }
      return trail;
    };

    const violations: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop();
      if (!file || visited.has(file)) continue;
      visited.add(file);

      for (const spec of clientRetainedImports(readFileSync(file, 'utf8'))) {
        if (isServerOnly(spec)) {
          violations.push(`${trailTo(file).join('\n    → ')}\n    → "${spec}"`);
          continue;
        }
        const target = resolveLocal(file, spec);
        if (!target || visited.has(target) || isServerRoute(target)) continue;
        cameFrom.set(target, file);
        if (isServerOnlyFile(target)) {
          violations.push(`${trailTo(file).join('\n    → ')}\n    → "${spec}"`);
          continue;
        }
        queue.push(target);
      }
    }

    expect(
      violations,
      `Server-only imports reachable from client code:\n\n${violations.join('\n\n')}\n\nMove the client-safe part to the domain root, or keep the server-side helper under src/**/server/** and reference it only from *.fn.ts handler bodies — do not punch a hole in the @/**/server/** lint pattern.`
    ).toEqual([]);
  }, 30_000);
});
