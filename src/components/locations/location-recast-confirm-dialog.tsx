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

type LocationRecastConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  locationName: string;
  libraryLocationName: string;
  affectedShotCount: number;
  isLoading: boolean;
};

export const LocationRecastConfirmDialog: React.FC<
  LocationRecastConfirmDialogProps
> = ({
  open,
  onOpenChange,
  onConfirm,
  locationName,
  libraryLocationName,
  affectedShotCount,
  isLoading,
}) => {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Update {locationName} reference?</AlertDialogTitle>
          <AlertDialogDescription>
            This will regenerate the reference image for "{locationName}" using
            "{libraryLocationName}" as the visual reference.
            {affectedShotCount > 0 && (
              <>
                {' '}
                <strong>
                  {affectedShotCount}{' '}
                  {affectedShotCount === 1 ? 'shot' : 'shots'}
                </strong>{' '}
                at this location will be regenerated with the new look.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <span>{isLoading ? 'Updating…' : 'Update Reference'}</span>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
