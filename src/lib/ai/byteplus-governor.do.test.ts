import { describe, expect, it } from 'vitest';
import { BytePlusGovernor } from './byteplus-governor.do';

const bucket = {
  bucket: 'assets-write',
  capacity: 3,
  refillPerMinute: 60,
  maxWaitMs: 60_000,
};

function governor(): BytePlusGovernor {
  return new BytePlusGovernor(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- in-memory DO reads neither ctx nor env
    {} as DurableObjectState,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- in-memory DO reads neither ctx nor env
    {} as Cloudflare.Env
  );
}

describe('BytePlusGovernor.acquire', () => {
  it('hands out the burst for free, then paces at the refill rate in arrival order', () => {
    const g = governor();
    const t0 = 1_000_000;
    // 60/min = one token per second.
    expect(g.acquire(bucket, t0)).toBe(0);
    expect(g.acquire(bucket, t0)).toBe(0);
    expect(g.acquire(bucket, t0)).toBe(0);
    expect(g.acquire(bucket, t0)).toBe(1_000);
    expect(g.acquire(bucket, t0)).toBe(2_000);
    expect(g.acquire(bucket, t0)).toBe(3_000);
  });

  it('refills with elapsed time and never above capacity', () => {
    const g = governor();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i += 1) g.acquire(bucket, t0);
    // Two seconds later the debt of two is paid but nothing is spare, so the
    // next call still waits one interval; a third second makes it free.
    expect(g.acquire(bucket, t0 + 2_000)).toBe(1_000);
    expect(g.acquire(bucket, t0 + 4_000)).toBe(0);
    // An hour idle refills to capacity (3), not to 3600.
    expect(g.acquire(bucket, t0 + 3_600_000)).toBe(0);
    expect(g.acquire(bucket, t0 + 3_600_000)).toBe(0);
    expect(g.acquire(bucket, t0 + 3_600_000)).toBe(0);
    expect(g.acquire(bucket, t0 + 3_600_000)).toBe(1_000);
  });

  it('refuses without reserving when the wait would exceed maxWaitMs', () => {
    const g = governor();
    const t0 = 1_000_000;
    const tight = { ...bucket, maxWaitMs: 1_500 };
    for (let i = 0; i < 3; i += 1) g.acquire(tight, t0);
    expect(g.acquire(tight, t0)).toBe(1_000);
    // Would be 2000ms: refused, and the bucket's debt stays at one.
    expect(g.acquire(tight, t0)).toBe(-1);
    expect(g.acquire({ ...tight, maxWaitMs: 60_000 }, t0)).toBe(2_000);
  });

  it('keeps buckets independent', () => {
    const g = governor();
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i += 1) g.acquire(bucket, t0);
    expect(g.acquire({ ...bucket, bucket: 'other' }, t0)).toBe(0);
  });
});
