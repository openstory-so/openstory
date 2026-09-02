/**
 * Guards the `bun motion:codegen` invocation (#1444).
 *
 * `@hey-api/openapi-ts` is pinned to a nightly with no typescript runtime
 * dep, because this repo is on TypeScript 7 (no JS compiler API). An
 * `npx -p @hey-api/openapi-ts` call builds an isolated prefix from
 * registry-latest and ignores that pin, so the TS 7 workaround is the old
 * `typescript@5.9.2` sidecar instead of the pin. Cheap source reads, same
 * pattern as wiring-consistency.test.ts.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SCRIPT_PATH = 'scripts/pull-motion-schemas.ts';
const PACKAGE_JSON_PATH = 'package.json';
const OPENAPI_TS_BIN = join('node_modules', '.bin', 'openapi-ts');
const OPENAPI_TS_PKG = join(
  'node_modules',
  '@hey-api',
  'openapi-ts',
  'package.json'
);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  return record;
}

function readJsonObject(path: string): Record<string, unknown> {
  return asObject(JSON.parse(readFileSync(path, 'utf8')), path);
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new Error(`${key} is not a string`);
  }
  return value;
}

describe('motion codegen uses the pinned openapi-ts', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8');
  const code = stripComments(source);
  const pinned = stringField(
    asObject(
      readJsonObject(PACKAGE_JSON_PATH).devDependencies,
      'package.json devDependencies'
    ),
    '@hey-api/openapi-ts'
  );

  test('package.json pins a typescript-free nightly', () => {
    expect(pinned).toMatch(/^0\.0\.0-next-/);
  });

  test('does not npx -p an isolated @hey-api/openapi-ts (that fetches registry latest)', () => {
    expect(code).not.toMatch(/\bnpx\b/);
    expect(code).not.toMatch(/typescript@5/);
  });

  test('invokes the workspace node_modules/.bin/openapi-ts', () => {
    expect(code).toMatch(/node_modules/);
    expect(code).toMatch(/['"]\.bin['"]/);
    expect(code).toMatch(/['"]openapi-ts['"]/);
  });

  test('the installed binary is the pinned nightly', () => {
    expect(existsSync(OPENAPI_TS_BIN)).toBe(true);
    expect(existsSync(OPENAPI_TS_PKG)).toBe(true);
    expect(stringField(readJsonObject(OPENAPI_TS_PKG), 'version')).toBe(pinned);
    expect(realpathSync(OPENAPI_TS_BIN)).toContain(
      join('@hey-api', 'openapi-ts')
    );
  });
});
