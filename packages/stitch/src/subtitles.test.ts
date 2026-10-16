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

  it('splits on a blank line that holds spaces, and reads CRLF and a BOM', () => {
    const cues = parseSubtitles(
      '\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nA\r\n \r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nB\r\n',
      'lines.srt'
    );
    expect(cues).toEqual([
      { startSeconds: 1, endSeconds: 2, text: 'A' },
      { startSeconds: 3, endSeconds: 4, text: 'B' },
    ]);
  });

  it('refuses minutes or seconds past 59, quoting the time line', () => {
    expect(() =>
      parseSubtitles('1\n00:75:99,000 --> 00:76:00,000\nA\n', 'lines.srt')
    ).toThrow('got "00:75:99,000 --> 00:76:00,000"');
  });

  it('names the file when a block is not a cue', () => {
    expect(() => parseSubtitles('hello', 'lines.srt')).toThrow(/lines\.srt/);
  });
});
