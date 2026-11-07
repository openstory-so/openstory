/**
 * The request's PostHog ids reach every record logged inside it (#2282):
 * the header mapping, and LogTape's implicit context carrying it through an
 * awaited call without the call site naming it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { configureSync, getLogger, withContext } from '@logtape/logtape';
import type { LogRecord } from '@logtape/logtape';
import { describe, expect, it } from 'vitest';
import { logContextFromHeaders } from './middleware.fn';

describe('logContextFromHeaders', () => {
  it('maps the two tracing headers and skips absent ones', () => {
    expect(
      logContextFromHeaders(
        new Headers({
          'x-posthog-session-id': 'sess-1',
          'x-posthog-distinct-id': 'user-1',
        })
      )
    ).toEqual({ posthogSessionId: 'sess-1', posthogDistinctId: 'user-1' });
    expect(logContextFromHeaders(new Headers())).toEqual({});
  });
});

describe('withContext', () => {
  it('stamps nested context on a record logged inside an awaited call', async () => {
    const records: LogRecord[] = [];
    configureSync({
      reset: true,
      contextLocalStorage: new AsyncLocalStorage(),
      sinks: { memory: (record) => records.push(record) },
      loggers: [{ category: ['ctx'], sinks: ['memory'], lowestLevel: 'debug' }],
    });

    await withContext({ posthogSessionId: 'sess-1' }, () =>
      withContext({ userId: 'user-1' }, async () => {
        await Promise.resolve();
        getLogger(['ctx']).info('hello', { fnName: 'f' });
      })
    );

    expect(records[0]?.properties).toEqual({
      posthogSessionId: 'sess-1',
      userId: 'user-1',
      fnName: 'f',
    });
  });
});
