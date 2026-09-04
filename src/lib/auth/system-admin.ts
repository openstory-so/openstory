import { getEnv } from '#env';
import { AuthenticationError } from '@/lib/errors';
import { createServerOnlyFn } from '@tanstack/react-start';

function parseAdminEmails(): string[] {
  const raw = getEnv().ADMIN_EMAILS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Server-only: an admin check that silently returned `false` in a client
 * bundle would read as "not an admin" instead of failing, so the Start
 * compiler replaces this with a throwing stub there (and drops the
 * `ADMIN_EMAILS` read with it).
 */
export const isSystemAdmin = createServerOnlyFn((email: string): boolean =>
  parseAdminEmails().includes(email.toLowerCase())
);

export function getInternalDomains(): string[] {
  const domains = new Set<string>();
  for (const email of parseAdminEmails()) {
    const at = email.lastIndexOf('@');
    if (at > 0 && at < email.length - 1) {
      domains.add(email.slice(at + 1));
    }
  }
  return [...domains];
}

export function requireSystemAdmin(email: string): void {
  if (!isSystemAdmin(email)) {
    throw new AuthenticationError('System admin access required');
  }
}
