import { describe, expect, it } from 'vitest';
import { checkParts } from './take-check';

const timed = (text: string, from = 0) =>
  text.split(' ').map((word, i) => ({
    text: word,
    start: from + i,
    end: from + i + 0.8,
  }));

const spansOf = (check: ReturnType<typeof checkParts>) =>
  check.ok ? check.spans : check.problem;

describe('checkParts', () => {
  it('finds each line of a clean read', () => {
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

  it('does not care how a transcript spells a line (#1803)', () => {
    const check = checkParts(
      timed(
        'before you rent dont sign blind check B.Y.R. all right 15 minutes'
      ),
      [
        "BeforeYouRent. Don't sign blind, check BYR?",
        'Alright, fifteen minutes.',
      ]
    );
    expect(spansOf(check)).toEqual([
      { start: 0, end: 7.8 },
      { start: 8, end: 11.8 },
    ]);
  });

  it('starts the script after speech before it', () => {
    const check = checkParts(
      timed('Laverame for Mrs Gorsnerm Got graft you say Not me'),
      ['Got graft, you say?', 'Not me.']
    );
    expect(check.ok && check.scriptStartSeconds).toBe(4);
  });

  it('leaves speech between lines out of both', () => {
    const check = checkParts(
      timed('keep it down okay gorsnerm laverame vexolin stop that right now'),
      ['Keep it down, okay?', 'Stop that right now!']
    );
    expect(spansOf(check)).toEqual([
      { start: 0, end: 3.8 },
      { start: 7, end: 10.8 },
    ]);
  });

  it('keeps a short line in its place when it comes again later', () => {
    const check = checkParts(timed('ok where to now yes okay then'), [
      'Okay.',
      'Where to now?',
      'Yes.',
      'Okay then.',
    ]);
    expect(spansOf(check)).toEqual([
      { start: 0, end: 0.8 },
      { start: 1, end: 3.8 },
      { start: 4, end: 4.8 },
      { start: 5, end: 6.8 },
    ]);
  });

  it('names a line that was never said', () => {
    const check = checkParts(timed('hello there mate'), [
      'Hello there mate.',
      'How are you going?',
    ]);
    expect(!check.ok && check.problem).toContain('line 2');
  });

  // Scribe's words for a real two-voice Seed take (#1803). The checker before
  // this one failed it on "All right" for "Alright".
  it('splits a real take', () => {
    const heard = (
      [
        ["G'day.", 0.42, 0.72],
        ['That', 1.42, 1.52],
        ["wasn't", 1.56, 1.74],
        ['in', 1.76, 1.82],
        ['the', 1.86, 1.94],
        ['photos', 1.96, 2.52],
        ['Run', 2.66, 2.8],
        ['every', 2.86, 3.06],
        ['tap,', 3.2, 3.42],
        ['open', 3.72, 3.92],
        ['every', 3.98, 4.16],
        ['window,', 4.24, 4.66],
        ['look', 4.92, 5.06],
        ['up.', 5.16, 5.3],
        ['Check', 7.58, 7.76],
        ['past', 7.84, 8.1],
        ['renters', 8.14, 8.46],
        ['before', 8.5, 8.76],
        ['you', 8.82, 8.88],
        ['apply.', 8.92, 9.4],
        ['Rent', 9.5, 9.68],
        ['right.', 9.76, 10.08],
        ["Don't", 11.18, 11.4],
        ['sign', 11.48, 11.72],
        ['blind.', 11.8, 12.16],
        ['First', 12.26, 12.48],
        ['check', 12.56, 12.74],
        ['reviews', 12.8, 13.18],
        ['on', 13.24, 13.34],
        ['RRT.', 13.52, 14.08],
        ['All', 15.96, 16.02],
        ['right.', 16.059, 16.379],
        ['15', 17.02, 17.4],
        ['minutes,', 17.44, 17.8],
        ['then', 18.14, 18.26],
        ['we', 18.3, 18.38],
        ['go', 18.42, 18.68],
      ] as const
    ).map(([text, start, end]) => ({ text, start, end }));
    const check = checkParts(heard, [
      'G’day. That wasn’t in the photos.',
      'Run every tap. Open every window. Look up.',
      'Check past renters before you apply.',
      'RentRight. Don’t sign blind, first check reviews on RRT?',
      'Alright, 15 minutes, then we go.',
    ]);
    expect(spansOf(check)).toEqual([
      { start: 0.42, end: 2.52 },
      { start: 2.66, end: 5.3 },
      { start: 7.58, end: 9.4 },
      { start: 9.5, end: 14.08 },
      { start: 15.96, end: 18.68 },
    ]);
  });
});
