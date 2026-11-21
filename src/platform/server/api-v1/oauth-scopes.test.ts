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

  it('requires models:invoke for every gateway request, reads included', () => {
    for (const [method, path] of [
      ['GET', '/api/v1/gateway/models'],
      ['POST', '/api/v1/gateway/jobs'],
      ['GET', '/api/v1/gateway/jobs/01JOB'],
      ['GET', '/api/v1/gateway'],
    ] as const) {
      expect(requiredOAuthScope(req(method, path))).toBe('models:invoke');
    }
    expect(requiredOAuthScope(req('GET', '/api/v1/gatewayish'))).toBe(
      'sequences:read'
    );
  });

  it('reads the path as the case-insensitive router matches it', () => {
    for (const [method, path] of [
      ['POST', '/api/v1/GATEWAY/jobs'],
      ['GET', '/api/v1/Gateway/jobs/01JOB'],
      ['POST', '/api/v1/%67ateway/jobs'],
      ['POST', '/api/v1//gateway/jobs'],
    ] as const) {
      expect(requiredOAuthScope(req(method, path))).toBe('models:invoke');
    }
    expect(requiredOAuthScope(req('POST', '/api/v1/Sequences'))).toBe(
      'generate'
    );
  });

  it('ignores non-v1 paths', () => {
    expect(requiredOAuthScope(req('GET', '/api/auth/session'))).toBeNull();
  });
});
