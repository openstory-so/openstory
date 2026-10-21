import { describe, expect, it } from 'vitest';
import { logUrl } from './log-url';

const FN_ID = 'eyJmaWxlIjoiL0BpZC9zcmMvc2VxdWVuY2VzL2Zvby5mbi50cyJ9';

describe('logUrl', () => {
  it('keeps the server-fn id but redacts ids in its query', () => {
    expect(logUrl(`https://openstory.so/_serverFn/${FN_ID}?t=${FN_ID}`)).toBe(
      `https://openstory.so/_serverFn/${FN_ID}?t=REDACTED`
    );
  });

  it('redacts token-like path segments elsewhere', () => {
    expect(logUrl(`https://openstory.so/reset-password/${FN_ID}`)).toBe(
      'https://openstory.so/reset-password/REDACTED'
    );
    expect(
      logUrl('https://openstory.so/x/0123456789abcdef0123456789abcdef')
    ).toBe('https://openstory.so/x/REDACTED');
  });

  it('keeps ULIDs and plain words', () => {
    const url = 'https://openstory.so/sequences/01M20W6N5NZGK3XY0TMH594MVR';
    expect(logUrl(url)).toBe(url);
  });
});
