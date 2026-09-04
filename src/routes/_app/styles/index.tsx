import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { PageContainer } from '@/components/layout/page-container';
import { StyleLibraryView } from '@/components/style-library/style-library-view';
import { PageIntro } from '@/components/typography/page-intro';
import { useStyles } from '@/hooks/use-styles';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/styles/')({
  component: StylesPage,
  staticData: { breadcrumb: 'Styles' },
});

function StylesPage() {
  const { isAuthenticated } = useAuthGate();
  const { data: styles } = useStyles();

  return (
    <div className="h-full overflow-auto">
      <PageIntro title="Styles">
        {isAuthenticated
          ? 'Browse every visual style. Hover a tile to preview it in motion, or open one to see its sample video and look.'
          : 'Browse every visual style available for your sequences. Hover a tile to preview it in motion, or open one for a closer look.'}
      </PageIntro>
      <PageContainer padding="none" className="pb-8">
        <StyleLibraryView styles={styles} />
      </PageContainer>
    </div>
  );
}
