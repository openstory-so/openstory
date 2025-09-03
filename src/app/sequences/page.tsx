import Link from "next/link";
import { VideoIcon } from "@/components/icons";
import { PageContainer } from "@/components/layout";
import {
  PageDescription,
  PageHeader,
  PageHeading,
} from "@/components/typography";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function SequencesPage() {
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

      {/* TODO: Add sequences list component here when implemented */}
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
    </PageContainer>
  );
}
