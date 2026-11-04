/**
 * Organization members, invitations, and the active organization.
 */

import { createFileRoute } from '@tanstack/react-router';
import { OrganizationSettings } from '@/ui/settings/organization-settings';

export const Route = createFileRoute('/_app/settings/organization')({
  component: OrganizationPage,
  staticData: { breadcrumb: 'Organization' },
});

function OrganizationPage() {
  return <OrganizationSettings />;
}
