import { describe, expect, it } from 'vitest';
import {
  onPrimary,
  parseBookmark,
  routeD1,
  runInReadSession,
} from './d1-session';

const fake = (name: string, log: string[]) => ({
  prepare: (sql: string) => {
    log.push(`${name}:${sql}`);
    return { sql };
  },
  batch: (stmts: unknown[]) => {
    log.push(`${name}:batch`);
    return Promise.resolve(stmts);
  },
});

const setup = () => {
  const log: string[] = [];
  const session = { ...fake('replica', log), getBookmark: () => 'bm-1' };
  const withSession = (b: string) => {
    log.push(`withSession:${b}`);
    return session;
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double
  const db = { ...fake('primary', log), withSession } as unknown as D1Database;
  return { log, db, routed: routeD1(() => db) };
};

describe('d1 read session', () => {
  it('sends every query to the session and reports where it ended', async () => {
    const { log, db, routed } = setup();
    const out = await runInReadSession(db, 'bm-0', async () => {
      routed.prepare('select 1');
      await routed.batch([]);
      return 'ok';
    });
    expect(out).toEqual({ value: 'ok', bookmark: 'bm-1' });
    expect(log).toEqual([
      'withSession:bm-0',
      'replica:select 1',
      'replica:batch',
    ]);
  });

  it('onPrimary sends queries to the primary, then goes back', async () => {
    const { log, db, routed } = setup();
    await runInReadSession(db, 'first-unconstrained', async () => {
      await onPrimary(async () => routed.prepare('select balance'));
      routed.prepare('select 2');
    });
    expect(log.slice(1)).toEqual([
      'primary:select balance',
      'replica:select 2',
    ]);
  });

  it('uses the primary outside a request', () => {
    const { log, routed } = setup();
    routed.prepare('select 1');
    expect(log).toEqual(['primary:select 1']);
  });

  it('ignores a cookie that is not a plain token', () => {
    expect(parseBookmark('a=1; d1_bookmark=0000-aa; b=2')).toBe('0000-aa');
    expect(parseBookmark('d1_bookmark=x y;z')).toBeUndefined();
    expect(parseBookmark(null)).toBeUndefined();
  });
});
