import { describe, expect, it } from 'vitest';
import { checkTake, locateParts } from './take-check';

const timed = (text: string, from = 0) =>
  text.split(' ').map((word, i) => ({
    text: word,
    start: from + i,
    end: from + i + 0.8,
  }));

describe('checkTake', () => {
  it('passes a clean read, loose on accent spellings', () => {
    const check = checkTake(
      "G'day mate, the rates are up again today.",
      timed('Gday mate the rights are up again today')
    );
    expect(check.ok).toBe(true);
    expect(check.scriptStartSeconds).toBe(0);
  });

  it('finds nonsense before the script and where the script starts', () => {
    const check = checkTake(
      'Got graft, you say? Not me.',
      timed('Laverame for Mrs Gorsnerm Got graft you say Not me')
    );
    expect(check.ok).toBe(true);
    expect(check.scriptStartSeconds).toBe(4);
  });

  it('fails a take with invented words mid-read', () => {
    const check = checkTake(
      'I told him the boat was leaving at nine.',
      timed('I told him the Gorsnerm laverame plinth boat was leaving at nine')
    );
    expect(check.ok).toBe(false);
  });

  it('fails a take that never says the script', () => {
    expect(checkTake('Hello there friend', timed('something else')).ok).toBe(
      false
    );
  });
});

describe('locateParts', () => {
  it('finds each part in order, after the one before', () => {
    const heard = timed(
      'well hello there how are you then keep it down okay stop that right now'
    );
    const spans = locateParts(heard, [
      'Well, hello there, how are you?',
      'Keep it down, okay?',
      'Stop that right now!',
    ]);
    expect(spans).toEqual([
      { start: 0, end: 5.8 },
      { start: 7, end: 10.8 },
      { start: 11, end: 14.8 },
    ]);
  });

  it('reports a part it cannot find', () => {
    expect(locateParts(timed('one two three'), ['four five'])).toEqual([
      undefined,
    ]);
  });
});
