import { isReloadPending, isStaleChunkError } from '@/ui/chunk-reload';
import { Button } from '@/ui/shadcn/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/ui/shadcn/empty';

/**
 * Did this tab fall behind a deploy (#2034)? Either the one automatic reload
 * is on its way — the suppressed chunk error leaves the import resolving
 * `undefined`, so the router throws on `.component` until the page leaves — or
 * that reload is spent and the chunk is still missing.
 */
export function isAppUpdatedError(error: unknown): boolean {
  return isReloadPending() || isStaleChunkError(error);
}

export const AppUpdatedNotice: React.FC = () => {
  if (isReloadPending()) {
    return (
      <Empty className="flex-1" aria-live="polite">
        <EmptyHeader>
          <EmptyTitle>Updating…</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>OpenStory was updated</EmptyTitle>
        <EmptyDescription>Reload to get the new version.</EmptyDescription>
      </EmptyHeader>
      <Button variant="outline" size="sm" onClick={() => location.reload()}>
        Reload
      </Button>
    </Empty>
  );
};
