/**
 * Sign-off queue for the upload rights dialog (#2239).
 *
 * A multi-file drop classifies each file on its own and calls
 * `ensureUploadRights` concurrently. One slot dropped the first caller's
 * resolve, so that upload never settled and Generate stayed disabled.
 * Each owed request is appended; Confirm attests the whole queue once.
 */

import type { UploadRef, UploadRights } from '@/cast/upload-rights';

class UploadRightsDeclinedError extends Error {
  constructor() {
    super('Rights to this person’s likeness were not confirmed');
    this.name = 'UploadRightsDeclinedError';
  }
}

type Waiter = {
  refs: UploadRef[];
  resolve: () => void;
  reject: (error: Error) => void;
};

type UploadRightsQueueSnapshot = {
  /** True while at least one request is waiting on the dialog. */
  open: boolean;
  /** Filename (or URL) of every image still waiting, in arrival order. */
  names: string[];
};

const CLOSED: UploadRightsQueueSnapshot = { open: false, names: [] };

type UploadRightsQueue = {
  ensureUploadRights: (refs: UploadRef[]) => Promise<void>;
  /** Attest every queued ref once, then resolve each waiter. */
  confirm: (attest: (refs: UploadRef[]) => Promise<void>) => Promise<void>;
  /** Reject every waiter. An in-flight confirm will not resolve them. */
  decline: () => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => UploadRightsQueueSnapshot;
};

function uniqueRefs(waiters: readonly Waiter[]): UploadRef[] {
  const seen = new Set<string>();
  const refs: UploadRef[] = [];
  for (const waiter of waiters) {
    for (const ref of waiter.refs) {
      if (seen.has(ref.url)) continue;
      seen.add(ref.url);
      refs.push(ref);
    }
  }
  return refs;
}

function snapshotOf(waiters: readonly Waiter[]): UploadRightsQueueSnapshot {
  if (waiters.length === 0) return CLOSED;
  return {
    open: true,
    names: waiters.flatMap((waiter) =>
      waiter.refs.map((ref) => ref.filename ?? ref.url)
    ),
  };
}

export function createUploadRightsQueue(options: {
  classify: (refs: UploadRef[]) => Promise<Array<UploadRights | undefined>>;
  /** Dialog is about to open from empty. Reset the form here. */
  onShow?: () => void;
}): UploadRightsQueue {
  let waiters: Waiter[] = [];
  let snapshot = CLOSED;
  let confirming = false;
  const listeners = new Set<() => void>();

  const emit = () => {
    snapshot = snapshotOf(waiters);
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    async ensureUploadRights(refs) {
      const results = await options.classify(refs);
      const owed = refs.filter(
        (_, index) => results[index]?.status === 'needs_portrait'
      );
      if (owed.length === 0) return;
      await new Promise<void>((resolve, reject) => {
        if (waiters.length === 0) options.onShow?.();
        waiters = [...waiters, { refs: owed, resolve, reject }];
        emit();
      });
    },
    async confirm(attest) {
      if (confirming || waiters.length === 0) return;
      confirming = true;
      const batch = waiters;
      try {
        await attest(uniqueRefs(batch));
      } finally {
        confirming = false;
      }
      const live = batch.filter((waiter) => waiters.includes(waiter));
      if (live.length === 0) return;
      waiters = waiters.filter((waiter) => !live.includes(waiter));
      emit();
      for (const waiter of live) waiter.resolve();
    },
    decline() {
      const batch = waiters;
      if (batch.length === 0) return;
      waiters = [];
      emit();
      for (const waiter of batch)
        waiter.reject(new UploadRightsDeclinedError());
    },
  };
}
