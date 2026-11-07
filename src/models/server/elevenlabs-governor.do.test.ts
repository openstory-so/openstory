import { describe, expect, it } from 'vitest';
import { ElevenLabsGovernor } from './elevenlabs-governor.do';
import { asStub } from '@/test/as-stub';

const slot = (holder: string) => ({ holder, slots: 2, leaseMs: 60_000 });

function governor(store = new Map<string, unknown>()): ElevenLabsGovernor {
  const kv = {
    get: (key: string) => store.get(key),
    put: (key: string, value: unknown) => void store.set(key, value),
  };
  return new ElevenLabsGovernor(
    // the DO reads only ctx.storage.kv
    asStub<DurableObjectState>({ storage: { kv } }),
    // the DO reads no env
    asStub<Cloudflare.Env>({})
  );
}

describe('ElevenLabsGovernor', () => {
  it('holds a third caller until a slot is released', () => {
    const g = governor();
    const t0 = 1_000_000;
    expect(g.acquire(slot('a'), t0)).toBe(true);
    expect(g.acquire(slot('b'), t0)).toBe(true);
    expect(g.acquire(slot('c'), t0)).toBe(false);
    g.release('a', t0);
    expect(g.acquire(slot('c'), t0)).toBe(true);
  });

  it('frees the slot of a holder that never released once its lease ends', () => {
    const g = governor();
    const t0 = 1_000_000;
    g.acquire(slot('a'), t0);
    g.acquire(slot('b'), t0 + 30_000);
    expect(g.acquire(slot('c'), t0 + 59_999)).toBe(false);
    expect(g.acquire(slot('c'), t0 + 60_000)).toBe(true);
    expect(g.acquire(slot('d'), t0 + 60_000)).toBe(false);
  });

  it('lets a holder take its own slot again', () => {
    const g = governor();
    const t0 = 1_000_000;
    g.acquire(slot('a'), t0);
    g.acquire(slot('b'), t0);
    expect(g.acquire(slot('a'), t0)).toBe(true);
  });

  it('keeps its leases across an eviction', () => {
    const store = new Map<string, unknown>();
    const t0 = 1_000_000;
    governor(store).acquire(slot('a'), t0);
    governor(store).acquire(slot('b'), t0);
    expect(governor(store).acquire(slot('c'), t0)).toBe(false);
  });
});
