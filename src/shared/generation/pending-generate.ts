/**
 * Pending composer intent (#1187, #1286).
 *
 * When an anonymous visitor clicks Generate or Enhance Script, the auth gate
 * interrupts with the sign-in dialog. Remember the click here so the composer
 * can pick the flow back up after sign-in. Short expiry: a stale click must
 * not fire a generation the user no longer expects.
 */
const STORAGE_KEY = 'openstory:pending-generate';
const EXPIRY_MS = 10 * 60 * 1000;

export type PendingIntent = 'generate' | 'enhance';

export function markPendingIntent(action: PendingIntent): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, `${action}:${Date.now()}`);
  } catch {
    // localStorage unavailable — the user just clicks again.
  }
}

function peek(): PendingIntent | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    // Legacy #1187: a bare timestamp meant Generate.
    const asNum = Number(raw);
    if (Number.isFinite(asNum)) {
      return Date.now() - asNum <= EXPIRY_MS ? 'generate' : null;
    }
    const colon = raw.indexOf(':');
    if (colon < 0) return null;
    const action = raw.slice(0, colon);
    const at = Number(raw.slice(colon + 1));
    if (
      (action === 'generate' || action === 'enhance') &&
      Number.isFinite(at) &&
      Date.now() - at <= EXPIRY_MS
    ) {
      return action;
    }
    return null;
  } catch {
    return null;
  }
}

/** Non-consuming peek — welcome-credits CTA without eating the intent. */
export function hasPendingGenerate(): boolean {
  return peek() != null;
}

/** Read-and-clear. The action to resume, or null if nothing fresh is stored. */
export function takePendingIntent(): PendingIntent | null {
  const action = peek();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable — nothing stored to clear.
  }
  return action;
}
