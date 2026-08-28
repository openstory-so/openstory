import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { getTalentChannel } from '@/lib/realtime';
import { ulidSchema } from '@/lib/schemas/id.schemas';

import { authWithTeamMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'talent-sheet-variants']);

const variantInputSchema = z.object({
  variantId: ulidSchema,
});

/**
 * List active divergent talent-sheet variants across every talent visible to
 * the team. Drives the corner-dot indicator on `talent-library-card`.
 */
export const getTeamTalentDivergentVariantsFn = createServerFn({
  method: 'GET',
})
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const talents = await context.scopedDb.talent.list();
    if (talents.length === 0) return [];
    return context.scopedDb.talentSheetVariants.listDivergentActiveByTalents(
      talents.map((t) => t.id)
    );
  });

/**
 * List active divergent variants for a single talent's sheets. Drives the
 * banner inside `edit-talent-dialog`.
 */
export const getTalentDivergentVariantsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ talentId: ulidSchema })))
  .handler(async ({ data, context }) => {
    const talent = await context.scopedDb.talent.getWithRelations(
      data.talentId
    );
    if (!talent) {
      throw new Error('Talent not found');
    }
    return context.scopedDb.talentSheetVariants.listDivergentActiveByTalentSheets(
      talent.sheets.map((s) => s.id)
    );
  });

export const promoteTalentSheetVariantFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.talentSheetVariants.getById(
      data.variantId
    );
    if (!variant) {
      throw new Error('Talent sheet variant not found');
    }
    if (variant.divergedAt === null || variant.discardedAt !== null) {
      throw new Error('Variant is not a live divergent alternate');
    }
    if (!variant.url) {
      throw new Error('Variant has no asset to promote');
    }

    const sheet = await context.scopedDb.talent.sheets.getById(
      variant.talentSheetId
    );
    if (!sheet) {
      throw new Error('Talent sheet not found');
    }
    // ACL check via the team-scoped talent.getById accessor — returns
    // undefined when the talent is private to another team.
    const talent = await context.scopedDb.talent.getById(sheet.talentId);
    if (!talent) {
      throw new Error('Talent not found');
    }

    await context.scopedDb.talentSheetVariants.promoteAtomically(
      variant.talentSheetId,
      {
        imageUrl: variant.url,
        imagePath: variant.storagePath,
        inputHash: variant.inputHash,
      },
      variant.id
    );

    try {
      await getTalentChannel(talent.id).emit('talent.sheet:progress', {
        talentId: talent.id,
        status: 'completed',
        sheetId: sheet.id,
        sheetImageUrl: variant.url,
      });
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    return {
      variantId: variant.id,
      talentId: talent.id,
      talentSheetId: variant.talentSheetId,
    };
  });

export const discardTalentSheetVariantFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.talentSheetVariants.getById(
      data.variantId
    );
    if (!variant) {
      throw new Error('Talent sheet variant not found');
    }
    const sheet = await context.scopedDb.talent.sheets.getById(
      variant.talentSheetId
    );
    if (!sheet) {
      throw new Error('Talent sheet not found');
    }
    const talent = await context.scopedDb.talent.getById(sheet.talentId);
    if (!talent) {
      throw new Error('Talent not found');
    }
    const discardedAt = await context.scopedDb.talentSheetVariants.discard(
      variant.id
    );
    return { variantId: variant.id, discardedAt };
  });

export const undiscardTalentSheetVariantFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.talentSheetVariants.getById(
      data.variantId
    );
    if (!variant) {
      throw new Error('Talent sheet variant not found');
    }
    const sheet = await context.scopedDb.talent.sheets.getById(
      variant.talentSheetId
    );
    if (!sheet) {
      throw new Error('Talent sheet not found');
    }
    const talent = await context.scopedDb.talent.getById(sheet.talentId);
    if (!talent) {
      throw new Error('Talent not found');
    }
    await context.scopedDb.talentSheetVariants.undiscard(variant.id);
    return { variantId: variant.id };
  });
