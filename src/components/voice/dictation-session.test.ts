import { describe, expect, it, vi } from 'vitest';
import { createDictationSession, DictationError } from './dictation-session';
import type { RecognitionResults } from './speech-recognition';

const resultList = (
  entries: Array<{ transcript: string; isFinal: boolean }>
): RecognitionResults =>
  entries.map((entry) => ({
    length: 1,
    isFinal: entry.isFinal,
    0: { transcript: entry.transcript },
  }));

const bind = ({
  throwOnStart,
  throwOnStop,
  throwOnAbort,
  scheduleRestart = (fn) => fn(),
}: {
  throwOnStart?: { current: boolean };
  throwOnStop?: { current: boolean };
  throwOnAbort?: { current: boolean };
  scheduleRestart?: (fn: () => void) => void;
} = {}) => {
  const start = vi.fn(() => {
    if (throwOnStart?.current) throw new Error('InvalidStateError');
  });
  const stop = vi.fn(() => {
    if (throwOnStop?.current) throw new Error('InvalidStateError');
  });
  const abort = vi.fn(() => {
    if (throwOnAbort?.current) throw new Error('InvalidStateError');
  });
  const onTranscript = vi.fn();
  const onError = vi.fn();
  const onEnd = vi.fn();
  const session = createDictationSession(
    { start, stop, abort },
    { onTranscript, onError, onEnd },
    scheduleRestart
  );
  return { session, start, stop, abort, onTranscript, onError, onEnd };
};

describe('createDictationSession', () => {
  it('folds finals from a silence-restarted session into the next interim', () => {
    const { session, start, onTranscript, onError, onEnd } = bind();

    expect(session.start()).toBe(true);
    session.feedResults(
      resultList([{ transcript: 'INT. KITCHEN', isFinal: true }])
    );
    session.feedError('no-speech');
    session.feedEnd();
    session.feedResults(resultList([{ transcript: 'night', isFinal: false }]));

    expect(start).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onTranscript).toHaveBeenLastCalledWith('INT. KITCHEN night');
  });

  it('toasts a real error and does not restart', () => {
    const { session, start, onError, onEnd } = bind();

    session.start();
    session.feedError('not-allowed');
    session.feedEnd();

    expect(onError).toHaveBeenCalledTimes(1);
    const error = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(DictationError);
    expect(error).toMatchObject({ code: 'not-allowed' });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not toast aborted from our own abort()', () => {
    const { session, abort, onError, onEnd, start } = bind();

    session.start();
    session.abort();
    session.feedError('aborted');
    session.feedEnd();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('toasts an aborted the UA fired on its own', () => {
    const { session, start, onError, onEnd } = bind();

    session.start();
    session.feedError('aborted');
    session.feedEnd();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'aborted' });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('fails closed when start() throws, without leaving the take running', () => {
    const throwOnStart = { current: true };
    const { session, start, onError, onEnd } = bind({ throwOnStart });

    expect(session.start()).toBe(false);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'start-failed' });
    expect(onEnd).toHaveBeenCalledTimes(1);

    throwOnStart.current = false;
    expect(session.start()).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the silence-restart start() throws', () => {
    const throwOnStart = { current: false };
    const { session, start, onError, onEnd } = bind({ throwOnStart });

    session.start();
    throwOnStart.current = true;
    session.feedEnd();

    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'start-failed' });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not restart after stop()', () => {
    const { session, start, stop, onEnd, onError } = bind();

    session.start();
    session.stop();
    session.feedEnd();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('ends the take when stop() throws', () => {
    const { session, onEnd, onError } = bind({
      throwOnStop: { current: true },
    });

    session.start();
    session.stop();

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('ends the take when abort() throws', () => {
    const { session, onEnd, onError } = bind({
      throwOnAbort: { current: true },
    });

    session.start();
    session.abort();

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('skips recognition.abort() when the take is already idle', () => {
    const { session, abort, onEnd } = bind();

    session.abort();

    expect(abort).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('cancels a scheduled silence-restart if stop() wins the later turn', () => {
    let pending: (() => void) | undefined;
    const { session, start, onEnd, onError } = bind({
      scheduleRestart: (fn) => {
        pending = fn;
      },
    });

    session.start();
    session.feedEnd();
    session.stop();
    pending?.();
    session.feedEnd();

    expect(start).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
