import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  rejectRegeneratedWorkerTypes,
  RUNTIME_TYPES_MARKER,
} from './regen-worker-types';

const REPO_ROOT = join(import.meta.dirname, '..');

function runtimeFile(lines: number): string {
  const body = Array.from(
    { length: lines },
    (_, i) => `declare const n${i}: number;`
  );
  return `/* eslint-disable */\n${RUNTIME_TYPES_MARKER}\n${body.join('\n')}\n`;
}

describe('rejectRegeneratedWorkerTypes', () => {
  it('accepts an unchanged file', () => {
    const text = runtimeFile(100);
    expect(rejectRegeneratedWorkerTypes(text, text)).toBeNull();
  });

  it('rejects env-only output', () => {
    const committed = runtimeFile(400);
    const next = 'interface Env { DB: D1Database; }\n';
    expect(rejectRegeneratedWorkerTypes(committed, next)).toMatch(
      /no "\/\/ Begin runtime types"/
    );
  });

  it('rejects a runtime section that declares nothing', () => {
    const committed = runtimeFile(400);
    const next = `${RUNTIME_TYPES_MARKER}\n<p>parked</p>\n`;
    expect(rejectRegeneratedWorkerTypes(committed, next)).toMatch(
      /no declarations/
    );
  });

  it('rejects HTML even when the file is long enough', () => {
    const committed = runtimeFile(100);
    const next = `${runtimeFile(100)}<!DOCTYPE html>\n<html>\n`;
    expect(rejectRegeneratedWorkerTypes(committed, next)).toMatch(/HTML/);
  });

  it('does not treat a comment that mentions a script tag as HTML', () => {
    const text = `${runtimeFile(80)}    /** Adds \`<script>\` tags into the page. */\n`;
    expect(rejectRegeneratedWorkerTypes(text, text)).toBeNull();
  });

  it('rejects a file under half the committed length', () => {
    const committed = runtimeFile(400);
    const next = runtimeFile(100);
    expect(rejectRegeneratedWorkerTypes(committed, next)).toMatch(/under half/);
  });

  it('accepts a file that shrinks but stays at least half', () => {
    const committed = runtimeFile(400);
    const next = runtimeFile(200);
    expect(rejectRegeneratedWorkerTypes(committed, next)).toBeNull();
  });
});

describe('committed worker-configuration.d.ts', () => {
  it('still has the runtime declarations typecheck needs', () => {
    const text = readFileSync(
      join(REPO_ROOT, 'worker-configuration.d.ts'),
      'utf8'
    );
    expect(rejectRegeneratedWorkerTypes(text, text)).toBeNull();
    expect(text.split('\n').length).toBeGreaterThan(1000);
  });
});
