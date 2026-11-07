/**
 * ElevenLabs concurrency governor: the account's concurrent-request slots,
 * held in one Durable Object so every run sees them (#2295).
 *
 * The plan's concurrency limit is per ACCOUNT, shared by every organization.
 * A third request in flight gets `429 concurrent_limit_exceeded`, so a run
 * takes a slot here before it calls and gives it back after. A slot is a
 * lease: a Worker that dies mid-call loses it when the lease ends. Waiters
 * poll; there is no queue order.
 */

import { DurableObject } from 'cloudflare:workers';

/** Holder id → lease end, epoch ms. */
type Leases = Record<string, number>;

const LEASES_KEY = 'leases';

export type SlotInput = {
  /** One id per call, so a release frees only its own slot. */
  holder: string;
  /** The account's concurrent-request limit. */
  slots: number;
  /** How long the slot stays held if the caller never releases it. */
  leaseMs: number;
};

export class ElevenLabsGovernor extends DurableObject {
  /** Take a slot. False when every slot is held by a live lease. */
  acquire(input: SlotInput, now = Date.now()): boolean {
    const leases = this.liveLeases(now);
    const free = Object.keys(leases).length < Math.max(1, input.slots);
    if (free) leases[input.holder] = now + input.leaseMs;
    this.ctx.storage.kv.put(LEASES_KEY, leases);
    return free;
  }

  release(holder: string, now = Date.now()): void {
    const leases = this.liveLeases(now);
    delete leases[holder];
    this.ctx.storage.kv.put(LEASES_KEY, leases);
  }

  private liveLeases(now: number): Leases {
    const stored = this.ctx.storage.kv.get<Leases>(LEASES_KEY) ?? {};
    return Object.fromEntries(
      Object.entries(stored).filter(([, endsAt]) => endsAt > now)
    );
  }
}
