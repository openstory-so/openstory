import { PageContainer } from '@/components/layout/page-container';
import { SampleVideoCard } from '@/components/style/sample-video-showcase';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useStyles } from '@/hooks/use-styles';
import { buildSampleEntries } from '@/components/style/sample-entries';
import { createFileRoute } from '@tanstack/react-router';
import { Clapperboard } from 'lucide-react';

export const Route = createFileRoute('/_app/gallery/')({
  component: GalleryPage,
  staticData: { breadcrumb: 'Gallery' },
});

function GalleryPage() {
  const { data: styles, isPending } = useStyles();
  const entries = buildSampleEntries(styles ?? []);

  return (
    <div className="h-full overflow-auto">
      <PageContainer>
        <h1 className="sr-only">Gallery</h1>

        {isPending ? (
          // Masonry columns mirror the final layout's mixed aspect ratios.
          <div className="columns-2 gap-4 md:columns-3 lg:columns-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton
                key={i}
                className="mb-4 aspect-video w-full rounded-lg"
              />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<Clapperboard className="h-12 w-12" />}
            title="No sample videos yet"
            description="Style samples will appear here once they've been generated."
          />
        ) : (
          <div className="columns-2 gap-4 md:columns-3 lg:columns-4">
            {entries.map((entry) => (
              <div key={entry.key} className="mb-4 break-inside-avoid">
                <SampleVideoCard entry={entry} />
              </div>
            ))}
          </div>
        )}
      </PageContainer>
    </div>
  );
}
