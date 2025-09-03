"use client";

import { useRouter } from "next/navigation";
import { use, useCallback, useState } from "react";
import { PageContainer } from "@/components/layout";
import { MotionStep } from "@/components/sequence-flow/motion-step";
import { StepNavigation } from "@/components/sequence-flow/step-navigation";
import {
  PageDescription,
  PageHeader,
  PageHeading,
} from "@/components/typography";
import { useFramesBySequence } from "@/hooks/use-frames";
import { useSequence } from "@/hooks/use-sequences";
import { useUser } from "@/hooks/use-user";

export const dynamic = "force-dynamic";

interface MotionPageProps {
  params: Promise<{
    id: string;
  }>;
}

export default function MotionPage({ params }: MotionPageProps) {
  const { id: sequenceId } = use(params);
  const router = useRouter();
  const { data: userData } = useUser();
  const _user = userData?.user;

  // Load the sequence data
  const { data: sequence, isLoading: isLoadingSequence } =
    useSequence(sequenceId);
  const { data: frames = [], isLoading: isLoadingFrames } =
    useFramesBySequence(sequenceId);
  const isLoading = isLoadingSequence || isLoadingFrames;

  // Local state for motion generation
  const [generatingFrameIds, setGeneratingFrameIds] = useState<Set<string>>(
    new Set(),
  );
  const [generationErrors, setGenerationErrors] = useState<Map<string, string>>(
    new Map(),
  );

  // Completed steps based on what's in the sequence
  const completedSteps = new Set([1, 2]); // Script and storyboard are completed to get here

  // Check if any frames have motion
  const hasMotion = frames.some((frame) => frame.video_url);
  if (hasMotion) {
    completedSteps.add(3);
  }

  const handlePrevious = useCallback(() => {
    router.push(`/sequences/${sequenceId}/storyboard`);
  }, [sequenceId, router]);

  const handleStepClick = useCallback(
    (step: 1 | 2 | 3) => {
      switch (step) {
        case 1:
          router.push(`/sequences/new`);
          break;
        case 2:
          router.push(`/sequences/${sequenceId}/storyboard`);
          break;
        case 3:
          // Already on motion page
          break;
      }
    },
    [sequenceId, router],
  );

  if (isLoading) {
    return (
      <PageContainer maxWidth="narrow" data-testid="motion-page">
        <PageHeader>
          <PageHeading>Loading sequence...</PageHeading>
        </PageHeader>
      </PageContainer>
    );
  }

  if (!sequence) {
    return (
      <PageContainer maxWidth="narrow" data-testid="motion-page">
        <PageHeader>
          <PageHeading>Sequence not found</PageHeading>
        </PageHeader>
      </PageContainer>
    );
  }

  return (
    <PageContainer maxWidth="narrow" data-testid="motion-page">
      <PageHeader>
        <PageHeading>Motion Generation</PageHeading>
        <PageDescription>
          Add dynamic motion to your storyboard frames to create engaging
          videos.
        </PageDescription>
      </PageHeader>

      <StepNavigation
        currentStep={3}
        completedSteps={completedSteps}
        onStepClick={handleStepClick}
      />

      <MotionStep
        sequence={sequence}
        frames={frames}
        generatingFrameIds={generatingFrameIds}
        generationErrors={generationErrors}
        onMotionGenerationStart={(frameId) => {
          setGeneratingFrameIds((prev) => new Set([...prev, frameId]));
          setGenerationErrors((prev) => {
            const next = new Map(prev);
            next.delete(frameId);
            return next;
          });
        }}
        onMotionGenerationComplete={(frameId) => {
          setGeneratingFrameIds((prev) => {
            const next = new Set(prev);
            next.delete(frameId);
            return next;
          });

          // Note: The frame will be updated in the database by generateFrameMotion
          // The useFramesBySequence hook will automatically refetch
        }}
        onMotionGenerationError={(frameId, error) => {
          setGeneratingFrameIds((prev) => {
            const next = new Set(prev);
            next.delete(frameId);
            return next;
          });
          setGenerationErrors((prev) => new Map(prev).set(frameId, error));
        }}
        onPrevious={handlePrevious}
      />
    </PageContainer>
  );
}
