/**
 * The assistant's shell state (#2155): open or closed, which thread, and
 * what a page handed it ("Chat about this"). A module store rather than a
 * provider so any button anywhere can call `openAssistant()` with no tree
 * plumbing, and the panel in the app layout reads it with
 * `useSyncExternalStore`. Open state and the thread id survive a reload
 * through localStorage; the handed-over draft does not.
 */

import { useSyncExternalStore } from 'react';
import { generateId } from '@/platform/id';
import {
  DEFAULT_ANALYSIS_MODEL,
  isSelectableAnalysisModelId,
  type AnalysisModelId,
} from '@/models/models.config';
import type { PageContextItem } from '../page-context';

export type AssistantDraft = {
  /** Text placed in the composer, not sent. */
  prompt?: string;
  /** Context the page handed over, added to the chips. */
  context?: PageContextItem[];
  /** Questions this surface would ask first, shown ahead of the kind's starters. */
  starters?: string[];
  /** Changes on every hand-over, so the composer remounts with the text. */
  nonce: string;
};

export type AssistantState = {
  open: boolean;
  /** The desktop panel's width in px; a page that must not sit under it reads this. */
  width: number;
  threadId: string;
  /** The model that answers; the user's pick, kept across threads. */
  model: AnalysisModelId;
  draft: AssistantDraft | null;
  /** Context chips the user removed for this thread, by `kind:id`. */
  dismissedContext: ReadonlySet<string>;
  /**
   * Context a page holds in component state rather than the URL (the
   * Studio viewer's open asset), keyed by who registered it. The router
   * cannot see these, so the page says so through `AssistantContextItem`.
   */
  extraContext: ReadonlyMap<string, PageContextItem>;
  /** How to replace a draft's text, by the same key; `replace_unsaved_text` calls it. */
  draftEditors: ReadonlyMap<string, (text: string) => void>;
};

const STORAGE_KEY = 'openstory.assistant';
const MIN_ASSISTANT_WIDTH = 320;
const MAX_ASSISTANT_WIDTH = 640;
const DEFAULT_WIDTH = 400;

export const clampAssistantWidth = (width: number) =>
  Math.min(MAX_ASSISTANT_WIDTH, Math.max(MIN_ASSISTANT_WIDTH, width));

function readStored(): Pick<
  AssistantState,
  'open' | 'threadId' | 'model' | 'width'
> | null {
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
      return {
        open: parsed.open,
        threadId: parsed.threadId,
        model:
          'model' in parsed && isSelectableAnalysisModelId(parsed.model)
            ? parsed.model
            : DEFAULT_ANALYSIS_MODEL,
        width:
          'width' in parsed && typeof parsed.width === 'number'
            ? clampAssistantWidth(parsed.width)
            : DEFAULT_WIDTH,
      };
    }
  } catch {
    // A private window or blocked storage: start fresh.
  }
  return null;
}

const SERVER_STATE: AssistantState = {
  open: false,
  width: DEFAULT_WIDTH,
  threadId: '',
  model: DEFAULT_ANALYSIS_MODEL,
  draft: null,
  dismissedContext: new Set(),
  extraContext: new Map(),
  draftEditors: new Map(),
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
      JSON.stringify({
        open: state.open,
        threadId: state.threadId,
        model: state.model,
        width: state.width,
      })
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

/** The state outside React, for a tool executor. */
export const getAssistantState = (): AssistantState => current();

/**
 * Open the panel. With a draft it is a call to action ("Chat about this",
 * a starter chip) and starts a new thread: the chat is about this thing,
 * not a continuation of the last one. Bare, it only shows the panel.
 */
export function openAssistant(draft?: Omit<AssistantDraft, 'nonce'>): void {
  if (!draft) {
    set({ open: true });
    return;
  }
  set({
    open: true,
    threadId: generateId(),
    draft: { ...draft, nonce: generateId() },
    dismissedContext: new Set(),
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

export function setAssistantModel(model: AnalysisModelId): void {
  set({ model });
}

export function setAssistantWidth(width: number): void {
  set({ width: clampAssistantWidth(width) });
}

/** A page's component-state context, present while `item` is set. */
export function setAssistantExtraContext(
  key: string,
  item: PageContextItem | null
): void {
  const next = new Map(current().extraContext);
  if (item) next.set(key, item);
  else next.delete(key);
  set({ extraContext: next });
}

/** The editor behind a draft context item, present while the page can take text. */
export function setAssistantDraftEditor(
  key: string,
  replace: ((text: string) => void) | null
): void {
  const next = new Map(current().draftEditors);
  if (replace) next.set(key, replace);
  else next.delete(key);
  set({ draftEditors: next });
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
