import { describe, expect, it } from 'vitest';
import {
  PUBLIC_API_KEY_PREFIX,
  readPublicApiKeyFromHeaders,
} from './public-api-key';

describe('readPublicApiKeyFromHeaders', () => {
  it('returns an osk_ Bearer value', () => {
    expect(
      readPublicApiKeyFromHeaders(
        new Headers({ authorization: 'Bearer osk_abc' })
      )
    ).toBe('osk_abc');
  });

  it('ignores a JWT Bearer so it is not looked up as a key', () => {
    expect(
      readPublicApiKeyFromHeaders(
        new Headers({ authorization: 'Bearer eyJhbGciOiJFZERTQSJ9.e30.sig' })
      )
    ).toBeNull();
  });

  it('reads x-api-key when there is no Bearer', () => {
    expect(
      readPublicApiKeyFromHeaders(new Headers({ 'x-api-key': 'osk_abc' }))
    ).toBe('osk_abc');
  });

  it('uses the branded prefix', () => {
    expect(PUBLIC_API_KEY_PREFIX).toBe('osk_');
  });
});
