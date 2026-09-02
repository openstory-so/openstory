/**
 * Developer API Settings Page
 * Manage keys used to authenticate calls to the public OpenStory API, and the
 * apps that were granted access via OAuth (#1456).
 */

import { DeveloperApiKeySettings } from '@/components/settings/developer-api-key-settings';
import { DeveloperAuthorizedApps } from '@/components/settings/developer-authorized-apps';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/settings/developer')({
  component: DeveloperPage,
  staticData: { breadcrumb: 'Developer' },
});

function DeveloperPage() {
  return (
    <div className="flex flex-col gap-6">
      <DeveloperApiKeySettings />
      <DeveloperAuthorizedApps />
    </div>
  );
}
