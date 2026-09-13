import { CreatingScenesView } from '@/sequences/ui/creating-scenes-view';
import {
  claimCreatingSequenceStart,
  clearCreatingSequence,
  peekCreatingSequence,
} from '@/sequences/ui/creating-sequence';
import { useCreateSequence } from '@/sequences/ui/use-sequences';
import { clearSequenceDraft } from '@/sequences/ui/script/sequence-draft';
import { requireSessionOrRedirect } from '@/platform/ui/auth/route-guards';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';

export const Route = createFileRoute('/_app/sequences/new/scenes')({
  beforeLoad: async ({ context: { queryClient }, location }) => {
    await requireSessionOrRedirect(queryClient, location.href);
  },
  component: CreatingScenesPage,
  staticData: {
    breadcrumb: [
      { label: 'Sequences', to: '/sequences' },
      { label: 'New sequence', to: '/sequences/new' },
      { label: 'Scenes' },
    ],
  },
});

function CreatingScenesPage() {
  const navigate = useNavigate();
  const create = useCreateSequence();
  const parked = peekCreatingSequence();

  useEffect(() => {
    const state = peekCreatingSequence();
    if (!state) {
      void navigate({ to: '/' });
      return;
    }
    if (!claimCreatingSequenceStart()) return;
    create.mutate(state.payload, {
      onSuccess: (result) => {
        const id = result.data[0]?.id;
        clearSequenceDraft();
        if (!id) {
          clearCreatingSequence();
          void navigate({ to: '/' });
          return;
        }
        void navigate({
          to: '/sequences/$id/scenes',
          params: { id },
          replace: true,
        }).then(() => {
          clearCreatingSequence();
        });
      },
      onError: () => {
        clearCreatingSequence();
        window.history.back();
      },
    });
    // Mount-only: Strict Mode remounts are gated by claimCreatingSequenceStart.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- create on mount
  }, []);

  if (!parked) return null;

  return (
    <CreatingScenesView
      script={parked.script}
      stopAt={parked.stopAt}
      generateStartFrames={parked.generateStartFrames}
    />
  );
}
