/**
 * Storyboard HTTP triggers must hold a run envelope (#1310), not a read-only
 * requireCredits, and put reservationId on the trigger payload.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const STORYBOARD_TRIGGERS = [
  'src/lib/sequences/create-sequences.ts',
  'src/functions/sequences.ts',
  'src/functions/shot-image.ts',
  'src/lib/sequences/smart-retry.ts',
] as const;

describe('storyboard envelope wiring', () => {
  test.each(STORYBOARD_TRIGGERS)(
    '%s holds with reserveRunCredits and threads reservationId',
    (file) => {
      const source = readFileSync(file, 'utf8');
      expect(source).toMatch(/reserveRunCredits\s*\(/);
      expect(source).toMatch(/reservationId/);
      expect(source).toMatch(/triggerStoryboard/);
    }
  );

  test('create-sequences reserves inside the analysis-model loop', () => {
    const source = readFileSync(
      'src/lib/sequences/create-sequences.ts',
      'utf8'
    );
    const mapIdx = source.indexOf('analysisModels.map');
    const reserveIdx = source.lastIndexOf('reserveRunCredits(');
    expect(mapIdx).toBeGreaterThan(-1);
    expect(reserveIdx).toBeGreaterThan(mapIdx);
    expect(source).toMatch(/releaseReservationOnThrow/);
  });

  test('analyze-script grows or stops before spawning shot-images', () => {
    const source = readFileSync(
      'src/lib/workflows/analyze-script-workflow.ts',
      'utf8'
    );
    expect(source).toMatch(/gateStoryboardRenders/);
    expect(source).toMatch(/spawn-shot-images/);
    expect(source.indexOf('gateStoryboardRenders')).toBeLessThan(
      source.indexOf('spawn-shot-images')
    );
    expect(source).toMatch(/updateStatus\('failed'/);
    expect(source).toMatch(/NonRetryableError/);
    expect(source).toMatch(/creditsShortStatusError/);
  });

  test('reservation:short does not toast as an error (#1328)', () => {
    const source = readFileSync(
      'src/lib/realtime/use-generation-stream.ts',
      'utf8'
    );
    expect(source).not.toMatch(/toast\.error/);
    expect(source).toMatch(/generation\.reservation:short/);
  });
});

describe('studio envelope wiring', () => {
  test('create holds one envelope per asset and the workflow captures it', () => {
    const createSource = readFileSync(
      'src/lib/studio/create-studio-asset.ts',
      'utf8'
    );
    expect(createSource).toMatch(/reserveRunCredits\s*\(/);
    expect(createSource).toMatch(/ownsReservation:\s*true/);
    expect(createSource).toMatch(/releaseReservationOnThrow/);
    expect(createSource).not.toMatch(/requireCredits\s*\(/);

    const workflowSource = readFileSync(
      'src/lib/workflows/studio-generation-workflow.ts',
      'utf8'
    );
    expect(workflowSource).toMatch(
      /reservationId:\s*event\.payload\.reservationId/
    );
  });
});
