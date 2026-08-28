import { describe, expect, it } from 'vitest';
import { getRedirectFromParams, sanitizeAuthRedirect } from './navigation';

describe('sanitizeAuthRedirect', () => {
  it('defaults empty to home', () => {
    expect(sanitizeAuthRedirect(undefined)).toBe('/');
    expect(sanitizeAuthRedirect(null)).toBe('/');
    expect(sanitizeAuthRedirect('')).toBe('/');
    expect(sanitizeAuthRedirect('   ')).toBe('/');
  });

  it('strips hash fragments that break better-auth OAuth callbackURL', () => {
    // Gallery "Try this style" → /?style=<slug>#compose
    expect(sanitizeAuthRedirect('/?style=cinematic#compose')).toBe(
      '/?style=cinematic'
    );
    expect(sanitizeAuthRedirect('/#compose')).toBe('/');
    expect(sanitizeAuthRedirect('/gallery#clip')).toBe('/gallery');
  });

  it('keeps path + search', () => {
    expect(sanitizeAuthRedirect('/sequences')).toBe('/sequences');
    expect(sanitizeAuthRedirect('/?style=01KZK1B0Y62Q1N65D2G0FGFXQB')).toBe(
      '/?style=01KZK1B0Y62Q1N65D2G0FGFXQB'
    );
  });

  it('reduces absolute URLs to path + search', () => {
    expect(
      sanitizeAuthRedirect('http://localhost:3000/?style=anime#compose')
    ).toBe('/?style=anime');
    expect(sanitizeAuthRedirect('https://openstory.so/gallery')).toBe(
      '/gallery'
    );
  });

  it('blocks protocol-relative and auth-page loops', () => {
    expect(sanitizeAuthRedirect('//evil.example')).toBe('/');
    expect(sanitizeAuthRedirect('/login')).toBe('/');
    expect(sanitizeAuthRedirect('/login?email=a@b.c')).toBe('/');
    // Absolute URLs collapse to path on *this* origin after OAuth — never
    // navigates the browser to evil.example.
    expect(sanitizeAuthRedirect('https://evil.example/phish')).toBe('/phish');
  });
});

describe('getRedirectFromParams', () => {
  it('reads redirectTo and sanitizes hash', () => {
    expect(getRedirectFromParams({ redirectTo: '/?style=noir#compose' })).toBe(
      '/?style=noir'
    );
    expect(
      getRedirectFromParams(new URLSearchParams('redirectTo=%2Fgallery%23x'))
    ).toBe('/gallery');
  });

  it('defaults when missing', () => {
    expect(getRedirectFromParams({})).toBe('/');
  });
});
