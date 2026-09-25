import { describe, expect, it } from 'vitest';
import { checkParts, checkTake, locateParts } from './take-check';

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

describe('checkParts', () => {
  it('finds each part of a clean read', () => {
    const check = checkParts(timed('hello there mate how are you going'), [
      'Hello there mate.',
      'How are you going?',
    ]);
    expect(check).toEqual({
      ok: true,
      spans: [
        { start: 0, end: 2.8 },
        { start: 3, end: 6.8 },
      ],
      scriptStartSeconds: 0,
    });
  });

  it('names what an invented burst added', () => {
    const check = checkParts(
      timed('hello there mate laverame gorsnerm vexolin how are you going'),
      ['Hello there mate.', 'How are you going?']
    );
    expect(check.ok).toBe(false);
    expect(!check.ok && check.problem).toContain('laverame');
  });
});

describe('ASR spellings (#1803)', () => {
  it('matches digits heard for number words', () => {
    const check = checkParts(timed('we leave at 15 10 sharp okay'), [
      'We leave at fifteen ten sharp.',
      'Okay.',
    ]);
    expect(check.ok).toBe(true);
  });

  it('matches "all right" heard for "alright"', () => {
    const check = checkParts(timed('all right lets go then'), [
      "Alright, let's go then.",
    ]);
    expect(check.ok).toBe(true);
  });

  it('locates a part with one end word misheard', () => {
    const check = checkParts(timed('hello there mate how era you going'), [
      'Hello there mate.',
      'How are you going?',
    ]);
    expect(check.ok).toBe(true);
  });

  it('names the line it could not find', () => {
    const check = checkParts(timed('hello there mate'), [
      'Hello there mate.',
      'How are you going?',
    ]);
    expect(!check.ok && check.problem).toContain('line 2');
  });
});

describe('only bursts fail (#1803)', () => {
  it('passes stray misheard words spread through the read', () => {
    const check = checkTake(
      'I told him the boat was leaving at nine, and he said fine.',
      timed('I told him zee boat was leaving at nein and he said fyne')
    );
    expect(check.ok).toBe(true);
  });

  it('passes a first word misheard', () => {
    const check = checkTake(
      'Morning all, the rates are up.',
      timed('Warning all the rates are up')
    );
    expect(check.ok).toBe(true);
    expect(check.scriptStartSeconds).toBe(0);
  });
});
