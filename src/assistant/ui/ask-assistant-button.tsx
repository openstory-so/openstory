/**
 * "Chat about this" (#2155): opens a fresh thread with this thing as
 * context and nothing typed; the empty thread's starters follow the
 * context. A text button, as the repo's labelled buttons are.
 */

import { useAuthGate } from '@/platform/ui/auth/auth-gate-provider';
import { Button } from '@/ui/shadcn/button';
import type { PageContextItem } from '../page-context';
import { openAssistant } from './assistant-store';

export const AskAssistantButton: React.FC<{
  context: PageContextItem[];
  size?: 'sm' | 'default';
  variant?: 'outline' | 'ghost';
  /** Runs first, before the panel opens (the Studio viewer resets its copied state). */
  onOpen?: () => void;
}> = ({ context, size = 'sm', variant = 'outline', onOpen }) => {
  const { requireAuth } = useAuthGate();
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      onClick={() => {
        if (!requireAuth()) return;
        onOpen?.();
        openAssistant({ context });
      }}
    >
      Chat about this
    </Button>
  );
};
