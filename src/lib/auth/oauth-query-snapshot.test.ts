import { describe, expect, it } from 'vitest';
import {
  displayFieldsFromOAuthQuery,
  pickOAuthQuery,
  scoreOAuthQuery,
} from './oauth-query-snapshot';

const signed =
  '?client_id=c1&sig=abc&ba_param=client_id&ba_param=sig&ba_param=scope';
const mangled = '?client_id=c1&sig=abc&ba_param=scope';

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
