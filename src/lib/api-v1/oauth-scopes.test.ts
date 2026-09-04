import { describe, expect, it } from 'vitest';
import { requiredOAuthScope } from './oauth-scopes';

const req = (method: string, path: string) =>
  new Request(`https://openstory.test${path}`, { method });

describe('requiredOAuthScope', () => {
  it('leaves discovery and device login public', () => {
    expect(requiredOAuthScope(req('GET', '/api/v1'))).toBeNull();
    expect(requiredOAuthScope(req('GET', '/api/v1/'))).toBeNull();
    expect(requiredOAuthScope(req('GET', '/api/v1/openapi.json'))).toBeNull();
    expect(requiredOAuthScope(req('POST', '/api/v1/device/code'))).toBeNull();
    expect(requiredOAuthScope(req('GET', '/api/v1/device/token'))).toBeNull();
  });

  it('requires sequences:read for reads', () => {
    expect(requiredOAuthScope(req('GET', '/api/v1/sequences'))).toBe(
      'sequences:read'
    );
    expect(requiredOAuthScope(req('GET', '/api/v1/sequences/abc'))).toBe(
      'sequences:read'
    );
    expect(
      requiredOAuthScope(req('GET', '/api/v1/sequences/abc/exports'))
    ).toBe('sequences:read');
    expect(requiredOAuthScope(req('HEAD', '/api/v1/styles'))).toBe(
      'sequences:read'
    );
  });

  it('requires generate for credit-spending mutations', () => {
    expect(requiredOAuthScope(req('POST', '/api/v1/sequences'))).toBe(
      'generate'
    );
    expect(requiredOAuthScope(req('POST', '/api/v1/sequences/'))).toBe(
      'generate'
    );
    expect(requiredOAuthScope(req('POST', '/api/v1/scripts/enhance'))).toBe(
      'generate'
    );
  });

  it('requires sequences:write for other mutations', () => {
    expect(
      requiredOAuthScope(req('POST', '/api/v1/sequences/abc/exports'))
    ).toBe('sequences:write');
    expect(requiredOAuthScope(req('PATCH', '/api/v1/styles/abc'))).toBe(
      'sequences:write'
    );
    expect(requiredOAuthScope(req('DELETE', '/api/v1/styles/abc'))).toBe(
      'sequences:write'
    );
    expect(requiredOAuthScope(req('POST', '/api/v1/sequences/abc'))).toBe(
      'sequences:write'
    );
  });

  it('ignores non-v1 paths', () => {
    expect(requiredOAuthScope(req('GET', '/api/auth/session'))).toBeNull();
  });
});
