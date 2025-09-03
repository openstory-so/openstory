"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { PageContainer } from "@/components/layout";
import { ScriptStep } from "@/components/sequence-flow/script-step";
import {
  PageDescription,
  PageHeader,
  PageHeading,
} from "@/components/typography";
import { useUser } from "@/hooks/use-user";
import { useSequenceFlowReducer } from "@/reducers/sequence-flow-reducer";

export const dynamic = "force-dynamic";

export default function NewSequencePage() {
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
  });

  const handleNext = useCallback(async () => {
    // When frames are generated, navigate to storyboard page
    // The ScriptStep component will handle generating frames
    // and will update the sequence with an ID
    if (state.sequence?.id && state.sequence.frames.length > 0) {
      const sequenceId = state.sequence.id;
      router.push(`/sequences/${sequenceId}/storyboard`);
    }
  }, [state.sequence, router]);

  // Watch for when frames are generated and navigate
  useEffect(() => {
    if (state.sequence?.id && state.sequence.frames.length > 0) {
      const sequenceId = state.sequence.id;
      router.push(`/sequences/${sequenceId}/storyboard`);
    }
  }, [state.sequence?.id, state.sequence?.frames.length, router]);

  return (
    <PageContainer maxWidth="narrow" data-testid="new-sequence-page">
      <PageHeader>
        <PageHeading>Create New Sequence</PageHeading>
        <PageDescription>
          Transform your script into a professional video sequence. Start
          creating immediately - no signup required.
        </PageDescription>
      </PageHeader>

      <ScriptStep state={state} dispatch={dispatch} onNext={handleNext} />
    </PageContainer>
  );
}
