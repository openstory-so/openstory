"use client";

import { useRouter } from "next/navigation";
import { use, useCallback, useEffect } from "react";
import { PageContainer } from "@/components/layout";
import { MotionStep } from "@/components/sequence-flow/motion-step";
import { StepNavigation } from "@/components/sequence-flow/step-navigation";
import {
  PageDescription,
  PageHeader,
  PageHeading,
} from "@/components/typography";
import { useUser } from "@/hooks/use-user";
import { useSequenceFlowReducer } from "@/reducers/sequence-flow-reducer";

export const dynamic = "force-dynamic";

interface MotionPageProps {
  params: Promise<{
    id: string;
  }>;
}

export default function MotionPage({ params }: MotionPageProps) {
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
    currentStep: 3,
    completedSteps: new Set([1, 2]),
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

  const handlePrevious = useCallback(() => {
    // Navigate back to storyboard
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
        completedSteps={state.completedSteps}
        onStepClick={handleStepClick}
      />

      <MotionStep
        state={state}
        dispatch={dispatch}
        onPrevious={handlePrevious}
      />
    </PageContainer>
  );
}
