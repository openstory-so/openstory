/**
 * Per-machine local HTTPS hostnames (#740).
 *
 * Ports 3000–3009 are reserved for `bun dev` worktrees. Each machine stores
 * its own random `*.openstory.so` map in ~/.openstory/dev-tunnels.json
 * (not git). E2E uses 3020 so it never collides with those slots.
 */

const DEV_TUNNEL_PORT_COUNT = 10;
const DEV_TUNNEL_BASE_PORT = 3000;
export const E2E_PORT = 3020;
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
export const DEV_TUNNEL_ZONE = 'openstory.so';
export const DEV_TUNNELS_RELATIVE_PATH = '.openstory/dev-tunnels.json';

export const DEV_TUNNEL_PORTS: readonly number[] = Array.from(
  { length: DEV_TUNNEL_PORT_COUNT },
  (_, i) => DEV_TUNNEL_BASE_PORT + i
);

const RESERVED_LABELS = new Set([
  'www',
  'app',
  'api',
  'assets',
  'cdn',
  'mail',
  'mcp',
  'auth',
  'admin',
  'staging',
  'preview',
  'local',
  'dev',
  'dev1',
  'dev2',
  'dev3',
  'dev4',
  'dev5',
  'dev6',
  'dev7',
  'dev8',
  'dev9',
  'dev10',
]);

const LABEL_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const LABEL_LENGTH = 8;

export type DevTunnelRoute = {
  port: number;
  hostname: string;
};

export type DevTunnelsFile = {
  v: 1;
  tunnelName: string;
  tunnelId: string;
  zone: string;
  routes: DevTunnelRoute[];
};

export function isDevTunnelPort(port: number): boolean {
  return (
    port >= DEV_TUNNEL_BASE_PORT &&
    port < DEV_TUNNEL_BASE_PORT + DEV_TUNNEL_PORT_COUNT
  );
}

export function originForPort(
  file: DevTunnelsFile,
  port: number
): string | undefined {
  const route = file.routes.find((r) => r.port === port);
  return route ? `https://${route.hostname}` : undefined;
}

export function googleCallbackUrls(file: DevTunnelsFile): string[] {
  return file.routes.map(
    (route) => `https://${route.hostname}/api/auth/callback/google`
  );
}

export function isReservedLabel(label: string): boolean {
  return RESERVED_LABELS.has(label.toLowerCase());
}

export function randomLabel(bytes: Uint8Array): string {
  if (bytes.length < LABEL_LENGTH) {
    throw new Error(`Need ${LABEL_LENGTH} random bytes for a hostname label`);
  }
  let label = '';
  for (let i = 0; i < LABEL_LENGTH; i++) {
    const byte = bytes[i] ?? 0;
    label += LABEL_ALPHABET[byte % LABEL_ALPHABET.length];
  }
  return label;
}

export function hostnameForLabel(label: string): string {
  return `${label}.${DEV_TUNNEL_ZONE}`;
}

export function allocateRoutes(
  nextBytes: () => Uint8Array,
  existing: ReadonlySet<string> = new Set()
): DevTunnelRoute[] {
  const taken = new Set(existing);
  const routes: DevTunnelRoute[] = [];
  for (const port of DEV_TUNNEL_PORTS) {
    let label = randomLabel(nextBytes());
    let guard = 0;
    while (isReservedLabel(label) || taken.has(label)) {
      label = randomLabel(nextBytes());
      guard += 1;
      if (guard > 50) {
        throw new Error('Could not allocate a unique hostname label');
      }
    }
    taken.add(label);
    routes.push({ port, hostname: hostnameForLabel(label) });
  }
  return routes;
}

export function tunnelIngressConfig(routes: readonly DevTunnelRoute[]): {
  ingress: Array<{ hostname?: string; service: string }>;
} {
  return {
    ingress: [
      ...routes.map((route) => ({
        hostname: route.hostname,
        service: `http://127.0.0.1:${route.port}`,
      })),
      { service: 'http_status:404' },
    ],
  };
}

export function isTunnelAppHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().split(':')[0] ?? hostname;
  if (!host.endsWith(`.${DEV_TUNNEL_ZONE}`)) return false;
  if (host === DEV_TUNNEL_ZONE || host === `www.${DEV_TUNNEL_ZONE}`) {
    return false;
  }
  if (
    host === `assets.${DEV_TUNNEL_ZONE}` ||
    host === `app.${DEV_TUNNEL_ZONE}`
  ) {
    return false;
  }
  return true;
}
