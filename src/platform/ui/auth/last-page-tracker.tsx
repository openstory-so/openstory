import { rememberLastPage } from './last-page';
import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

function pageHref(location: { pathname: string; searchStr: string }): string {
  return `${location.pathname}${location.searchStr}`;
}

/** Keep the current in-app page in localStorage for the next bare login. */
export function LastPageTracker() {
  const router = useRouter();

  useEffect(() => {
    rememberLastPage(pageHref(router.state.location));
    return router.subscribe('onResolved', () => {
      rememberLastPage(pageHref(router.state.location));
    });
  }, [router]);

  return null;
}
