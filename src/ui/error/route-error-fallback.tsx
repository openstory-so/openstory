import { Alert, AlertDescription, AlertTitle } from '@/ui/shadcn/alert';
import { Button } from '@/ui/shadcn/button';
import { AppUpdatedNotice, isAppUpdatedError } from './app-updated-notice';
import { DefaultNotFound } from './default-not-found';
import { Navigate, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { AlertCircle } from 'lucide-react';

import { errorCode, isUnauthenticatedError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'ui', 'error', 'route-error-fallback']);

type RouteErrorFallbackProps = ErrorComponentProps & {
  heading?: string;
};

function isNotFoundError(error: unknown): boolean {
  // Prefer the stable code that survives the server-fn boundary (#1087).
  if (errorCode(error) === 'NOT_FOUND') return true;
  // Router `notFound()` / residual plain Errors without a code.
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('not found') ||
      message.includes('not_found') ||
      message.includes('invalid ulid')
    );
  }
  return false;
}

export const RouteErrorFallback: React.FC<RouteErrorFallbackProps> = ({
  error,
  reset,
  heading = 'Something went wrong',
}) => {
  const router = useRouter();
  const is404 = isNotFoundError(error);

  if (isAppUpdatedError(error)) {
    return <AppUpdatedNotice />;
  }

  // A session that expired under an open tab still passes the route guard
  // from the cache; the server fn is what says no (#2034).
  const { pathname, href } = router.state.location;
  if (isUnauthenticatedError(error) && !pathname.startsWith('/login')) {
    return <Navigate to="/login" search={{ redirectTo: href }} replace />;
  }

  logger.error(`[RouteError:${heading}]`, { err: error });

  if (is404) {
    return <DefaultNotFound />;
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Alert variant="destructive" className="max-w-lg">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{heading}</AlertTitle>
        <AlertDescription className="flex flex-col gap-3">
          <p>
            {error instanceof Error
              ? error.message
              : 'An unexpected error occurred'}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => {
              reset();
              void router.invalidate();
            }}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
};
