/**
 * Pre-allocated local-dev HTTPS slots (#740).
 *
 * Each slot is its own named Cloudflare tunnel (`openstory-devN`) and public
 * hostname (`devN.openstory.so`), bound to a fixed loopback port. One shared
 * tunnel with ten CNAMEs cannot isolate worktrees: extra `cloudflared`
 * connectors on the same tunnel are load-balanced, so a request for `dev2`
 * can land on the process that only serves `dev1`.
 */

export const DEV_TUNNEL_SLOT_COUNT = 10;
const DEV_TUNNEL_BASE_PORT = 3000;
const DEV_TUNNEL_DOMAIN = 'openstory.so';

export const DEV_TUNNEL_SLOT_NAMES = [
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
] as const;

export type DevTunnelSlotName = (typeof DEV_TUNNEL_SLOT_NAMES)[number];

const SLOT_NAME_RE = /^dev([1-9]|10)$/;
const HOSTNAME_RE = /^dev([1-9]|10)\.openstory\.so$/;

export function isDevTunnelSlotName(value: string): value is DevTunnelSlotName {
  return (DEV_TUNNEL_SLOT_NAMES as readonly string[]).includes(value);
}

export function devTunnelSlotNumber(slot: DevTunnelSlotName): number {
  const match = SLOT_NAME_RE.exec(slot);
  if (!match) throw new Error(`Invalid tunnel slot: ${slot}`);
  return Number(match[1]);
}

export function devTunnelHostname(slot: DevTunnelSlotName): string {
  return `${slot}.${DEV_TUNNEL_DOMAIN}`;
}

export function devTunnelOrigin(slot: DevTunnelSlotName): string {
  return `https://${devTunnelHostname(slot)}`;
}

export function devTunnelLocalPort(slot: DevTunnelSlotName): number {
  return DEV_TUNNEL_BASE_PORT + devTunnelSlotNumber(slot) - 1;
}

export function devTunnelName(slot: DevTunnelSlotName): string {
  return `openstory-${slot}`;
}

export function isDevTunnelHostname(hostname: string): boolean {
  return HOSTNAME_RE.test(hostname.toLowerCase());
}

export function slotFromHostname(
  hostname: string
): DevTunnelSlotName | undefined {
  const host = hostname.toLowerCase().split(':')[0] ?? hostname;
  if (!isDevTunnelHostname(host)) return undefined;
  const slot = host.slice(0, host.indexOf('.'));
  return isDevTunnelSlotName(slot) ? slot : undefined;
}

export function slotFromOrigin(
  origin: string | undefined
): DevTunnelSlotName | undefined {
  if (!origin) return undefined;
  try {
    return slotFromHostname(new URL(origin).hostname);
  } catch {
    return undefined;
  }
}

export const DEV_TUNNEL_ORIGINS: readonly string[] =
  DEV_TUNNEL_SLOT_NAMES.map(devTunnelOrigin);
