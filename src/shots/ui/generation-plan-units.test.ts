/**
 * The generation plan on the wire is `{ units, speakerConflicts }` (#2259).
 * `firstStageWithWork` / `planWork` filter that argument. Passing the record
 * throws `filter is not a function` and the workspace error boundary replaces
 * the sequence page (#2299). Callers pass `plan.units`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { firstStageWithWork, type PlanUnit } from '@/sequences/generation-plan';

const scenesView = readFileSync(
  new URL('./scenes-view.tsx', import.meta.url),
  'utf8'
);
const sceneList = readFileSync(
  new URL('./scene-list.tsx', import.meta.url),
  'utf8'
);

describe('generation plan callers pass units', () => {
  it('the wire record is not a list', () => {
    const units: PlanUnit[] = [];
    const wire = { units, speakerConflicts: [] as string[] };
    expect(() => firstStageWithWork(wire as never)).toThrow(TypeError);
  });

  it('the workspace reads plan.units', () => {
    expect(scenesView).toContain('firstStageWithWork(plan.units)');
    expect(scenesView).not.toMatch(/firstStageWithWork\(plan\)/);
    expect(sceneList).toContain('savedPlan?.units ?? []');
    expect(sceneList).toContain('footerQuery?.units ?? []');
  });
});
