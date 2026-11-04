/**
 * In-app feedback — sidebar dialog posts here, we email CONTACT_EMAIL.
 *
 * Anonymous-first: the sidebar shows Feedback to everyone, so this must not
 * require a session — a visitor's message used to bounce with "Authentication
 * required" and was lost. Signed-in users are identified from the session;
 * visitors may leave an optional email.
 */

import { scheduleFlushAnalytics } from '#flush-scheduler';
import { getAuth } from '@/platform/server/auth/config';
import { ValidationError } from './errors';
import { CONTACT_EMAIL } from '@/ui/marketing/constants';
import { captureProductEvent } from '@/platform/server/observability/product-events';
import { sendFeedbackEmail } from '@/platform/server/emails/email-service';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const feedbackInputSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'Write a short message')
    .max(2000, 'Keep it under 2000 characters'),
  /** Reply address for visitors without a session; ignored when signed in. */
  email: z
    .string()
    .trim()
    .email('Enter a valid email')
    .max(254)
    .or(z.literal(''))
    .optional(),
});

export const submitFeedbackFn = createServerFn({ method: 'POST' })
  .validator(zodValidator(feedbackInputSchema))
  .handler(async ({ data }) => {
    const session = await getAuth().api.getSession({
      headers: getRequest().headers,
    });
    const user = session?.user ?? null;
    const organizationId = session?.session.activeOrganizationId ?? null;
    const userEmail = user?.email ?? data.email ?? '';

    const result = await sendFeedbackEmail({
      to: CONTACT_EMAIL,
      userName: user?.name ?? 'Anonymous visitor',
      userEmail: userEmail || 'not provided',
      organizationId: organizationId ?? '—',
      message: data.message,
    });

    captureProductEvent({
      distinctId: user?.id ?? 'anonymous',
      event: 'feedback_submitted',
      properties: {
        organizationId,
        userEmail: userEmail || null,
        anonymous: !user,
        emailSent: result.success,
        messageLength: data.message.length,
      },
    });
    // No auth middleware here, so no analyticsFlushMiddleware — flush ourselves.
    await scheduleFlushAnalytics();

    if (!result.success) {
      throw new ValidationError(
        `Couldn't send feedback — email ${CONTACT_EMAIL} directly.`
      );
    }

    return { success: true };
  });
