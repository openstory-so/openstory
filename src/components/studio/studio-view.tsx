import { StudioComposer } from '@/components/studio/studio-composer';
import { StudioGallery } from '@/components/studio/studio-gallery';
import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { Button } from '@/components/ui/button';
import { PageContainer } from '@/components/layout/page-container';
import { PageIntro } from '@/components/typography/page-intro';
import { useStudioAssets } from '@/hooks/use-studio-assets';
import type { StudioActivity, StudioSort } from '@/lib/studio/schema';
import { Link } from '@tanstack/react-router';
import { Star } from 'lucide-react';

type StudioViewProps = {
  activity: StudioActivity;
  sort: StudioSort;
  favorites: boolean;
};

export function StudioView({ activity, sort, favorites }: StudioViewProps) {
  const { isAuthenticated } = useAuthGate();
  const query = useStudioAssets({
    activity,
    favoritesOnly: favorites || undefined,
    order: sort,
  });

  const assets = query.data?.pages.flatMap((page) => page.assets) ?? [];
  const to = activity === 'video' ? '/videos' : '/images';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <PageIntro
          title={activity === 'video' ? 'Videos' : 'Images'}
          maxWidth="wide"
        >
          {activity === 'video'
            ? 'Make or edit short clips with any video model.'
            : 'Make or edit images with any image model.'}
        </PageIntro>
        <PageContainer maxWidth="wide" padding="none" className="pb-8">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              asChild
              size="sm"
              variant={favorites ? 'default' : 'outline'}
            >
              <Link
                to={to}
                search={{
                  sort: sort === 'newest' ? undefined : sort,
                  favorites: favorites ? undefined : true,
                }}
              >
                <Star className="size-4" aria-hidden="true" />
                Favorites
              </Link>
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button
                asChild
                size="sm"
                variant={sort === 'newest' ? 'default' : 'outline'}
              >
                <Link
                  to={to}
                  search={{
                    sort: undefined,
                    favorites: favorites ? true : undefined,
                  }}
                >
                  Newest
                </Link>
              </Button>
              <Button
                asChild
                size="sm"
                variant={sort === 'oldest' ? 'default' : 'outline'}
              >
                <Link
                  to={to}
                  search={{
                    sort: 'oldest',
                    favorites: favorites ? true : undefined,
                  }}
                >
                  Oldest
                </Link>
              </Button>
            </div>
          </div>

          <StudioGallery
            assets={assets}
            isLoading={query.isPending && isAuthenticated}
            isAuthenticated={isAuthenticated}
            activity={activity}
            hasNextPage={query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        </PageContainer>
      </div>

      <div className="shrink-0 border-t bg-background/80 backdrop-blur-md">
        <PageContainer maxWidth="wide" padding="compact" className="py-4">
          <StudioComposer activity={activity} />
        </PageContainer>
      </div>
    </div>
  );
}
