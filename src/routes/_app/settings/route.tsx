/**
 * Settings Layout Route
 * Provides tab navigation between settings sub-pages
 */

import { RouteErrorFallback } from '@/components/error/route-error-fallback';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireSessionOrRedirect } from '@/components/auth/route-guards';
import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
} from '@tanstack/react-router';
import { Fingerprint, Key, Terminal } from 'lucide-react';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsLayout,
  beforeLoad: async ({ context: { queryClient }, location }) => {
    await requireSessionOrRedirect(queryClient, location.href);
  },
  staticData: { breadcrumb: { label: 'Settings', to: '/settings' } },
  errorComponent: (props) => (
    <RouteErrorFallback {...props} heading="Settings error" />
  ),
});

const tabs = [
  {
    value: 'api-keys',
    label: 'API Keys',
    href: '/settings/api-keys',
    icon: <Key className="h-4 w-4" />,
  },
  {
    value: 'passkeys',
    label: 'Passkeys',
    href: '/settings/passkeys',
    icon: <Fingerprint className="h-4 w-4" />,
  },
  {
    value: 'developer',
    label: 'Developer',
    href: '/settings/developer',
    icon: <Terminal className="h-4 w-4" />,
  },
];

function SettingsLayout() {
  const location = useLocation();

  // Determine active tab from current route
  const activeTab =
    tabs.find((tab) => location.pathname === tab.href)?.value || 'api-keys';

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <Tabs value={activeTab} className="mb-6 shrink-0">
        <TabsList className="w-full justify-start">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} asChild>
              <Link to={tab.href} className="flex items-center gap-2">
                {tab.icon}
                {tab.label}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Outlet />
    </div>
  );
}
