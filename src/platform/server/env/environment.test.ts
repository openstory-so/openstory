import { describe, expect, it } from 'vitest';
import { isLocalRequestHost } from './environment';

function requestWithHosts(opts: {
  url?: string;
  host?: string;
  forwardedHost?: string;
}): Request {
  const headers = new Headers();
  if (opts.host !== undefined) headers.set('host', opts.host);
  if (opts.forwardedHost !== undefined) {
    headers.set('x-forwarded-host', opts.forwardedHost);
  }
  return new Request(opts.url ?? 'http://127.0.0.1:3003/', { headers });
}

describe('isLocalRequestHost', () => {
  it('treats localhost, loopback, and a bare IPv4 as local', () => {
    expect(
      isLocalRequestHost(requestWithHosts({ host: 'localhost:3003' }))
    ).toBe(true);
    expect(
      isLocalRequestHost(requestWithHosts({ host: '127.0.0.1:3003' }))
    ).toBe(true);
    expect(isLocalRequestHost(requestWithHosts({ host: '10.0.0.4' }))).toBe(
      true
    );
  });

  it('treats a tunnel hostname as not local', () => {
    expect(
      isLocalRequestHost(
        requestWithHosts({
          url: 'https://briny-otter.openstory.so/',
          host: 'briny-otter.openstory.so',
        })
      )
    ).toBe(false);
  });

  it('does not treat loopback Host as local when X-Forwarded-Host is the tunnel', () => {
    expect(
      isLocalRequestHost(
        requestWithHosts({
          host: '127.0.0.1:3003',
          forwardedHost: 'briny-otter.openstory.so',
        })
      )
    ).toBe(false);
  });

  it('does not trust a spoofed X-Forwarded-Host: localhost on a tunnel Host', () => {
    expect(
      isLocalRequestHost(
        requestWithHosts({
          url: 'https://briny-otter.openstory.so/',
          host: 'briny-otter.openstory.so',
          forwardedHost: 'localhost',
        })
      )
    ).toBe(false);
  });

  it('fails closed when no Host is present', () => {
    expect(isLocalRequestHost(new Request('http://127.0.0.1:3003/'))).toBe(
      false
    );
  });
});
