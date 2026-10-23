/**
 * The assistant's home (#2155): a docked, resizable panel right of the page
 * on desktop and a bottom drawer on a phone. Mounted once in the app
 * layout, so it survives navigation; the conversation keeps going as the
 * page under it changes.
 */

import type { ConnectionAdapter } from '@tanstack/ai-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/shadcn/alert-dialog';
import {
  deleteAssistantThreadFn,
  listAssistantThreadsFn,
} from '@/assistant/assistant.fn';
import { useAuthGate } from '@/platform/ui/auth/auth-gate-provider';
import { SignInButton } from '@/platform/ui/auth/sign-in-button';
import { Button } from '@/ui/shadcn/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from '@/ui/shadcn/drawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu';
import { useIsMobile } from '@/ui/use-mobile';
import { cn } from '@/ui/utils';
import type { PageContextItem } from '../page-context';
import { AssistantConversation } from './assistant-conversation';
import {
  clampAssistantWidth,
  closeAssistant,
  dismissAssistantContext,
  isContextDismissed,
  setAssistantWidth,
  startAssistantThread,
  switchAssistantThread,
  useAssistantState,
} from './assistant-store';

const KEY_STEP = 24;

const assistantThreadKeys = {
  list: ['assistant-threads'] as const,
};

export type AssistantPanelProps = {
  /** What the current page says about itself; chips in the composer. */
  pageContext: PageContextItem[];
  suggestions: string[];
  /** Stories: a scripted connection and no uploads. */
  connection?: ConnectionAdapter;
  uploadStub?: (file: File) => Promise<string>;
  /** Stories: render the body without the dock or drawer. */
  inline?: boolean;
};

const ThreadMenu: React.FC<{ threadId: string; enabled: boolean }> = ({
  threadId,
  enabled,
}) => {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const threads = useQuery({
    queryKey: assistantThreadKeys.list,
    queryFn: () => listAssistantThreadsFn(),
    enabled,
    staleTime: 30_000,
  });
  const remove = useMutation({
    mutationFn: () => deleteAssistantThreadFn({ data: { threadId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: assistantThreadKeys.list,
      });
      startAssistantThread();
    },
    onError: (error) => {
      toast.error('Could not delete this chat', {
        description: error.message,
      });
    },
  });
  const others = (threads.data ?? []).filter((t) => t.id !== threadId);
  const current = threads.data?.find((t) => t.id === threadId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          History
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {current && (
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirming(true)}
          >
            Delete this chat
          </DropdownMenuItem>
        )}
        {threads.error && (
          <DropdownMenuLabel className="text-destructive">
            Could not load history: {threads.error.message}
          </DropdownMenuLabel>
        )}
        {!current && others.length === 0 && !threads.error && (
          <DropdownMenuLabel>No earlier chats</DropdownMenuLabel>
        )}
        {others.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Recent</DropdownMenuLabel>
            {others.slice(0, 12).map((thread) => (
              <DropdownMenuItem
                key={thread.id}
                onSelect={() => switchAssistantThread(thread.id)}
              >
                <span className="truncate">{thread.title}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              Its messages go for good. Nothing it did to your work is undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DropdownMenu>
  );
};

const PanelBody: React.FC<AssistantPanelProps & { titleId: string }> = ({
  pageContext,
  suggestions,
  connection,
  uploadStub,
  titleId,
}) => {
  const { threadId, draft, dismissedContext, extraContext } =
    useAssistantState();
  const { isAuthenticated } = useAuthGate();
  const visible = [
    ...pageContext,
    ...extraContext.values(),
    ...(draft?.context ?? []),
  ].filter(
    (item, index, all) =>
      !isContextDismissed(item, dismissedContext) &&
      all.findIndex((o) => o.kind === item.kind && o.id === item.id) === index
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <h2
          id={titleId}
          className="min-w-0 flex-1 truncate text-sm font-medium"
        >
          Assistant
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => startAssistantThread()}
        >
          New chat
        </Button>
        <ThreadMenu threadId={threadId} enabled={isAuthenticated} />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Close assistant"
          onClick={closeAssistant}
        >
          <XIcon />
        </Button>
      </header>
      {isAuthenticated ? (
        <AssistantConversation
          key={threadId}
          threadId={threadId}
          pageContext={visible}
          onDismissContext={dismissAssistantContext}
          initialPrompt={draft?.prompt}
          draftKey={draft?.nonce}
          suggestions={suggestions}
          connection={connection}
          uploadStub={uploadStub}
        />
      ) : (
        <div className="flex flex-1 flex-col items-start gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            Sign in to chat about your work. The assistant acts on your team, so
            it needs to know who you are.
          </p>
          <SignInButton />
        </div>
      )}
    </div>
  );
};

export const AssistantPanel: React.FC<AssistantPanelProps> = (props) => {
  const { open, width } = useAssistantState();
  const isMobile = useIsMobile();
  const titleId = useId();

  if (props.inline) {
    return (
      <div className="flex h-full min-h-0 flex-col border-l">
        <PanelBody {...props} titleId={titleId} />
      </div>
    );
  }

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={(next) => !next && closeAssistant()}>
        <DrawerContent className="h-[88svh]">
          <DrawerTitle className="sr-only">Assistant</DrawerTitle>
          <DrawerDescription className="sr-only">
            Chat with the OpenStory assistant
          </DrawerDescription>
          {open && <PanelBody {...props} titleId={titleId} />}
        </DrawerContent>
      </Drawer>
    );
  }

  // The store persists it, and the Studio viewer reads it to leave the
  // panel uncovered.
  const commitWidth = setAssistantWidth;

  // Pointer capture keeps the move and the release on the handle itself, so
  // nothing is left on `window` when the drag is cancelled or the panel
  // unmounts mid-drag.
  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    handle.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent) =>
      setAssistantWidth(
        clampAssistantWidth(startWidth + (startX - move.clientX))
      );
    const onEnd = (end: PointerEvent) => {
      commitWidth(startWidth + (startX - end.clientX));
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  };

  return (
    <aside
      aria-labelledby={titleId}
      data-assistant-panel
      className={cn(
        'relative hidden h-svh shrink-0 flex-col border-l bg-background md:flex',
        !open && 'md:hidden'
      )}
      style={{ width }}
    >
      {/* A button, so the handle is in the tab order and takes the arrow
          keys; its label says what it does since it has no text. */}
      <button
        type="button"
        aria-label="Resize assistant. Left arrow widens, right arrow narrows."
        onPointerDown={startDrag}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') commitWidth(width + KEY_STEP);
          if (event.key === 'ArrowRight') commitWidth(width - KEY_STEP);
        }}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize focus-visible:bg-ring/40 focus-visible:outline-none"
      />
      {open && <PanelBody {...props} titleId={titleId} />}
    </aside>
  );
};
