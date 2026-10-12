/**
 * Global search (#2100): one box over everything the team has made. Results
 * are grouped by kind and each one is a link.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import { Input } from '@/ui/shadcn/input';
import { searchFn } from '@/platform/search.fn';
import {
  SEARCH_KINDS,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  type SearchHit,
  type SearchKind,
} from '@/platform/search';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, linkOptions } from '@tanstack/react-router';
import { useRef, useState, type KeyboardEvent } from 'react';

const DEBOUNCE_MS = 200;

const GROUP_LABELS: Record<SearchKind, string> = {
  sequence: 'Sequences',
  scene: 'Scenes',
  shot: 'Shots',
  character: 'Characters',
  sequenceLocation: 'Locations in sequences',
  libraryLocation: 'Location library',
  image: 'Images',
  clip: 'Clips',
};

/** Resolves after `ms`, or rejects as soon as the query is dropped. */
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(id);
      reject(signal.reason);
    });
  });
}

function hitLink(hit: SearchHit) {
  switch (hit.kind) {
    case 'sequence':
      return linkOptions({
        to: '/sequences/$id/scenes',
        params: { id: hit.id },
      });
    case 'scene':
      return linkOptions({
        to: '/sequences/$id/scenes',
        params: { id: hit.sequence?.id ?? '' },
        search: { scenes: hit.id },
      });
    case 'shot':
      return linkOptions({
        to: '/sequences/$id/scenes',
        params: { id: hit.sequence?.id ?? '' },
        search: { shot: hit.id },
      });
    case 'character':
      return linkOptions({ to: '/characters/$id', params: { id: hit.id } });
    case 'sequenceLocation':
      return linkOptions({
        to: '/sequences/$id/locations/$locationId',
        params: { id: hit.sequence?.id ?? '', locationId: hit.id },
      });
    case 'libraryLocation':
      return linkOptions({
        to: '/locations/$locationId',
        params: { locationId: hit.id },
      });
    // ponytail: the list pages open a generation from their loaded page only,
    // so a hit lands on the list. Link the item once they take an id.
    case 'image':
      return linkOptions({ to: '/images' });
    case 'clip':
      return linkOptions({ to: '/clips' });
  }
}

type SearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const [query, setQuery] = useState('');
  const term = query.trim();
  const searching = term.length >= SEARCH_MIN_LENGTH;
  const listRef = useRef<HTMLDivElement>(null);

  const { data, isFetching, isError } = useQuery({
    queryKey: ['search', term],
    // The wait is the debounce: typing on moves the key, which drops this
    // query and aborts the wait before any request is sent.
    queryFn: async ({ signal }) => {
      await wait(DEBOUNCE_MS, signal);
      return searchFn({ data: { query: term } });
    },
    enabled: open && searching,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const hits = searching ? (data ?? []) : [];

  const close = (next: boolean) => {
    if (!next) setQuery('');
    onOpenChange(next);
  };

  // Arrow keys walk input → results, as in a menu.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [
      ...(listRef.current?.querySelectorAll<HTMLAnchorElement>('a') ?? []),
    ];
    if (links.length === 0) return;
    event.preventDefault();
    const at = links.findIndex((link) => link === document.activeElement);
    const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
    links[Math.max(0, Math.min(links.length - 1, next))]?.focus();
  };

  let status = '';
  if (isError) status = 'Search failed.';
  else if (searching && hits.length === 0)
    status = isFetching ? 'Searching…' : `Nothing matches “${term}”.`;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="top-[12vh] flex max-h-[76vh] translate-y-0 flex-col sm:max-w-xl"
        onKeyDown={onKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>
            Sequences, scenes, shots, characters, locations, images and clips.
          </DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          name="query"
          autoComplete="off"
          aria-label="Search"
          placeholder="Search…"
          maxLength={SEARCH_MAX_LENGTH}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p aria-live="polite" className="text-muted-foreground empty:hidden">
          {status}
        </p>
        <div
          ref={listRef}
          className="flex min-h-0 flex-col gap-4 overflow-y-auto"
        >
          {SEARCH_KINDS.map((kind) => {
            const group = hits.filter((hit) => hit.kind === kind);
            if (group.length === 0) return null;
            return (
              <section key={kind} className="flex flex-col gap-1">
                <h3 className="px-2 text-xs font-medium text-muted-foreground">
                  {GROUP_LABELS[kind]}
                </h3>
                <ul className="flex flex-col">
                  {group.map((hit) => (
                    <li key={hit.id}>
                      <Link
                        {...hitLink(hit)}
                        onClick={() => close(false)}
                        className="flex min-h-11 flex-col justify-center rounded-md px-2 py-1 outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <span className="truncate font-medium">
                          {hit.title}
                          {hit.sequence && (
                            <span className="font-normal text-muted-foreground">
                              {' '}
                              · {hit.sequence.title}
                            </span>
                          )}
                        </span>
                        {hit.snippet && (
                          <span className="truncate text-muted-foreground">
                            {hit.snippet}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
