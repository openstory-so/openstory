import { describe, expect, it } from 'vitest';
import {
  ELEMENT_UPLOAD_ACCEPT,
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
    // Browsers hand back an empty type for some drops and pastes.
    expect(elementKindFromFile({ type: '', name: 'clip.mp4' })).toBe('video');
    // Pasting an .m4a out of Finder: the MIME varies by browser and the name
    // carries spaces, so both routes have to land on audio — an image verdict
    // would send a voice line to the vision LLM.
    expect(
      elementKindFromFile({ type: 'audio/x-m4a', name: 'Mateo - shot 1.m4a' })
    ).toBe('audio');
    expect(elementKindFromFile({ type: '', name: 'Mateo - shot 1.m4a' })).toBe(
      'audio'
    );
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

describe('ELEMENT_UPLOAD_ACCEPT', () => {
  it('offers every extension the parser stores', () => {
    // The two drifted once: `.m4a` parsed as audio but the picker refused it,
    // so a voice line could be pasted but not browsed to.
    for (const name of ['a.mp3', 'a.wav', 'a.m4a', 'a.ogg', 'a.mp4', 'a.mov']) {
      const ext = `.${name.split('.').pop()}`;
      expect(elementKindFromFilename(name)).not.toBeNull();
      expect(ELEMENT_UPLOAD_ACCEPT).toContain(ext);
    }
    expect(ELEMENT_UPLOAD_ACCEPT).toContain('image/*');
    // No models take WebM, and the browser cannot convert video cheaply.
    expect(elementKindFromFilename('a.webm')).toBeNull();
    expect(ELEMENT_UPLOAD_ACCEPT).not.toContain('.webm');
  });
});
