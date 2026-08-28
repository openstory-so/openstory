import { getInternalDomains, isSystemAdmin } from '@/lib/auth/system-admin';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  authMiddleware,
  authWithTeamMiddleware,
  systemAdminMiddleware,
} from './middleware';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const createGiftTokenFn = createServerFn({ method: 'POST' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        amountUsd: z.number().positive(),
        maxRedemptions: z.number().int().min(1).default(1),
        note: z.string().optional(),
        expiresInDays: z.number().positive().optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const expiresAt = data.expiresInDays
      ? new Date(Date.now() + data.expiresInDays * MS_PER_DAY)
      : undefined;

    // Admin ops use a dummy teamId since they're not team-scoped
    return context.adminScopedDb.admin.createGiftToken({
      createdByUserId: context.user.id,
      amountUsd: data.amountUsd,
      maxRedemptions: data.maxRedemptions,
      note: data.note,
      expiresAt,
    });
  });

export const batchCreateGiftTokensFn = createServerFn({ method: 'POST' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        count: z.number().int().min(1).max(500),
        amountUsd: z.number().positive(),
        note: z.string().optional(),
        expiresInDays: z.number().positive().optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const expiresAt = data.expiresInDays
      ? new Date(Date.now() + data.expiresInDays * MS_PER_DAY)
      : undefined;

    const codes: string[] = [];
    for (let i = 0; i < data.count; i++) {
      const token = await context.adminScopedDb.admin.createGiftToken({
        createdByUserId: context.user.id,
        amountUsd: data.amountUsd,
        maxRedemptions: 1,
        note: data.note,
        expiresAt,
      });
      codes.push(token.code);
    }
    return { codes };
  });

export const redeemGiftTokenFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ code: z.string().min(1) })))
  .handler(async ({ context, data }) => {
    return context.scopedDb.billing.redeemGiftToken({
      code: data.code,
      teamId: context.teamId,
      userId: context.user.id,
      addCredits: context.scopedDb.billing.addCredits,
    });
  });

export const listGiftTokensFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .handler(async ({ context }) => {
    return context.adminScopedDb.admin.listGiftTokens();
  });

export const isSystemAdminFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const isAdmin = isSystemAdmin(context.user.email);
    return {
      isAdmin,
      internalDomains: isAdmin ? getInternalDomains() : [],
    };
  });
