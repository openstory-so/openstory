import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request D1 Sessions API state (#2233); see docs/architecture/d1-read-replication.md. */
type Store = { session: D1DatabaseSession; pinned: boolean };

const als = new AsyncLocalStorage<Store>();

export const D1_BOOKMARK_COOKIE = 'd1_bookmark';

/** The cookie is client-controlled, so only a plain token goes to D1. */
const BOOKMARK_RE = /^[\w-]{1,128}$/;

export function parseBookmark(cookieHeader: string | null): string | undefined {
  const raw = cookieHeader?.match(
    new RegExp(`(?:^|;\\s*)${D1_BOOKMARK_COOKIE}=([^;]*)`)
  )?.[1];
  return raw && BOOKMARK_RE.test(raw) ? raw : undefined;
}

/**
 * The handle drizzle gets: this request's session when one is open, else the
 * primary (workflows, cron, auth outside a request). A write inside a session
 * is forwarded to the primary by D1 itself.
 */
export function routeD1(primary: () => D1Database): D1Database {
  const target = () => {
    const s = als.getStore();
    return s && !s.pinned ? s.session : primary();
  };
  const handle = {
    prepare: (sql: string) => target().prepare(sql),
    batch: (statements: D1PreparedStatement[]) => target().batch(statements),
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- drizzle's D1 driver calls only prepare and batch
  return handle as unknown as D1Database;
}

/** Run `fn` in a session started at `start` (a bookmark or a constraint); `bookmark` is where it ended. */
export async function runInReadSession<T>(
  db: D1Database,
  start: string,
  fn: () => Promise<T>
): Promise<{ value: T; bookmark: string | null }> {
  const session = db.withSession(start);
  const value = await als.run({ session, pinned: false }, fn);
  return { value, bookmark: session.getBookmark() };
}

/** Read from the primary: money guards, where a replica's lag could pass a spend another session just made. */
export function onPrimary<T>(fn: () => Promise<T>): Promise<T> {
  const s = als.getStore();
  return s ? als.run({ ...s, pinned: true }, fn) : fn();
}
