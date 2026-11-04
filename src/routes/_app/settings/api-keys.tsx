/**
 * API Keys Settings Page
 * Manage BYOK (Bring Your Own Key) for AI providers
 */

import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { ApiKeySettings } from '@/ui/settings/api-key-settings';
import {
  ADMIN_PERMISSION,
  sessionHasPermission,
} from '@/platform/ui/auth/organization-permission';
import { sessionQueryOptions } from '@/platform/ui/auth/session-query';

const searchSchema = z.object({
  success: z.string().optional(),
  error: z.string().optional(),
});

export const Route = createFileRoute('/_app/settings/api-keys')({
  validateSearch: searchSchema,
  // Keys are organization-wide: only an admin may read or change them.
  beforeLoad: async ({ context: { queryClient } }) => {
    const session = await queryClient.ensureQueryData(sessionQueryOptions);
    if (!sessionHasPermission(session, ADMIN_PERMISSION)) {
      throw redirect({ to: '/settings/organization' });
    }
  },
  component: ApiKeysPage,
  staticData: { breadcrumb: 'API Keys' },
});

function ApiKeysPage() {
  const { success, error } = Route.useSearch();

  return <ApiKeySettings success={success} error={error} />;
}
