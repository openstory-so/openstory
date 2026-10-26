/**
 * Opens the assistant (#2155): the header button and Cmd/Ctrl+J. J is free
 * of the six global handlers listed in #2134 (B sidebar, K search, arrows,
 * Esc, Cmd+.).
 */

import { MessageSquareTextIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useAuthGate } from '@/platform/ui/auth/auth-gate-provider';
import { Button } from '@/ui/shadcn/button';
import { Kbd } from '@/ui/shadcn/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip';
import { toggleAssistant, useAssistantState } from './assistant-store';

export const AssistantToggle: React.FC = () => {
  const { open } = useAssistantState();
  const { requireAuth } = useAuthGate();

  useEffect(() => {
    const onKey = (event: Event) => {
      // Chrome autofill fires a bare `keydown` Event with no `key` (#2132).
      if (!(event instanceof KeyboardEvent)) return;
      // Esc inside the panel closes it; an open menu or dialog takes Esc
      // first and stops it here.
      if (
        event.key === 'Escape' &&
        event.target instanceof Element &&
        event.target.closest('[data-assistant-panel]')
      ) {
        toggleAssistant();
        return;
      }
      if (event.key.toLowerCase() !== 'j') return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
        return;
      event.preventDefault();
      if (requireAuth()) toggleAssistant();
    };
    // A file dropped on the panel outside the composer must not navigate
    // the tab away; the composer's textarea is the drop target.
    const onDrag = (event: DragEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-assistant-panel]')
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener('dragover', onDrag);
    window.addEventListener('drop', onDrag);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('dragover', onDrag);
      window.removeEventListener('drop', onDrag);
      window.removeEventListener('keydown', onKey);
    };
  }, [requireAuth]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={open ? 'Close assistant' : 'Open assistant'}
          aria-pressed={open}
          onClick={() => {
            if (requireAuth()) toggleAssistant();
          }}
        >
          <MessageSquareTextIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Assistant <Kbd>⌘J</Kbd>
      </TooltipContent>
    </Tooltip>
  );
};
