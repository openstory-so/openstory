import { describe, expect, it } from 'vitest';
import {
  inferNativeRegistration,
  withInferredApplicationType,
} from './oauth-client-registration';

describe('withInferredApplicationType', () => {
  it('reads an http loopback client with no type as native', () => {
    for (const uri of [
      'http://localhost:53999/callback',
      'http://127.0.0.1:8080/cb',
      'http://[::1]:9000/cb',
    ]) {
      expect(withInferredApplicationType({ redirect_uris: [uri] })).toEqual({
        redirect_uris: [uri],
        application_type: 'native',
      });
    }
  });

  it('leaves a stated type, a hosted client and a mixed list alone', () => {
    const stated = {
      application_type: 'web',
      redirect_uris: ['http://localhost:1/cb'],
    };
    const hosted = { redirect_uris: ['https://claude.ai/api/mcp/callback'] };
    const mixed = {
      redirect_uris: ['http://localhost:1/cb', 'https://example.com/cb'],
    };
    const lookalike = { redirect_uris: ['http://localhost.evil.com/cb'] };
    for (const body of [stated, hosted, mixed, lookalike, {}, null, 'x']) {
      expect(withInferredApplicationType(body)).toBe(body);
    }
  });
});

describe('inferNativeRegistration', () => {
  it('rewrites the body and keeps the rest of the request', async () => {
    const request = new Request('https://x/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '1.2.3.4' },
      body: JSON.stringify({ redirect_uris: ['http://localhost:5/cb'] }),
    });
    const out = await inferNativeRegistration(request);
    expect(out.headers.get('x-real-ip')).toBe('1.2.3.4');
    expect(await out.json()).toEqual({
      redirect_uris: ['http://localhost:5/cb'],
      application_type: 'native',
    });
  });

  it('hands unreadable JSON to the provider untouched', async () => {
    const request = new Request('https://x/api/auth/oauth2/register', {
      method: 'POST',
      body: 'not json',
    });
    expect(await inferNativeRegistration(request)).toBe(request);
  });
});
