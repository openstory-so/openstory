import { describe, expect, it } from 'vitest';
import {
  isStaleServerFnPath,
  isUnhandledMissingServerFn,
  rewriteStaleServerFnResponse,
  STALE_SERVER_FN_HEADER,
  staleServerFnResponse,
} from './stale-server-fn';

describe('isStaleServerFnPath', () => {
  it('matches the Start server-fn prefix', () => {
    expect(isStaleServerFnPath('/_serverFn/abc')).toBe(true);
    expect(isStaleServerFnPath('/api/realtime')).toBe(false);
  });
});

describe('isUnhandledMissingServerFn', () => {
  const headers = new Headers({ 'content-type': 'application/json' });

  it("matches h3's unhandled HTTPError JSON", () => {
    expect(
      isUnhandledMissingServerFn(
        500,
        headers,
        JSON.stringify({
          status: 500,
          unhandled: true,
          message: 'HTTPError',
        })
      )
    ).toBe(true);
  });

  it("matches Start's missing-id throw if it surfaces as text", () => {
    expect(
      isUnhandledMissingServerFn(
        500,
        headers,
        'Error: Server function info not found for deadbeef'
      )
    ).toBe(true);
  });

  it('leaves serialized server-fn errors alone', () => {
    const serialized = new Headers({ 'x-tss-serialized': 'true' });
    expect(
      isUnhandledMissingServerFn(
        500,
        serialized,
        JSON.stringify({ unhandled: true, message: 'HTTPError' })
      )
    ).toBe(false);
  });

  it('leaves other 500s alone', () => {
    expect(isUnhandledMissingServerFn(500, headers, '{"error":"boom"}')).toBe(
      false
    );
    expect(isUnhandledMissingServerFn(200, headers, 'HTTPError')).toBe(false);
  });
});

describe('rewriteStaleServerFnResponse', () => {
  it('rewrites the unhandled 500 to a marked 404', async () => {
    const incoming = new Response(
      JSON.stringify({ status: 500, unhandled: true, message: 'HTTPError' }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
    const rewritten = await rewriteStaleServerFnResponse(incoming);
    expect(rewritten.status).toBe(404);
    expect(rewritten.headers.get(STALE_SERVER_FN_HEADER)).toBe('1');
    expect(await rewritten.text()).toBe('stale server function');
  });

  it('returns a real 500 unchanged', async () => {
    const incoming = new Response('nope', { status: 500 });
    const rewritten = await rewriteStaleServerFnResponse(incoming);
    expect(rewritten).toBe(incoming);
    expect(await rewritten.text()).toBe('nope');
  });
});

describe('staleServerFnResponse', () => {
  it('is a 404 with the client-facing marker', () => {
    const response = staleServerFnResponse();
    expect(response.status).toBe(404);
    expect(response.headers.get(STALE_SERVER_FN_HEADER)).toBe('1');
  });
});
