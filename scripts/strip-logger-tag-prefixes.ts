#!/usr/bin/env bun
/**
 * Strip `[Tag]` / `[Tag:foo]` prefixes from the first string arg of
 * `logger.{info,warn,error,debug}(...)` calls. The category path already
 * encodes this information, so the prefix is redundant noise.
 *
 * Conservative: only touches plain string literals and simple template
 * literals whose head starts with a `[Tag]` prefix. Leaves complex cases
 * for human review.
 *
 * Examples:
 *   logger.error('[AuthForm] Send OTP failed', { err })
 *     -> logger.error('Send OTP failed', { err })
 *   logger.warn(`[Workflow:${name}] failed`, { err })
 *     -> logger.warn(`failed`, { err }) when the prefix fully occupies the head
 *
 * Implementation note: TypeScript 7 removed the classic `typescript` compiler
 * API from the package entrypoint, so this codemod uses a targeted regex walk
 * instead of the TS AST.
 */

import { glob, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

const SKIP_FILE_RE =
  /(\.test\.ts|\.spec\.ts|\.stories\.tsx|\.gen\.ts|\/lib\/observability\/logger\.ts|\/lib\/mocks\/)/;

// logger.<method>( <quote-or-backtick> [Tag...] remainder
// Captures: 1=prefix through open paren, 2=quote style, 3=tag body, 4=rest of
// first arg up to the matching closer (non-greedy, no unescaped closer).
const LOGGER_PREFIX_RE =
  /(\blogger\.(?:info|warn|error|debug)\s*\(\s*)(['"`])\s*\[([^\]]+)\]\s*/g;

type Patch = { start: number; end: number; replacement: string };

function escapeSingle(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeDouble(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeBacktick(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

/**
 * Find the end of a string/template literal starting at `openQuoteIndex`
 * (the quote character). Returns the index of the closing quote, or -1.
 */
function findStringEnd(
  source: string,
  openQuoteIndex: number,
  quote: string
): number {
  let i = openQuoteIndex + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      // Skip ${...} expression (naive brace depth)
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') depth -= 1;
        i += 1;
      }
      continue;
    }
    if (ch === quote) return i;
    i += 1;
  }
  return -1;
}

function processSource(source: string): { out: string; patches: number } {
  const patches: Patch[] = [];
  LOGGER_PREFIX_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = LOGGER_PREFIX_RE.exec(source)) !== null) {
    const fullStart = match.index;
    const callPrefix = match[1];
    const quote = match[2];
    if (callPrefix === undefined || quote === undefined) continue;
    // Position of the opening quote in the source
    const openQuoteIndex = fullStart + callPrefix.length;
    const closeQuoteIndex = findStringEnd(source, openQuoteIndex, quote);
    if (closeQuoteIndex < 0) continue;

    // Content between quotes, with the [Tag] prefix already matched by the regex
    const afterTagStart = match.index + match[0].length;
    const rest = source.slice(afterTagStart, closeQuoteIndex);
    const stripped = rest.trim();
    if (stripped.length === 0) continue;

    // If the tag contained `${` it may be an interpolating head like
    // `[Workflow:${name}] failed` — rest is then `failed` after the `]` was
    // consumed by the regex. That's the intended strip. If the remainder still
    // starts with `[`, leave it alone (nested/weird).
    if (stripped.startsWith('[')) continue;

    let literal: string;
    if (quote === "'") literal = `'${escapeSingle(stripped)}'`;
    else if (quote === '"') literal = `"${escapeDouble(stripped)}"`;
    else literal = `\`${escapeBacktick(stripped)}\``;

    patches.push({
      start: openQuoteIndex,
      end: closeQuoteIndex + 1,
      replacement: literal,
    });

    // Advance past this match so we don't re-scan the replacement region
    LOGGER_PREFIX_RE.lastIndex = closeQuoteIndex + 1;
  }

  if (patches.length === 0) return { out: source, patches: 0 };

  let out = source;
  patches.sort((a, b) => b.start - a.start);
  for (const p of patches) {
    out = out.slice(0, p.start) + p.replacement + out.slice(p.end);
  }
  return { out, patches: patches.length };
}

async function processFile(filePath: string): Promise<number> {
  const source = await readFile(filePath, 'utf8');
  const { out, patches } = processSource(source);
  if (patches === 0) return 0;
  await writeFile(filePath, out, 'utf8');
  return patches;
}

async function main(): Promise<void> {
  let totalFiles = 0;
  let totalPatches = 0;

  for await (const entry of glob('**/*.{ts,tsx}', { cwd: SRC })) {
    const filePath = path.isAbsolute(entry) ? entry : path.join(SRC, entry);
    if (SKIP_FILE_RE.test(filePath)) continue;

    const n = await processFile(filePath);
    if (n === 0) continue;
    totalFiles += 1;
    totalPatches += n;
    process.stdout.write(`${path.relative(ROOT, filePath)}: ${n}\n`);
  }
  process.stdout.write(
    `\nStripped ${totalPatches} prefix${totalPatches === 1 ? '' : 'es'} across ${totalFiles} file${totalFiles === 1 ? '' : 's'}.\n`
  );
}

await main();
