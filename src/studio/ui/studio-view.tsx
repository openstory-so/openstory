import { StudioComposer } from './studio-composer';
import { StudioGallery, type StudioGalleryAsset } from './studio-gallery';
import { isSystemAdminFn } from '@/billing/gift-tokens.fn';
import { useAuthGate } from '@/platform/ui/auth/auth-gate-provider';
import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import { Switch } from '@/ui/shadcn/switch';
import { PageContainer } from '@/ui/layout/page-container';
import { PageIntro } from '@/ui/typography/page-intro';
import { useIsomorphicLayoutEffect } from '@/ui/use-isomorphic-layout-effect';
import { useAdminStudioAssets, useStudioAssets } from './use-studio-assets';
import { studioPrompt } from './outputs';
import {
  isDefaultStudioListPrefs,
  loadStudioListPrefs,
  prefsFromSearch,
  prefsToSearch,
  resolveStudioListPrefs,
  saveStudioListPrefs,
  searchSpecifiesSupportPrefs,
  type StudioListPrefs,
  type StudioListSearch,
} from './list-prefs';
import type { StudioActivity } from '@/studio/schema';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ShieldCheck, Star } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type StudioListNavigate = (opts: {
  search: StudioListSearch;
  replace: boolean;
}) => unknown;

function useStudioListPrefs(
  search: StudioListSearch,
  navigate: StudioListNavigate
) {
  const restored = useRef(false);
  const prefs = prefsFromSearch(search);

  useIsomorphicLayoutEffect(() => {
    if (restored.current) return;
    restored.current = true;

    if (searchSpecifiesSupportPrefs(search)) {
      saveStudioListPrefs(prefsFromSearch(search));
      return;
    }

    const resolved = resolveStudioListPrefs(search, loadStudioListPrefs());
    if (isDefaultStudioListPrefs(resolved)) return;
    const nextSearch = prefsToSearch(resolved, search.user);
    saveStudioListPrefs(resolved);
    void navigate({ search: nextSearch, replace: true });
  }, [navigate, search]);

  const setPrefs = useCallback(
    (next: StudioListPrefs) => {
      saveStudioListPrefs(next);
      void navigate({
        search: prefsToSearch(next, search.user),
        replace: true,
      });
    },
    [navigate, search.user]
  );

  return { prefs, setPrefs };
}

type StudioViewProps = {
  activity: StudioActivity;
  search: StudioListSearch;
  navigate: StudioListNavigate;
};

export function StudioView({ activity, search, navigate }: StudioViewProps) {
  const { isAuthenticated } = useAuthGate();
  const { prefs, setPrefs } = useStudioListPrefs(search, navigate);
  const to = activity === 'video' ? '/videos' : '/images';

  const { data: adminStatus, isLoading: adminStatusLoading } = useQuery({
    queryKey: ['system-admin-status'],
    queryFn: () => isSystemAdminFn(),
    staleTime: 5 * 60 * 1000,
    enabled: isAuthenticated,
  });

  const isAdmin = adminStatus?.isAdmin ?? false;
  const internalDomains = useMemo(
    () => adminStatus?.internalDomains ?? [],
    [adminStatus?.internalDomains]
  );
  // Admin query is gated on isAdmin so a remembered `support=true` cannot 403
  // a non-admin. Stay in the loading skeleton until that check resolves.
  const supportMode = isAdmin && prefs.supportMode;
  const hideInternal = supportMode && prefs.hideInternal;
  const effectiveHideInternal =
    hideInternal && !search.user && internalDomains.length > 0;

  const ownQuery = useStudioAssets(
    {
      activity,
      favoritesOnly: prefs.favorites || undefined,
      order: prefs.sort,
    },
    !supportMode
  );
  const adminQuery = useAdminStudioAssets(
    {
      activity,
      favoritesOnly: prefs.favorites || undefined,
      order: prefs.sort,
      search: supportMode ? prefs.search : undefined,
    },
    supportMode
  );

  const query = supportMode ? adminQuery : ownQuery;
  const assets = useMemo(() => {
    const rows: StudioGalleryAsset[] =
      query.data?.pages.flatMap((page) => page.assets) ?? [];
    if (!effectiveHideInternal) return rows;
    const suffixes = internalDomains.map((d) => `@${d.toLowerCase()}`);
    return rows.filter((asset) => {
      const email = asset.creatorEmail;
      if (!email) return true;
      const lowered = email.toLowerCase();
      return !suffixes.some((suffix) => lowered.endsWith(suffix));
    });
  }, [query.data, effectiveHideInternal, internalDomains]);

  const generatingPrompts = assets
    .filter((a) => a.status === 'queued' || a.status === 'running')
    .map(studioPrompt);

  const isLoading =
    (prefs.supportMode && adminStatusLoading) ||
    (query.isPending && (supportMode || isAuthenticated));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <PageIntro
          title={activity === 'video' ? 'Videos' : 'Images'}
          maxWidth="wide"
        >
          {supportMode
            ? activity === 'video'
              ? 'Every clip users have generated.'
              : 'Every still users have generated.'
            : activity === 'video'
              ? 'Make or edit short clips with any video model.'
              : 'Make or edit images with any image model.'}
        </PageIntro>
        <PageContainer maxWidth="wide" padding="none" className="pb-8">
          <StudioToolbar
            to={to}
            prefs={prefs}
            setPrefs={setPrefs}
            currentUser={search.user}
            isAdmin={isAdmin}
            hideInternalAvailable={internalDomains.length > 0}
            hideInternalLocked={Boolean(search.user)}
          />

          <StudioGallery
            assets={assets}
            isLoading={isLoading}
            isAuthenticated={isAuthenticated}
            activity={activity}
            hasNextPage={query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
            readOnly={supportMode}
            showCreator={supportMode}
          />
        </PageContainer>
      </div>

      {!supportMode && (
        <div
          className="flex min-h-0 max-h-[50%] shrink-0 flex-col overflow-hidden border-t bg-background/80 backdrop-blur-md"
          data-testid="studio-composer-pane"
        >
          <PageContainer
            maxWidth="wide"
            padding="compact"
            className="flex min-h-0 flex-col overflow-hidden py-4"
          >
            <StudioComposer
              activity={activity}
              generatingPrompts={generatingPrompts}
            />
          </PageContainer>
        </div>
      )}
    </div>
  );
}

function StudioToolbar({
  to,
  prefs,
  setPrefs,
  currentUser,
  isAdmin,
  hideInternalAvailable,
  hideInternalLocked,
}: {
  to: '/images' | '/videos';
  prefs: StudioListPrefs;
  setPrefs: (prefs: StudioListPrefs) => void;
  currentUser?: string;
  isAdmin: boolean;
  hideInternalAvailable: boolean;
  hideInternalLocked: boolean;
}) {
  const [searchDraft, setSearchDraft] = useState(prefs.search);
  const prefsRef = useRef(prefs);
  const setPrefsRef = useRef(setPrefs);
  useEffect(() => {
    prefsRef.current = prefs;
    setPrefsRef.current = setPrefs;
  });
  useEffect(() => {
    setSearchDraft(prefs.search);
  }, [prefs.search]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchDraft === prefsRef.current.search) return;
      setPrefsRef.current({ ...prefsRef.current, search: searchDraft });
    }, 250);
    return () => clearTimeout(t);
  }, [searchDraft]);

  const linkSearch = (next: Partial<StudioListPrefs>) =>
    prefsToSearch({ ...prefs, ...next }, currentUser);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {isAdmin && prefs.supportMode && (
          <Input
            placeholder="Search name, email, prompt…"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            className="h-8 w-56"
            aria-label="Search studio assets"
          />
        )}
        <Button
          asChild
          size="sm"
          variant={prefs.favorites ? 'default' : 'outline'}
        >
          <Link to={to} search={linkSearch({ favorites: !prefs.favorites })}>
            <Star className="size-4" aria-hidden="true" />
            Favorites
          </Link>
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            asChild
            size="sm"
            variant={prefs.sort === 'newest' ? 'default' : 'outline'}
          >
            <Link to={to} search={linkSearch({ sort: 'newest' })}>
              Newest
            </Link>
          </Button>
          <Button
            asChild
            size="sm"
            variant={prefs.sort === 'oldest' ? 'default' : 'outline'}
          >
            <Link to={to} search={linkSearch({ sort: 'oldest' })}>
              Oldest
            </Link>
          </Button>
          {isAdmin && (
            <div className="flex items-center gap-4">
              {prefs.supportMode && hideInternalAvailable && (
                <div className="flex items-center gap-2">
                  <Label htmlFor="studio-hide-internal" className="text-sm">
                    Hide internal
                  </Label>
                  <Switch
                    id="studio-hide-internal"
                    checked={prefs.hideInternal}
                    disabled={hideInternalLocked}
                    onCheckedChange={(value) =>
                      setPrefs({ ...prefs, hideInternal: value })
                    }
                  />
                </div>
              )}
              <div className="flex items-center gap-2">
                <ShieldCheck
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <Label htmlFor="studio-support-mode" className="text-sm">
                  Support
                </Label>
                <Switch
                  id="studio-support-mode"
                  checked={prefs.supportMode}
                  onCheckedChange={(value) =>
                    setPrefs({
                      ...prefs,
                      supportMode: value,
                      hideInternal: value ? prefs.hideInternal : false,
                    })
                  }
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
