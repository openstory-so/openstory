"use client";
import { useRouter } from "next/navigation";
import { use, useCallback } from "react";
import { PageContainer } from "@/components/layout";
import { StepNavigation } from "@/components/sequence-flow/step-navigation";
import { StoryboardStep } from "@/components/sequence-flow/storyboard-step";
import {
  PageDescription,
  PageHeader,
  PageHeading,
} from "@/components/typography";
import { useStoryboardStatus } from "@/hooks/use-storyboard-status";
import { useUser } from "@/hooks/use-user";

interface StoryboardPageProps {
  params: Promise<{
    id: string;
  }>;
}

export default function StoryboardPage({ params }: StoryboardPageProps) {
  const { id: sequenceId } = use(params);
  const router = useRouter();

  // Verify session
  useUser();

  // Use unified storyboard status hook (replaces multiple polling hooks)
  const { frames, isLoading, error } = useStoryboardStatus(sequenceId);

  // Completed steps based on what's in the sequence
  const completedSteps = new Set([1]); // Script is always completed to get here
  if (frames.length > 0) {
    completedSteps.add(2);
  }

  const handlePrevious = useCallback(() => {
    router.push(`/sequences/${sequenceId}/script`);
  }, [sequenceId, router]);

  return (
    <PageContainer maxWidth="narrow" data-testid="storyboard-page">
      <PageHeader>
        {isLoading && <PageHeading>Loading storyboard...</PageHeading>}
        {error && <PageHeading>Error loading storyboard</PageHeading>}
        {!isLoading && !error && (
          <>
            <PageHeading>Storyboard Generation</PageHeading>
            <PageDescription>
              Review and refine your AI-generated storyboard frames.
            </PageDescription>
          </>
        )}
      </PageHeader>

      {!isLoading && !error && (
        <StepNavigation
          sequenceId={sequenceId}
          currentStep={2}
          completedSteps={completedSteps}
        />
      )}

      <StoryboardStep sequenceId={sequenceId} onPrevious={handlePrevious} />
    </PageContainer>
  );
}
