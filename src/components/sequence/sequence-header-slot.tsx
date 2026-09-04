/**
 * Right-hand slot in the sequence title row (#1427).
 *
 * Generation progress used to be a card in the scenes column flow, so every
 * run pushed the whole layout down and popped it back up. The title row is
 * already there, already that tall, and everything to the right of the title
 * is dead space — so progress rendered into it costs zero layout shift and
 * covers nothing.
 *
 * The row lives in the sequence layout route while the progress state lives
 * in `ScenesView`, hence the portal rather than prop drilling through
 * `<Outlet />`.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const SEQUENCE_HEADER_SLOT_ID = 'sequence-header-slot';

export const SequenceHeaderPortal: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  // The slot is rendered by an ancestor route, so it exists by the time
  // effects run — but not during SSR, which is fine: live progress is
  // client-only anyway, and a missing slot simply renders nothing.
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setNode(document.getElementById(SEQUENCE_HEADER_SLOT_ID));
  }, []);

  return node ? createPortal(children, node) : null;
};
