import { describe, expect, it } from 'vitest';
import { parseSubtitles } from './subtitles.js';

describe('parseSubtitles', () => {
  it('reads an srt cue, including a comma in the time', () => {
    const cues = parseSubtitles(
      '1\n00:00:01,500 --> 00:00:03,000\nComing over?\n',
      'lines.srt'
    );
    expect(cues).toEqual([
      { startSeconds: 1.5, endSeconds: 3, text: 'Coming over?' },
    ]);
  });

  it('reads a vtt cue and keeps a second line', () => {
    const cues = parseSubtitles(
      'WEBVTT\n\n00:01.000 --> 00:02.250 align:start\nLove that accent.\nSecond line\n',
      'lines.vtt'
    );
    expect(cues).toEqual([
      {
        startSeconds: 1,
        endSeconds: 2.25,
        text: 'Love that accent.\nSecond line',
      },
    ]);
  });

  it('names the file when a block is not a cue', () => {
    expect(() => parseSubtitles('hello', 'lines.srt')).toThrow(/lines\.srt/);
  });
});
