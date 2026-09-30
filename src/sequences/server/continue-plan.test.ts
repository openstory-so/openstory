/**
 * `continueFromPlan` is the continue guard (#1817): accept or refuse, and the
 * units a click would run. The #1816 scenario table, from the server's side.
 */

import { describe, expect, it } from 'vitest';
import type { PlanUnit } from '@/sequences/generation-plan';
import { continueFromPlan } from './continue-plan';

const u = (
  kind: PlanUnit['kind'],
  id: string,
  state: PlanUnit['state']
): PlanUnit => ({ kind, id, state, requires: [], cascaded: false });

const OFF = { generateStartFrames: false, generateVoices: false };
const ON = { generateStartFrames: true, generateVoices: true };

function decide(
  plan: PlanUnit[],
  stopAt: Parameters<typeof continueFromPlan>[0]['stopAt'],
  flags: {
    saved?: typeof OFF;
    requested?: typeof OFF;
    next?: PlanUnit[];
  } = {}
) {
  return continueFromPlan({
    current: plan,
    next: flags.next ?? plan,
    saved: flags.saved ?? { generateStartFrames: true, generateVoices: false },
    requested: flags.requested ??
      flags.saved ?? { generateStartFrames: true, generateVoices: false },
    stopAt,
  });
}

const units = (r: ReturnType<typeof decide>) =>
  r.work.map((w) => `${w.kind}:${w.id}`);

describe('continueFromPlan (#1817)', () => {
  it('references done, two hand-added characters: runs their sheets, not "the last run only reached"', () => {
    // The reported bug: the checkpoint said References was done and the old
    // guard refused every click.
    const plan = [
      u('sheet:character', 'maya', 'done'),
      u('sheet:character', 'ravi', 'missing'),
      u('sheet:character', 'ana', 'missing'),
      u('prompt:visual', 's1', 'stale'),
      u('still', 's1', 'stale'),
    ];
    const references = decide(plan, 'references');
    expect(units(references)).toEqual([
      'sheet:character:ravi',
      'sheet:character:ana',
      'prompt:visual:s1',
    ]);
    expect(units(decide(plan, 'images'))).toContain('still:s1');
  });

  it('refuses only when there is nothing up to the stop', () => {
    const plan = [
      u('sheet:character', 'maya', 'done'),
      u('still', 's1', 'missing'),
    ];
    expect(() => decide(plan, 'references')).toThrow(
      'Nothing to generate up to References & Prompts'
    );
    expect(units(decide(plan, 'images'))).toEqual(['still:s1']);
  });

  it('blocked and running units are not work', () => {
    const plan = [
      u('still', 's1', 'running'),
      u('prompt:motion', 's1', 'blocked'),
    ];
    expect(() => decide(plan, 'music')).toThrow(/Nothing to generate/);
  });

  it('turning Voices on adds the recordings it owes', () => {
    const next = [
      u('voice', 'maya', 'missing'),
      u('dialogue', 's1', 'missing'),
    ];
    const result = decide([], 'dialogue', {
      saved: { generateStartFrames: true, generateVoices: false },
      requested: { generateStartFrames: true, generateVoices: true },
      next,
    });
    expect(units(result)).toEqual(['voice:maya', 'dialogue:s1']);
  });

  it('turning Start frames off after stills exist is allowed', () => {
    expect(() =>
      decide([u('still', 's1', 'done'), u('clip', 's1', 'missing')], 'music', {
        saved: ON,
        requested: { ...ON, generateStartFrames: false },
      })
    ).not.toThrow();
  });

  it('turning Voices off after a recording exists is refused', () => {
    expect(() =>
      decide([u('dialogue', 's1', 'stale')], 'dialogue', {
        saved: ON,
        requested: { ...ON, generateVoices: false },
      })
    ).toThrow(
      'Voices can’t be turned off: shots already have recorded dialogue'
    );
  });

  it('turning a switch off before its units exist is fine', () => {
    const result = decide(
      [u('sheet:location', 'l1', 'missing')],
      'references',
      {
        saved: ON,
        requested: OFF,
      }
    );
    expect(units(result)).toEqual(['sheet:location:l1']);
  });

  it('clip-only and music-only work is a continue too (#1818): the run takes units, not a stage', () => {
    const imagesDone = [
      u('still', 's1', 'done'),
      u('prompt:motion', 's1', 'done'),
      u('clip', 's1', 'missing'),
      u('music', 'seq', 'missing'),
    ];
    expect(units(decide(imagesDone, 'music'))).toEqual([
      'clip:s1',
      'music:seq',
    ]);
    expect(units(decide(imagesDone, 'motion'))).toEqual(['clip:s1']);
  });

  it('going back never redoes finished work (#1780 §3): Voices on stops at Dialogue', () => {
    const next = [
      u('voice', 'maya', 'missing'),
      u('dialogue', 's1', 'missing'),
      // Stale only because the recording is new: Update all's, not this run's.
      u('clip', 's1', 'stale'),
    ];
    const result = decide([], 'music', {
      saved: { generateStartFrames: true, generateVoices: false },
      requested: { generateStartFrames: true, generateVoices: true },
      next,
    });
    expect(result.stopAt).toBe('dialogue');
    expect(units(result)).toEqual(['voice:maya', 'dialogue:s1']);
  });

  it('Voices on still reaches Motion when no later unit exists', () => {
    const next = [
      u('voice', 'maya', 'missing'),
      u('dialogue', 's1', 'missing'),
      u('clip', 's1', 'missing'),
    ];
    const result = decide([], 'music', {
      saved: { generateStartFrames: true, generateVoices: false },
      requested: { generateStartFrames: true, generateVoices: true },
      next,
    });
    expect(result.stopAt).toBe('music');
    expect(units(result)).toEqual(['voice:maya', 'dialogue:s1', 'clip:s1']);
  });

  it('Start frames on stops at Images; both on stop at the later, Dialogue', () => {
    const next = [
      u('prompt:visual', 's1', 'missing'),
      u('still', 's1', 'missing'),
      u('dialogue', 's1', 'missing'),
      u('clip', 's1', 'stale'),
    ];
    const framesOn = decide([], 'music', {
      saved: OFF,
      requested: { generateStartFrames: true, generateVoices: false },
      next,
    });
    expect(framesOn.stopAt).toBe('images');
    expect(units(framesOn)).toEqual(['prompt:visual:s1', 'still:s1']);
    expect(
      decide([], 'music', { saved: OFF, requested: ON, next }).stopAt
    ).toBe('dialogue');
    // A stop already before the step is kept.
    expect(
      decide([], 'references', { saved: OFF, requested: ON, next }).stopAt
    ).toBe('references');
  });
});
