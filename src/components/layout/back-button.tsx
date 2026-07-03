/**
 * History-aware back arrow. Goes back when this session has an in-app entry
 * to return to (preserving e.g. the Scenes selection carried in search
 * params); on a deep link / fresh tab it falls back to the given route.
 */

import { Link, useCanGoBack, useRouter } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

type BackButtonProps = {
  /** Where to go when there's no history to go back to. */
  fallbackTo:
    | '/sequences/$id/scenes'
    | '/sequences/$id/cast'
    | '/sequences/$id/locations';
  sequenceId: string;
  label: string;
};

const arrowClass =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted';

export const BackButton: React.FC<BackButtonProps> = ({
  fallbackTo,
  sequenceId,
  label,
}) => {
  const router = useRouter();
  const canGoBack = useCanGoBack();

  if (canGoBack) {
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => router.history.back()}
        className={arrowClass}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
    );
  }
  return (
    <Link
      to={fallbackTo}
      params={{ id: sequenceId }}
      aria-label={label}
      className={arrowClass}
    >
      <ArrowLeft className="h-4 w-4" />
    </Link>
  );
};
