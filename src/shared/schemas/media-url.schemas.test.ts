import { describe, expect, it } from 'vitest';
import { mediaUrlSchema } from './media-url.schemas';

describe('mediaUrlSchema', () => {
  it('accepts origin-relative stored and derived URLs', () => {
    expect(
      mediaUrlSchema.safeParse('/r2/thumbnails/team/shot.png').success
    ).toBe(true);
    expect(
      mediaUrlSchema.safeParse('/cdn-cgi/image/trim=0;1;2;3/r2/x.png').success
    ).toBe(true);
  });

  it('accepts absolute http(s) URLs (external sources, legacy rows)', () => {
    expect(
      mediaUrlSchema.safeParse('https://v3.fal.media/files/b/abc/out.png')
        .success
    ).toBe(true);
    expect(
      mediaUrlSchema.safeParse('http://localhost:3000/r2/videos/a.mp4').success
    ).toBe(true);
  });

  it('rejects protocol-relative URLs (browser resolves them cross-origin)', () => {
    expect(mediaUrlSchema.safeParse('//evil.example.com/x.png').success).toBe(
      false
    );
  });

  it('rejects non-http schemes, bare paths, and empty strings', () => {
    expect(mediaUrlSchema.safeParse('data:image/png;base64,AAAA').success).toBe(
      false
    );
    expect(mediaUrlSchema.safeParse('ftp://host/x.png').success).toBe(false);
    expect(mediaUrlSchema.safeParse('r2/thumbnails/x.png').success).toBe(false);
    expect(mediaUrlSchema.safeParse('').success).toBe(false);
  });
});
