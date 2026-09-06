import { describe, expect, it } from 'vitest';
import { appendTranscript, spaceTranscript } from './transcript-insert';

describe('spaceTranscript', () => {
  it('returns the trimmed transcript when nothing precedes it', () => {
    expect(spaceTranscript('', '  A wide shot of the harbour. ')).toBe(
      'A wide shot of the harbour.'
    );
  });

  it('adds one space after a word', () => {
    expect(spaceTranscript('INT. KITCHEN', 'night')).toBe(' night');
  });

  it('adds no space after whitespace or a newline', () => {
    expect(spaceTranscript('INT. KITCHEN ', 'night')).toBe('night');
    expect(spaceTranscript('INT. KITCHEN\n', 'night')).toBe('night');
  });

  it('adds no space when the transcript opens with attaching punctuation', () => {
    expect(spaceTranscript('She turns', ', slowly.')).toBe(', slowly.');
    expect(spaceTranscript('She turns', '.')).toBe('.');
  });

  it('drops an empty or whitespace-only transcript', () => {
    expect(spaceTranscript('Anything', '   ')).toBe('');
  });
});

describe('appendTranscript', () => {
  it('appends with a joining space', () => {
    expect(appendTranscript('tense orchestral', 'with low strings')).toBe(
      'tense orchestral with low strings'
    );
  });

  it('leaves the existing text alone when the transcript is empty', () => {
    expect(appendTranscript('tense orchestral', '')).toBe('tense orchestral');
  });

  it('starts fresh when there is no existing text', () => {
    expect(appendTranscript('', ' dark ambient ')).toBe('dark ambient');
  });
});
