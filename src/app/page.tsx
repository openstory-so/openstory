import Link from "next/link";
import { FeatureGrid } from "@/components/layout/feature-grid";
import { HeroActions } from "@/components/layout/hero-actions";
import { HeroSection } from "@/components/layout/hero-section";
import { PageContainer } from "@/components/layout/page-container";
import { PageDescription } from "@/components/typography/page-description";
import { PageHeading } from "@/components/typography/page-heading";
import { Button } from "@/components/ui/button";
import { FeatureCard } from "@/components/ui/feature-card";

export const HomePage: React.FC = () => {
  return (
    <PageContainer padding="spacious" maxWidth="narrow">
      <HeroSection>
        <PageHeading size="hero">
          AI-Powered Video Sequence Creation
        </PageHeading>
        <PageDescription size="large" align="center" maxWidth="narrow">
          Try our AI-powered video creation tool instantly. No signup required -
          start creating professional video sequences from your script right
          away.
        </PageDescription>

        <HeroActions>
          <Button asChild size="lg">
            <Link href="/create">Start Creating</Link>
          </Button>

          <Button variant="outline" size="lg" asChild>
            <Link href="/sequences">View Sequences</Link>
          </Button>
        </HeroActions>

        <FeatureGrid>
          <FeatureCard
            title="Script-Driven"
            description="Everything generates from your script to maintain consistency across all frames and scenes."
          />

          <FeatureCard
            title="Style Stacks"
            description="Use consistent visual styles across different AI models with our innovative Style Stack system."
          />

          <FeatureCard
            title="Team Collaboration"
            description="Share characters, styles, and resources with your team for seamless collaborative video creation."
          />
        </FeatureGrid>
      </HeroSection>
    </PageContainer>
  );
};

export default HomePage;
