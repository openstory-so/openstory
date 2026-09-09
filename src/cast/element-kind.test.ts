import { describe, expect, it } from 'vitest';
import {
  elementKindFromFile,
  elementKindFromFilename,
  formatElementDuration,
} from './element-kind';

describe('elementKindFromFilename', () => {
  it('sorts the accepted extensions by kind', () => {
    expect(elementKindFromFilename('logo.PNG')).toBe('image');
    expect(elementKindFromFilename('line-3.mp3')).toBe('audio');
    expect(elementKindFromFilename('take-2.mov')).toBe('video');
  });

  it('rejects anything we do not store as an element', () => {
    // Null is what makes the upload fail loudly rather than land a PDF as an
    // image row and hand it to the vision LLM.
    expect(elementKindFromFilename('brief.pdf')).toBeNull();
    expect(elementKindFromFilename('noextension')).toBeNull();
  });
});

describe('elementKindFromFile', () => {
  it('prefers the MIME type and falls back to the name', () => {
    expect(elementKindFromFile({ type: 'audio/mpeg', name: 'x' })).toBe(
      'audio'
    );
    // Browsers hand back an empty type for some drops.
    expect(elementKindFromFile({ type: '', name: 'clip.mp4' })).toBe('video');
  });
});

describe('formatElementDuration', () => {
  it('reads as seconds under a minute and m:ss above', () => {
    expect(formatElementDuration(11.6)).toBe('12s');
    expect(formatElementDuration(64)).toBe('1:04');
    expect(formatElementDuration(null)).toBeNull();
    expect(formatElementDuration(0)).toBeNull();
  });
});
