/**
 * Slot in the app header, right of the breadcrumb (#1427, #2102).
 *
 * Generation progress used to be a card in the scenes column flow, so every
 * run pushed the whole layout down and popped it back up. The header is
 * always there and everything right of the breadcrumb is dead space, so
 * progress rendered into it costs zero layout shift and covers nothing.
 *
 * The slot lives in the app layout while the progress state lives in
 * `ScenesView`, hence the portal.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const SEQUENCE_HEADER_SLOT_ID = 'sequence-header-slot';

export const SequenceHeaderPortal: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  // The slot is rendered by an ancestor layout, so it exists by the time
  // effects run — but not during SSR, which is fine: live progress is
  // client-only anyway, and a missing slot simply renders nothing.
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setNode(document.getElementById(SEQUENCE_HEADER_SLOT_ID));
  }, []);

  return node ? createPortal(children, node) : null;
};
