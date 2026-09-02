import { useSetSequenceModel } from '@/hooks/use-sequences';
import type { ModelCoverage } from '@/shared/model/sequence-model-coverage';
import { toast } from 'sonner';

/**
 * Sequence-wide "Set" action for a header model dropdown row (#547). Promotes
 * this model to the live primary across every scene that has generated it.
 * Renders nothing for the model that is already the live primary, or for a
 * model that hasn't generated anything yet (nothing to promote).
 */
export const SetModelButton = ({
  sequenceId,
  variantType,
  model,
  modelName,
  coverage,
}: {
  sequenceId: string;
  variantType: 'image' | 'video';
  model: string;
  modelName: string;
  coverage?: ModelCoverage;
}) => {
  const setModel = useSetSequenceModel();

  if (!coverage || coverage.status === 'set' || coverage.completed === 0) {
    return null;
  }

  return (
    <button
      type="button"
      disabled={setModel.isPending}
      // Stop the click from toggling the row's pin / closing the menu.
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setModel.mutate(
          { sequenceId, variantType, model },
          {
            onSuccess: (r) =>
              toast.success(
                `Set ${modelName} on ${r.count} scene${r.count === 1 ? '' : 's'}`
              ),
            onError: (err) => toast.error(err.message),
          }
        );
      }}
      className="rounded border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
    >
      Set
    </button>
  );
};
