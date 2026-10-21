import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/shadcn/alert-dialog';

type LocationRecastConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  locationName: string;
  /** The team location the sequence will use instead. */
  withLocationName: string;
  affectedShotCount: number;
  isLoading: boolean;
};

/**
 * Confirm a Replace (#1695): the sequence is re-pointed at another of the
 * team's locations and the shots set here re-render. No sheet is drawn.
 */
export const LocationRecastConfirmDialog: React.FC<
  LocationRecastConfirmDialogProps
> = ({
  open,
  onOpenChange,
  onConfirm,
  locationName,
  withLocationName,
  affectedShotCount,
  isLoading,
}) => {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Replace {locationName} with {withLocationName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {`This sequence uses ${withLocationName} instead. ${
              affectedShotCount === 0
                ? 'No shot is set here.'
                : affectedShotCount === 1
                  ? '1 shot set here re-renders.'
                  : `${affectedShotCount} shots set here re-render.`
            } ${locationName} stays in your locations.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isLoading}>
            {isLoading ? 'Replacing…' : 'Replace'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
