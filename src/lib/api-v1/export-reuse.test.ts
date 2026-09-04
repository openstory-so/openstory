import { describe, expect, it } from 'vitest';
import { decideExistingExport } from './export-reuse';

const STALE_MS = 35 * 60 * 1000;
const NOW = Date.parse('2026-09-04T12:00:00.000Z');

function row(overrides: {
  status: 'processing' | 'ready' | 'failed';
  sourceShotsHash: string | null;
  createdAt?: Date;
}) {
  return {
    id: 'exp-1',
    ...overrides,
    createdAt: overrides.createdAt ?? new Date(NOW - 60_000),
  };
}

describe('decideExistingExport', () => {
  it('serves a ready row whose hash matches the current cut', () => {
    const ready = row({ status: 'ready', sourceShotsHash: 'abc' });
    expect(decideExistingExport([ready], 'abc', NOW, STALE_MS)).toEqual({
      action: 'return-ready',
      row: ready,
    });
  });

  it('ignores a ready row for a different cut', () => {
    const ready = row({ status: 'ready', sourceShotsHash: 'old' });
    expect(decideExistingExport([ready], 'abc', NOW, STALE_MS)).toEqual({
      action: 'create',
    });
  });

  it('prefers the matching ready row over an unrelated in-flight render', () => {
    const processing = row({
      status: 'processing',
      sourceShotsHash: 'other',
      createdAt: new Date(NOW - 1_000),
    });
    const ready = row({
      status: 'ready',
      sourceShotsHash: 'abc',
      createdAt: new Date(NOW - 120_000),
    });
    expect(
      decideExistingExport([processing, ready], 'abc', NOW, STALE_MS)
    ).toEqual({ action: 'return-ready', row: ready });
  });

  it('coalesces onto a live processing row when no ready hash matches', () => {
    const processing = row({
      status: 'processing',
      sourceShotsHash: 'abc',
      createdAt: new Date(NOW - 1_000),
    });
    expect(decideExistingExport([processing], 'abc', NOW, STALE_MS)).toEqual({
      action: 'return-processing',
      row: processing,
    });
  });

  it('marks a stale processing row failed so a new export can start', () => {
    const processing = row({
      status: 'processing',
      sourceShotsHash: 'abc',
      createdAt: new Date(NOW - STALE_MS - 1),
    });
    expect(decideExistingExport([processing], 'abc', NOW, STALE_MS)).toEqual({
      action: 'fail-stale-processing',
      row: processing,
    });
  });

  it('creates when the sequence has no reusable rows', () => {
    expect(decideExistingExport([], 'abc', NOW, STALE_MS)).toEqual({
      action: 'create',
    });
  });
});
