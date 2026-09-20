import { describe, expect, it } from 'vitest';
import {
  allocateRoutes,
  DEV_TUNNEL_PORTS,
  E2E_ORIGIN,
  E2E_PORT,
  googleCallbackUrls,
  hostnameForLabel,
  isDevTunnelPort,
  isReservedLabel,
  isTunnelAppHostname,
  originForPort,
  randomLabel,
  tunnelIngressConfig,
  type DevTunnelsFile,
} from './dev-hosts';

describe('dev host ports', () => {
  it('reserves 3000–3009 for local HTTPS worktrees and 3020 for e2e', () => {
    expect(DEV_TUNNEL_PORTS).toEqual([
      3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009,
    ]);
    expect(isDevTunnelPort(3000)).toBe(true);
    expect(isDevTunnelPort(3009)).toBe(true);
    expect(isDevTunnelPort(3010)).toBe(false);
    expect(E2E_PORT).toBe(3020);
    expect(isDevTunnelPort(E2E_PORT)).toBe(false);
    expect(E2E_ORIGIN).toBe('http://localhost:3020');
  });
});

describe('allocateRoutes', () => {
  it('maps each reserved port to a unique openstory.so hostname', () => {
    let n = 0;
    const routes = allocateRoutes(() => {
      const bytes = new Uint8Array(8);
      bytes.fill(n);
      n += 1;
      return bytes;
    });
    expect(routes).toHaveLength(10);
    expect(routes[0]?.port).toBe(3000);
    expect(routes[9]?.port).toBe(3009);
    const hosts = new Set(routes.map((r) => r.hostname));
    expect(hosts.size).toBe(10);
    for (const route of routes) {
      expect(route.hostname.endsWith('.openstory.so')).toBe(true);
      expect(isReservedLabel(route.hostname.split('.')[0] ?? '')).toBe(false);
    }
  });

  it('skips reserved labels such as www and dev1', () => {
    expect(isReservedLabel('www')).toBe(true);
    expect(isReservedLabel('dev1')).toBe(true);
    expect(hostnameForLabel('qk3mnpst')).toBe('qk3mnpst.openstory.so');
  });
});

describe('origin lookup', () => {
  const file: DevTunnelsFile = {
    v: 1,
    tunnelName: 'openstory-dev-box',
    tunnelId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    zone: 'openstory.so',
    routes: [
      { port: 3000, hostname: 'alpha.openstory.so' },
      { port: 3001, hostname: 'bravo.openstory.so' },
    ],
  };

  it('turns a worktree port into the public origin', () => {
    expect(originForPort(file, 3000)).toBe('https://alpha.openstory.so');
    expect(originForPort(file, 3001)).toBe('https://bravo.openstory.so');
    expect(originForPort(file, 3002)).toBeUndefined();
  });

  it('lists Google OAuth callback URIs for manual registration', () => {
    expect(googleCallbackUrls(file)).toEqual([
      'https://alpha.openstory.so/api/auth/callback/google',
      'https://bravo.openstory.so/api/auth/callback/google',
    ]);
  });
});

describe('tunnelIngressConfig', () => {
  it('publishes each hostname to its loopback port and 404s the rest', () => {
    expect(
      tunnelIngressConfig([
        { port: 3000, hostname: 'alpha.openstory.so' },
        { port: 3001, hostname: 'bravo.openstory.so' },
      ])
    ).toEqual({
      ingress: [
        {
          hostname: 'alpha.openstory.so',
          service: 'http://127.0.0.1:3000',
        },
        {
          hostname: 'bravo.openstory.so',
          service: 'http://127.0.0.1:3001',
        },
        { service: 'http_status:404' },
      ],
    });
  });
});

describe('isTunnelAppHostname', () => {
  it('matches machine-private subdomains, not production hosts', () => {
    expect(isTunnelAppHostname('qk3mnpst.openstory.so')).toBe(true);
    expect(isTunnelAppHostname('openstory.so')).toBe(false);
    expect(isTunnelAppHostname('www.openstory.so')).toBe(false);
    expect(isTunnelAppHostname('app.openstory.so')).toBe(false);
    expect(isTunnelAppHostname('assets.openstory.so')).toBe(false);
    expect(isTunnelAppHostname('localhost')).toBe(false);
  });
});

describe('randomLabel', () => {
  it('is deterministic for a given byte string', () => {
    expect(randomLabel(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]))).toBe(
      randomLabel(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]))
    );
  });
});
