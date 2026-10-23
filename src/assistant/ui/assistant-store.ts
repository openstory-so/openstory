/**
 * The assistant's shell state (#2155): open or closed, which thread, and
 * what a page handed it ("Ask about this"). A module store rather than a
 * provider so any button anywhere can call `openAssistant()` with no tree
 * plumbing, and the panel in the app layout reads it with
 * `useSyncExternalStore`. Open state and the thread id survive a reload
 * through localStorage; the handed-over draft does not.
 */

import { useSyncExternalStore } from 'react';
import { generateId } from '@/platform/id';
import type { PageContextItem } from '../page-context';

export type AssistantDraft = {
  /** Text placed in the composer, not sent. */
  prompt?: string;
  /** Context the page handed over, added to the chips. */
  context?: PageContextItem[];
  /** Changes on every hand-over, so the composer remounts with the text. */
  nonce: string;
};

export type AssistantState = {
  open: boolean;
  threadId: string;
  draft: AssistantDraft | null;
  /** Context chips the user removed for this thread, by `kind:id`. */
  dismissedContext: ReadonlySet<string>;
};

const STORAGE_KEY = 'openstory.assistant';

function readStored(): Pick<AssistantState, 'open' | 'threadId'> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'threadId' in parsed &&
      typeof parsed.threadId === 'string' &&
      'open' in parsed &&
      typeof parsed.open === 'boolean'
    ) {
      return { open: parsed.open, threadId: parsed.threadId };
    }
  } catch {
    // A private window or blocked storage: start fresh.
  }
  return null;
}

const SERVER_STATE: AssistantState = {
  open: false,
  threadId: '',
  draft: null,
  dismissedContext: new Set(),
};

let state: AssistantState | null = null;
const listeners = new Set<() => void>();

function current(): AssistantState {
  if (state) return state;
  const stored = readStored();
  state = {
    ...SERVER_STATE,
    ...(stored ?? { threadId: generateId() }),
  };
  return state;
}

function set(patch: Partial<AssistantState>): void {
  state = { ...current(), ...patch };
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ open: state.open, threadId: state.threadId })
    );
  } catch {
    // Storage is a convenience; the panel works without it.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAssistantState(): AssistantState {
  return useSyncExternalStore(subscribe, current, () => SERVER_STATE);
}

/**
 * Open the panel, with what the page wants to talk about. The draft stays
 * in the store until the thread changes: its context is chips for the
 * whole conversation, its prompt the composer's starting text.
 */
export function openAssistant(draft?: Omit<AssistantDraft, 'nonce'>): void {
  set({
    open: true,
    ...(draft ? { draft: { ...draft, nonce: generateId() } } : {}),
  });
}

export function closeAssistant(): void {
  set({ open: false });
}

export function toggleAssistant(): void {
  set({ open: !current().open });
}

export function switchAssistantThread(threadId: string): void {
  set({ threadId, draft: null, dismissedContext: new Set() });
}

export function startAssistantThread(): void {
  switchAssistantThread(generateId());
}

export function dismissAssistantContext(item: PageContextItem): void {
  const next = new Set(current().dismissedContext);
  next.add(`${item.kind}:${item.id}`);
  set({ dismissedContext: next });
}

export function isContextDismissed(
  item: PageContextItem,
  dismissed: ReadonlySet<string>
): boolean {
  return dismissed.has(`${item.kind}:${item.id}`);
}
