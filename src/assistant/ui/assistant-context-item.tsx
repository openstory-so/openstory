/**
 * A page's component-state context for the assistant (#2155): rendered
 * while something is selected that the URL does not name (the Studio
 * viewer's open asset), it holds that item in the store and takes it out
 * on unmount. Context the URL names needs none of this; `usePageContext`
 * reads it off the router.
 */

import { useEffect } from 'react';
import type { PageContextItem } from '../page-context';
import { setAssistantExtraContext } from './assistant-store';

export const AssistantContextItem: React.FC<{ item: PageContextItem }> = ({
  item,
}) => {
  const key = `${item.kind}:${item.id}`;
  // The store is outside React; this is the one place a page syncs into it.
  // Keyed on the fields, not the object: a page that builds the item each
  // render must not re-register each render.
  const { kind, id, label } = item;
  useEffect(() => {
    setAssistantExtraContext(key, { kind, id, label });
    return () => setAssistantExtraContext(key, null);
  }, [key, kind, id, label]);
  return null;
};
