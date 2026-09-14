import { describe, expect, it } from 'vitest';
import { dropTrailingTerminalHistory } from './generation-stream-history';

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

describe('dropTrailingTerminalHistory', () => {
  it('drops a previous run’s trailing complete so Continue can show progress', () => {
    // Stop at Casting, then Continue to References: history ends on complete
    // and the new phase:start has not been emitted yet.
    expect(
      dropTrailingTerminalHistory([start(1), completePhase(1), complete]).map(
        (e) => e.event
      )
    ).toEqual(['generation.phase:start', 'generation.phase:complete']);
  });

  it('keeps a complete that is followed by the current run’s phase:start', () => {
    expect(
      dropTrailingTerminalHistory([
        start(1),
        completePhase(1),
        complete,
        start(2),
      ])
    ).toEqual([start(1), completePhase(1), complete, start(2)]);
  });

  it('drops trailing failed and reservation-short the same way', () => {
    expect(dropTrailingTerminalHistory([start(1), failed])).toEqual([start(1)]);
    expect(dropTrailingTerminalHistory([start(1), short])).toEqual([start(1)]);
  });

  it('drops a stack of trailing terminals', () => {
    expect(dropTrailingTerminalHistory([start(1), complete, failed])).toEqual([
      start(1),
    ]);
  });

  it('returns the same array when nothing trailing is terminal', () => {
    const events = [start(1), completePhase(1), start(2)];
    expect(dropTrailingTerminalHistory(events)).toBe(events);
  });
});
