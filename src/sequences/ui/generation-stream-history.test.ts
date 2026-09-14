import { describe, expect, it } from 'vitest';
import { replayableHistoryWhileProcessing } from './generation-stream-history';

const start = (phase: number) => ({
  event: 'generation.phase:start',
  data: { phase },
});
const completePhase = (phase: number) => ({
  event: 'generation.phase:complete',
  data: { phase },
});
const complete = { event: 'generation.complete', data: { sequenceId: 'seq' } };
const failed = { event: 'generation.failed', data: { message: 'nope' } };
const short = {
  event: 'generation.reservation:short',
  data: { sceneCount: 3 },
};
const updated = { event: 'generation.updated', data: { title: 'x' } };

describe('replayableHistoryWhileProcessing', () => {
  it('drops a previous run’s complete so Continue does not exit the chip', () => {
    expect(
      replayableHistoryWhileProcessing([
        start(1),
        completePhase(1),
        complete,
      ]).map((e) => e.event)
    ).toEqual(['generation.phase:start', 'generation.phase:complete']);
  });

  it('drops a complete even when a later phase:start follows it', () => {
    // Refresh mid-Continue: the prior run’s complete sits in the middle.
    // Applying it marks isComplete and the chip unmounts for a frame.
    expect(
      replayableHistoryWhileProcessing([
        start(1),
        completePhase(1),
        complete,
        start(2),
      ]).map((e) => e.event)
    ).toEqual([
      'generation.phase:start',
      'generation.phase:complete',
      'generation.phase:start',
    ]);
  });

  it('drops complete when a non-terminal event landed after it', () => {
    expect(
      replayableHistoryWhileProcessing([start(1), complete, updated]).map(
        (e) => e.event
      )
    ).toEqual(['generation.phase:start', 'generation.updated']);
  });

  it('drops failed and reservation-short the same way', () => {
    expect(replayableHistoryWhileProcessing([start(1), failed])).toEqual([
      start(1),
    ]);
    expect(replayableHistoryWhileProcessing([start(1), short])).toEqual([
      start(1),
    ]);
  });

  it('returns the same array when nothing is terminal', () => {
    const events = [start(1), completePhase(1), start(2)];
    expect(replayableHistoryWhileProcessing(events)).toBe(events);
  });
});
