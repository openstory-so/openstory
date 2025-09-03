"use client";

import { useRouter } from "next/navigation";
import { use, useCallback, useState } from "react";
import { PageContainer } from "@/components/layout";
import { StepNavigation } from "@/components/sequence-flow/step-navigation";
import { StoryboardStep } from "@/components/sequence-flow/storyboard-step";
import {
  PageDescription,
  PageHeader,
  PageHeading,
} from "@/components/typography";
import { useFramesBySequence, useReorderFrames } from "@/hooks/use-frames";
import { useSequence } from "@/hooks/use-sequences";
import { useUser } from "@/hooks/use-user";

export const dynamic = "force-dynamic";

interface StoryboardPageProps {
  params: Promise<{
    id: string;
  }>;
}

export default function StoryboardPage({ params }: StoryboardPageProps) {
  const { id: sequenceId } = use(params);
  const router = useRouter();
  const { data: userData } = useUser();
  const _user = userData?.user;

  // Load the sequence data
  const { data: sequence, isLoading: isLoadingSequence } =
    useSequence(sequenceId);
  const { data: frames = [], isLoading: isLoadingFrames } =
    useFramesBySequence(sequenceId);
  const reorderFrames = useReorderFrames();
  const isLoading = isLoadingSequence || isLoadingFrames;

  // Local state for generation
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);

  // Completed steps based on what's in the sequence
  const completedSteps = new Set([1]); // Script is always completed to get here
  if (frames.length > 0) {
    completedSteps.add(2);
  }

  const handleNext = useCallback(() => {
    router.push(`/sequences/${sequenceId}/motion`);
  }, [sequenceId, router]);

  const handlePrevious = useCallback(() => {
    router.push(`/sequences/new`);
  }, [router]);

  const handleStepClick = useCallback(
    (step: 1 | 2 | 3) => {
      switch (step) {
        case 1:
          router.push(`/sequences/new`);
          break;
        case 2:
          // Already on storyboard page
          break;
        case 3:
          if (completedSteps.has(2)) {
            router.push(`/sequences/${sequenceId}/motion`);
          }
          break;
      }
    },
    [sequenceId, router, completedSteps],
  );

  if (isLoading) {
    return (
      <PageContainer maxWidth="narrow" data-testid="storyboard-page">
        <PageHeader>
          <PageHeading>Loading sequence...</PageHeading>
        </PageHeader>
      </PageContainer>
    );
  }

  if (!sequence) {
    return (
      <PageContainer maxWidth="narrow" data-testid="storyboard-page">
        <PageHeader>
          <PageHeading>Sequence not found</PageHeading>
        </PageHeader>
      </PageContainer>
    );
  }

  return (
    <PageContainer maxWidth="narrow" data-testid="storyboard-page">
      <PageHeader>
        <PageHeading>Storyboard Generation</PageHeading>
        <PageDescription>
          Review and refine your AI-generated storyboard frames.
        </PageDescription>
      </PageHeader>

      <StepNavigation
        currentStep={2}
        completedSteps={completedSteps}
        onStepClick={handleStepClick}
      />

      <StoryboardStep
        sequence={sequence}
        frames={frames}
        isGenerating={isGenerating}
        generationError={generationError}
        onGenerationStart={() => {
          setIsGenerating(true);
          setGenerationError(null);
        }}
        onGenerationComplete={() => {
          setIsGenerating(false);
          // Frames are already saved in the database by generateFrames
          // The useFramesBySequence hook will automatically refetch
        }}
        onGenerationError={(error) => {
          setIsGenerating(false);
          setGenerationError(error);
        }}
        onFrameReorder={(reorderedFrames) => {
          // Create the new order mapping
          const frameOrders = reorderedFrames.map((frame, index) => ({
            id: frame.id,
            order_index: index + 1,
          }));
          reorderFrames.mutate({ sequenceId, frameOrders });
        }}
        onNext={handleNext}
        onPrevious={handlePrevious}
      />
    </PageContainer>
  );
}
