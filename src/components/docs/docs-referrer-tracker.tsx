import {
  isDocsPath,
  rememberDocsReturnUrl,
} from '@/components/docs/docs-referrer';
import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

export function DocsReferrerTracker() {
  const router = useRouter();

  useEffect(() => {
    const unsubscribe = router.subscribe('onBeforeLoad', (event) => {
      const { fromLocation, toLocation } = event;
      if (!fromLocation) return;
      if (!isDocsPath(toLocation.pathname)) return;
      if (isDocsPath(fromLocation.pathname)) return;
      rememberDocsReturnUrl(fromLocation.href);
    });
    return unsubscribe;
  }, [router]);

  return null;
}
