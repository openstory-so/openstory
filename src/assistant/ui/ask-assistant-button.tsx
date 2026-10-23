/**
 * "Ask the assistant" (#2155): opens the panel with this thing as context
 * and, when given, a starting line in the composer. A text button, as the
 * repo's labelled buttons are.
 */

import { useAuthGate } from '@/platform/ui/auth/auth-gate-provider';
import { Button } from '@/ui/shadcn/button';
import { DropdownMenuItem } from '@/ui/shadcn/dropdown-menu';
import type { PageContextItem } from '../page-context';
import { openAssistant } from './assistant-store';

export const AskAssistantButton: React.FC<{
  context: PageContextItem[];
  prompt?: string;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'ghost';
  /** Runs first, before the panel opens (the Studio viewer resets its copied state). */
  onOpen?: () => void;
}> = ({ context, prompt, size = 'sm', variant = 'outline', onOpen }) => {
  const { requireAuth } = useAuthGate();
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      onClick={() => {
        if (!requireAuth()) return;
        onOpen?.();
        openAssistant({ context, prompt });
      }}
    >
      Ask the assistant
    </Button>
  );
};

/** The same ask as a row in a dropdown menu. */
export const AskAssistantMenuItem: React.FC<{
  context: PageContextItem[];
  prompt?: string;
}> = ({ context, prompt }) => {
  const { requireAuth } = useAuthGate();
  return (
    <DropdownMenuItem
      onSelect={() => {
        if (!requireAuth()) return;
        openAssistant({ context, prompt });
      }}
    >
      Ask the assistant
    </DropdownMenuItem>
  );
};
