"use client";

import Link from "next/link";
import { VideoIcon } from "@/components/icons";
import { PageContainer } from "@/components/layout";
import { SequencesList } from "@/components/sequence/sequences-list";
import {
  PageDescription,
  PageHeader,
  PageHeading,
} from "@/components/typography";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useSequences } from "@/hooks/use-sequences";

export default function SequencesPage() {
  const { data: sequences, isLoading } = useSequences();

  return (
    <PageContainer>
      <PageHeader
        actions={
          <Button asChild>
            <Link href="/sequences/new">Create New Sequence</Link>
          </Button>
        }
      >
        <PageHeading>Your Sequences</PageHeading>
        <PageDescription>
          Manage and view all your video sequences in one place.
        </PageDescription>
      </PageHeader>

      {!isLoading && sequences && sequences.length === 0 ? (
        <EmptyState
          icon={<VideoIcon size="xl" />}
          title="No sequences yet"
          description="Get started by creating your first video sequence. Transform your script into professional video content with AI assistance."
          action={
            <Button asChild size="lg">
              <Link href="/sequences/new">Create Your First Sequence</Link>
            </Button>
          }
        />
      ) : (
        <SequencesList />
      )}
    </PageContainer>
  );
}
