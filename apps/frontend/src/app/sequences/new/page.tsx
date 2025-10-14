"use client";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { PageContainer } from "@/components/layout";
import { ScriptStep } from "@/components/sequence-flow/script-step";
import {
  PageDescription,
  PageHeader,
  PageHeading,
} from "@/components/typography";
import { useUser } from "@/hooks/use-user";

export default function NewSequencePage() {
  // Verify session
  const { data: userData } = useUser();
  const _user = userData?.user;

  const router = useRouter();

  const handleSuccess = useCallback(
    (sequenceId: string) => {
      // Navigate to storyboard page after successful generation
      router.push(`/sequences/${sequenceId}/storyboard`);
    },
    [router],
  );

  return (
    <PageContainer maxWidth="narrow" data-testid="new-sequence-page">
      <PageHeader>
        <PageHeading>Create New Sequence</PageHeading>
        <PageDescription>
          Transform your script into a professional video sequence. Start
          creating immediately - no signup required.
        </PageDescription>
      </PageHeader>

      <ScriptStep onSuccess={handleSuccess} />
    </PageContainer>
  );
}
