import { Alert, AlertDescription } from '@/components/ui/alert';
import { getComplianceStatusFn } from '@/functions/compliance';
import { useAuthSession } from '@/lib/auth/session-query';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ShieldAlert } from 'lucide-react';

export const ComplianceRestrictionBanner: React.FC = () => {
  // The app shell is anonymous-browsable; the status fn requires auth, so
  // don't fire (and error-log) it without a session.
  const { data: session } = useAuthSession();
  const { data } = useQuery({
    queryKey: ['compliance-status'],
    queryFn: () => getComplianceStatusFn(),
    staleTime: 30_000,
    retry: false,
    enabled: !!session,
  });

  if (!data?.restrictionNotice) return null;

  return (
    <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
      <ShieldAlert className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between gap-4">
        <span>{data.restrictionNotice}</span>
        <Link to="/report" className="shrink-0 font-medium underline">
          Appeal or report →
        </Link>
      </AlertDescription>
    </Alert>
  );
};
