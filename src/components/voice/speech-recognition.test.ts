import { describe, expect, it } from 'vitest';
import {
  joinSpeech,
  splitResults,
  type RecognitionResults,
} from './speech-recognition';

/**
 * The recogniser hands back an array-like of results, each an array-like of
 * alternatives. Only the shape `splitResults` reads is modelled here.
 */
const resultList = (
  entries: Array<{ transcript: string; isFinal: boolean }>
): RecognitionResults =>
  entries.map((entry) => ({
    length: 1,
    isFinal: entry.isFinal,
    0: { transcript: entry.transcript },
  }));

describe('splitResults', () => {
  it('separates settled text from the words still being revised', () => {
    expect(
      splitResults(
        resultList([
          { transcript: 'INT. KITCHEN - NIGHT. ', isFinal: true },
          { transcript: 'She turns to', isFinal: false },
        ])
      )
    ).toEqual({ final: 'INT. KITCHEN - NIGHT. ', interim: 'She turns to' });
  });

  it('is empty for a session that has produced nothing', () => {
    expect(splitResults(resultList([]))).toEqual({ final: '', interim: '' });
  });
});

describe('joinSpeech', () => {
  it('joins the parts of a take with exactly one space', () => {
    expect(joinSpeech('INT. KITCHEN', ' She turns ', 'to the door')).toBe(
      'INT. KITCHEN She turns to the door'
    );
  });

  it('drops empty parts rather than leaving gaps', () => {
    // The shape of every emission before the first final result lands.
    expect(joinSpeech('', '', 'She turns')).toBe('She turns');
    expect(joinSpeech('', '', '')).toBe('');
  });
});
