import { describe, expect, it } from 'vitest';
import {
  buildCanonicalQuery,
  sha256Hex,
  signBytePlusRequest,
  utcXDate,
} from './byteplus-openapi-sign';

describe('byteplus OpenAPI signing', () => {
  it('hashes the empty payload to the SHA-256 empty digest', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('sorts query keys for the canonical query string', () => {
    expect(
      buildCanonicalQuery({ Version: '2024-01-01', Action: 'CreateAsset' })
    ).toBe('Action=CreateAsset&Version=2024-01-01');
  });

  it('formats X-Date as YYYYMMDDTHHMMSSZ', () => {
    expect(utcXDate(new Date('2026-03-28T00:00:00.000Z'))).toBe(
      '20260328T000000Z'
    );
  });

  it('builds a SigV4 Authorization header for a frozen CreateAsset request', async () => {
    const body =
      '{"GroupId":"group-1","URL":"https://example.com/a.jpg","AssetType":"Image"}';
    const headers = await signBytePlusRequest({
      method: 'POST',
      path: '/',
      query: 'Action=CreateAsset&Version=2024-01-01',
      host: 'ark.ap-southeast-1.byteplusapi.com',
      region: 'ap-southeast-1',
      service: 'ark',
      accessKey: 'AKTEST',
      secretKey: 'sk-test',
      body,
      xDate: '20260328T000000Z',
    });

    expect(headers.Host).toBe('ark.ap-southeast-1.byteplusapi.com');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Date']).toBe('20260328T000000Z');
    expect(headers['X-Content-Sha256']).toBe(await sha256Hex(body));
    expect(headers.Authorization).toMatch(
      /^HMAC-SHA256 Credential=AKTEST\/20260328\/ap-southeast-1\/ark\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/
    );
    // Frozen vector: same inputs must not drift if the canonical string changes.
    expect(headers.Authorization).toContain(
      'Signature=a9018c46e81801d55cdb9d0b0b20cf0f5868262df9a77369c3a6a6423ecbc808'
    );
  });
});
