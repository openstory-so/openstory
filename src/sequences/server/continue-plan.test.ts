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
): PlanUnit => ({ kind, id, state });

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
    expect(references.startFrom).toBe('references');
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
    expect(decide(plan, 'images').startFrom).toBe('images');
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
    expect(result.startFrom).toBe('references');
  });

  it('turning Start frames off after stills exist is refused', () => {
    expect(() =>
      decide([u('still', 's1', 'done'), u('clip', 's1', 'missing')], 'music', {
        saved: ON,
        requested: { ...ON, generateStartFrames: false },
      })
    ).toThrow('Start frames can’t be turned off: shots already have stills');
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

  it('never resolves startFrom past Dialogue (#1820)', () => {
    // Checkpoint at Images (or References, reference-only) with Voices off:
    // the old guard skipped Dialogue and resolved 'motion', which nothing
    // downstream expected — the Images pass re-rendered every still. The
    // plan starts where the work is, and the run only starts at a stage it
    // can hydrate.
    const imagesDone = [
      u('sheet:character', 'maya', 'done'),
      u('prompt:visual', 's1', 'done'),
      u('still', 's1', 'done'),
      u('prompt:motion', 's1', 'done'),
      u('clip', 's1', 'missing'),
    ];
    expect(() => decide(imagesDone, 'music')).toThrow(
      'Nothing before Motion to generate — use Generate Motion'
    );
    expect(() => decide([u('music', 'seq', 'missing')], 'music')).toThrow(
      'Nothing before Music to generate — use Generate Music'
    );
    // Earlier work still starts at its own stage, whatever the stop.
    for (const [plan, expected] of [
      [[...imagesDone, u('sheet:location', 'l1', 'stale')], 'references'],
      [[...imagesDone, u('still', 's2', 'missing')], 'images'],
      [[...imagesDone, u('dialogue', 's1', 'missing')], 'dialogue'],
    ] as const) {
      expect(decide([...plan], 'music').startFrom).toBe(expected);
    }
  });
});
