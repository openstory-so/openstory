/**
 * A page's component-state context for the assistant (#2155): rendered
 * while something is selected that the URL does not name (the Studio
 * viewer's open asset, a draft being typed), it holds that item in the
 * store and takes it out on unmount. A draft also hands over `onReplace`,
 * which `replace_unsaved_text` calls to write into the editor. Context the
 * URL names needs none of this; `usePageContext` reads it off the router.
 */

import { useEffect, useRef } from 'react';
import type { PageContextItem } from '../page-context';
import {
  setAssistantDraftEditor,
  setAssistantExtraContext,
} from './assistant-store';

export const AssistantContextItem: React.FC<{
  item: PageContextItem;
  /** For a draft: how the assistant writes new text into the editor. */
  onReplace?: (text: string) => void;
}> = ({ item, onReplace }) => {
  const key = `${item.kind}:${item.id}`;
  // The store is outside React; this is the one place a page syncs into it.
  // Keyed on the fields, not the object: a page that builds the item each
  // render must not re-register each render.
  const { kind, id, label, text, image } = item;
  useEffect(() => {
    setAssistantExtraContext(key, { kind, id, label, text, image });
    return () => setAssistantExtraContext(key, null);
  }, [key, kind, id, label, text, image]);
  // The page passes a fresh closure each render; the store keeps one
  // function that calls the latest.
  const latest = useRef(onReplace);
  useEffect(() => {
    latest.current = onReplace;
  });
  const canReplace = onReplace !== undefined;
  useEffect(() => {
    if (!canReplace) return;
    setAssistantDraftEditor(key, (next) => latest.current?.(next));
    return () => setAssistantDraftEditor(key, null);
  }, [key, canReplace]);
  return null;
};
