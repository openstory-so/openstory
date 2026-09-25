/**
 * Pins how "Update all" reports the up-front dialogue recording (#1740): a
 * dialogue-only target that got no audio is a failure, not a quiet no-op, and
 * a target that did is counted — its neighbours in the scene are not.
 */

import { describe, expect, it } from 'vitest';
import { dialogueTargetOutcome } from './update-stale-shots-workflow';

const clip = {};
const recording = {
  scenes: [
    {
      voiced: [{ shotId: 'a' }, { shotId: 'n' }, { shotId: 'v' }],
    },
  ],
};
const targets = [
  { shotId: 'a', regenDialogue: true, regenVideo: false },
  // Video follows: its render records the shot itself on a miss.
  { shotId: 'v', regenDialogue: true, regenVideo: true },
];

describe('dialogueTargetOutcome', () => {
  it('counts only target shots that got audio', () => {
    expect(
      dialogueTargetOutcome(targets, recording, {
        clipsByShotId: { a: [clip], n: [clip], v: [clip] },
      })
    ).toEqual({ updated: 2, failures: [] });
  });

  it('fails a dialogue-only target the recording returned no audio for', () => {
    expect(
      dialogueTargetOutcome(targets, recording, {
        clipsByShotId: { n: [clip] },
      })
    ).toEqual({
      updated: 0,
      failures: [
        {
          shotId: 'a',
          stage: 'dialogue',
          error: 'Dialogue not recorded for this shot',
        },
      ],
    });
  });

  it('fails dialogue-only targets when the recording was refused or rejected', () => {
    expect(
      dialogueTargetOutcome(targets, recording, {
        error: 'Insufficient credits for dialogue audio',
      })
    ).toEqual({
      updated: 0,
      failures: [
        {
          shotId: 'a',
          stage: 'dialogue',
          error: 'Insufficient credits for dialogue audio',
        },
      ],
    });
  });
});
