"use client";

import { useRouter } from "next/navigation";
import { use, useCallback, useEffect } from "react";
import { PageContainer } from "@/components/layout";
import { StepNavigation } from "@/components/sequence-flow/step-navigation";
import { StoryboardStep } from "@/components/sequence-flow/storyboard-step";
import {
  PageDescription,
  PageHeader,
  PageHeading,
} from "@/components/typography";
import { useUser } from "@/hooks/use-user";
import { useSequenceFlowReducer } from "@/reducers/sequence-flow-reducer";

export const dynamic = "force-dynamic";

interface StoryboardPageProps {
  params: Promise<{
    id: string;
  }>;
}

export default function StoryboardPage({ params }: StoryboardPageProps) {
  const { id: sequenceId } = use(params);
  const router = useRouter();
  const { data } = useUser();
  const user = data?.user;

  const [state, dispatch] = useSequenceFlowReducer({
    user: user
      ? {
          id: user.id,
          sessionId: `session_${user.id}`,
          createdAt: user.created_at || new Date().toISOString(),
          expiresAt: new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        }
      : null,
    currentStep: 2,
    completedSteps: new Set([1]),
  });

  // Load sequence data if needed
  useEffect(() => {
    // In a real app, we'd load the sequence from the API
    // For now, we'll assume the sequence is already in state
    if (!state.sequence && sequenceId) {
      // TODO: Load sequence from API
      console.log("Loading sequence:", sequenceId);
    }
  }, [sequenceId, state.sequence]);

  const handleNext = useCallback(() => {
    // Navigate to motion page
    router.push(`/sequences/${sequenceId}/motion`);
  }, [sequenceId, router]);

  const handlePrevious = useCallback(() => {
    // Navigate back to script editing
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
          if (state.completedSteps.has(2)) {
            router.push(`/sequences/${sequenceId}/motion`);
          }
          break;
      }
    },
    [sequenceId, router, state.completedSteps],
  );

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
        completedSteps={state.completedSteps}
        onStepClick={handleStepClick}
      />

      <StoryboardStep
        state={state}
        dispatch={dispatch}
        onNext={handleNext}
        onPrevious={handlePrevious}
      />
    </PageContainer>
  );
}
