import { describe, expect, it } from 'vitest';
import {
  consentPageHref,
  consentStartLocation,
  displayFieldsFromOAuthQuery,
  needsOAuthQueryPack,
  OAUTH_CONSENT_PATH,
  packOAuthQuery,
  pickOAuthQuery,
  resolveOAuthQuery,
  scoreOAuthQuery,
  unpackOAuthQuery,
} from './oauth-query-snapshot';

const signed =
  '?client_id=c1&sig=abc&ba_param=client_id&ba_param=sig&ba_param=scope';
const mangled = '?client_id=c1&sig=abc&ba_param=scope';
const qssMangled =
  '?client_id=c1&sig=abc&ba_param=%5B%22client_id%22%2C%22sig%22%2C%22scope%22%5D';

describe('scoreOAuthQuery', () => {
  it('prefers more ba_param copies when sig is present', () => {
    expect(scoreOAuthQuery(signed)).toBeGreaterThan(scoreOAuthQuery(mangled));
  });
});

describe('pickOAuthQuery', () => {
  it('picks the signed snapshot over a rewritten location.search', () => {
    expect(pickOAuthQuery([mangled, signed, ''])).toBe(signed);
  });
});

describe('packOAuthQuery / unpackOAuthQuery', () => {
  it('round-trips repeated ba_param keys that qss would collapse', () => {
    const raw =
      '?client_id=c1&ba_param=client_id&ba_param=sig&ba_param=scope&sig=deadbeef';
    const packed = packOAuthQuery(raw);
    expect(packed.startsWith('v1.')).toBe(true);
    expect(packed.includes('ba_param')).toBe(false);
    const unpacked = unpackOAuthQuery(packed);
    expect(unpacked).toBe(raw);
    expect(unpacked).not.toBeNull();
    expect(
      new URLSearchParams((unpacked ?? '').slice(1)).getAll('ba_param')
    ).toEqual(['client_id', 'sig', 'scope']);
  });
});

describe('consentStartLocation', () => {
  it('packs repeats into a single q param the router cannot collapse', () => {
    const location = consentStartLocation(signed);
    expect(location).toMatch(new RegExp(`^${OAUTH_CONSENT_PATH}\\?q=v1\\.`));
    expect(location).not.toBeNull();
    const packedSearch = (location ?? '').slice(OAUTH_CONSENT_PATH.length);
    const params = new URLSearchParams(packedSearch);
    expect([...params.keys()]).toEqual(['q']);
    expect(params.getAll('ba_param')).toEqual([]);
    expect(resolveOAuthQuery(packedSearch)).toBe(signed);
  });

  it('passes an already-packed q through without re-encoding the payload', () => {
    const packed = packOAuthQuery(signed);
    const location = consentStartLocation(`?q=${encodeURIComponent(packed)}`);
    expect(location).toBe(
      `${OAUTH_CONSENT_PATH}?q=${encodeURIComponent(packed)}`
    );
  });

  it('returns null without a client_id or packed q', () => {
    expect(consentStartLocation('?foo=bar')).toBeNull();
    expect(consentStartLocation('')).toBeNull();
  });
});

describe('needsOAuthQueryPack / consentPageHref', () => {
  it('packs a signed query and leaves a packed q alone', () => {
    expect(needsOAuthQueryPack(signed)).toBe(true);
    expect(needsOAuthQueryPack(qssMangled)).toBe(true);
    const packedHref = consentPageHref(signed);
    expect(
      needsOAuthQueryPack(packedHref.slice(OAUTH_CONSENT_PATH.length))
    ).toBe(false);
    expect(consentPageHref(packedHref.slice(OAUTH_CONSENT_PATH.length))).toBe(
      packedHref
    );
  });
});

describe('resolveOAuthQuery', () => {
  it('unpacks q, a bare token, or returns the raw signed query', () => {
    const packed = packOAuthQuery(signed);
    expect(resolveOAuthQuery(`?q=${packed}`)).toBe(signed);
    expect(resolveOAuthQuery(packed)).toBe(signed);
    expect(resolveOAuthQuery(signed)).toBe(signed);
    expect(resolveOAuthQuery('client_id=c1')).toBe('?client_id=c1');
  });
});

describe('displayFieldsFromOAuthQuery', () => {
  it('reads client_id and redirect_uri', () => {
    expect(
      displayFieldsFromOAuthQuery(
        '?client_id=c1&redirect_uri=http://127.0.0.1/cb&scope=openid'
      )
    ).toEqual({
      clientId: 'c1',
      scope: 'openid',
      redirectUri: 'http://127.0.0.1/cb',
    });
  });
});
