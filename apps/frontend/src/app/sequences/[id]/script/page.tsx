"use client";
import { useRouter } from "next/navigation";
import { use } from "react";
import { PageContainer } from "@/components/layout";
import { ScriptStep } from "@/components/sequence-flow/script-step";
import { StepNavigation } from "@/components/sequence-flow/step-navigation";
import {
  PageDescription,
  PageHeader,
  PageHeading,
} from "@/components/typography";
import { useUser } from "@/hooks/use-user";

export default function ScriptPage({
  params,
}: {
  params: Promise<{
    id: string;
  }>;
}) {
  const { id: sequenceId } = use(params);

  const router = useRouter();
  // Verify session
  useUser();

  const handleSuccess = (updatedSequenceId: string) => {
    // Navigate to storyboard page after successful generation
    router.push(`/sequences/${updatedSequenceId}/storyboard`);
  };

  return (
    <PageContainer maxWidth="narrow" data-testid="edit-script-page">
      <PageHeader>
        <PageHeading>Edit Script</PageHeading>
        <PageDescription>
          Update your script and regenerate the storyboard with new frames.
        </PageDescription>
      </PageHeader>
      <StepNavigation
        sequenceId={sequenceId}
        currentStep={1}
        completedSteps={new Set([1])}
      />
      <ScriptStep sequenceId={sequenceId} onSuccess={handleSuccess} />
    </PageContainer>
  );
}
