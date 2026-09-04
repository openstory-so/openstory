import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Loader2 } from 'lucide-react';

type RecastConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  characterName: string;
  talentName: string;
  /** True when this role already has talent — copy says Recast, not Cast. */
  replacingExisting: boolean;
  affectedShotCount: number;
  isLoading: boolean;
};

export const RecastConfirmDialog: React.FC<RecastConfirmDialogProps> = ({
  open,
  onOpenChange,
  onConfirm,
  characterName,
  talentName,
  replacingExisting,
  affectedShotCount,
  isLoading,
}) => {
  const verb = replacingExisting ? 'Recast' : 'Cast';
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {verb} {talentName} as {characterName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This will generate a new character sheet using {talentName} as the
            reference.
            {affectedShotCount > 0 && (
              <>
                {' '}
                <strong>
                  {affectedShotCount}{' '}
                  {affectedShotCount === 1 ? 'shot' : 'shots'}
                </strong>{' '}
                containing this character will need to be regenerated.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <span>{isLoading ? `${verb}ing…` : verb}</span>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
