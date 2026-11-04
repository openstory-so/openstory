/**
 * Scoped Admin Sub-module
 * Admin-only operations: gift token creation, listing, and redemption.
 * Not organization-scoped (admin operations span all organizations).
 */

import { withSequencePosters } from '@/sequences/server/db/sequence-poster';
import { micros, microsToUsd, usdToMicros } from '@/billing/money';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import { user } from '@/platform/server/db/schema/auth';
import { credits, transactions } from '@/platform/server/db/schema/credits';
import { shots } from '@/platform/server/db/schema/shots';
import {
  assembleShotViews,
  selectShotViewRows,
  shotHierarchicalOrder,
} from '@/shots/server/db/shot-view-query';
import {
  giftTokenRedemptions,
  giftTokens,
} from '@/platform/server/db/schema/gift-tokens';
import type { GiftToken } from '@/platform/server/db/schema/gift-tokens';
import { sequences } from '@/platform/server/db/schema/sequences';
import { selectSequencesWithCreatorFrom } from '@/sequences/server/db/sequences';
import {
  generatedAssets,
  type GeneratedAsset,
  type Sequence,
} from '@/platform/server/db/schema';
import type { ShotView } from '@/shots/shot-view';
import { member, organization } from '@/platform/server/db/schema/organization';
import { ValidationError } from '@/platform/errors';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  like,
  lt,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

// Ambiguity-free alphabet (no 0/O/1/I) -- 32 chars -> 32^6 ~ 1B combinations.
// Exactly 32 so a 5-bit mask of each random byte picks uniformly (a modulo
// would be biased for any length that does not divide 256).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_MASK = CODE_ALPHABET.length - 1;
const CODE_LENGTH = 6;

function generateGiftCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes)
    .map((b) => CODE_ALPHABET[b & CODE_MASK])
    .join('');
}

export type GiftTokenStatus = 'available' | 'fully_redeemed' | 'expired';

function getGiftTokenStatus(
  token: GiftToken,
  redemptionCount: number
): GiftTokenStatus {
  if (redemptionCount >= token.maxRedemptions) return 'fully_redeemed';
  if (token.expiresAt && token.expiresAt < new Date()) return 'expired';
  return 'available';
}

export type GiftTokenWithStatus = GiftToken & {
  status: GiftTokenStatus;
  amountUsd: number;
  redemptionCount: number;
};

export type UserActivityRow = {
  userId: string;
  name: string;
  email: string;
  createdAt: Date;
  status: string | null;
  organizationId: string;
  organizationName: string;
  sequenceCount: number;
  failedCount: number;
  avgAnalysisDurationMs: number | null;
  creditsSpentMicros: number;
  creditsPurchasedMicros: number;
  creditsGiftedMicros: number;
  currentBalanceMicros: number;
};

export function createAdminMethods(db: Database) {
  async function createGiftToken(opts: {
    createdByUserId: string;
    amountUsd: number;
    maxRedemptions?: number;
    note?: string;
    expiresAt?: Date;
  }): Promise<GiftToken> {
    if (opts.amountUsd <= 0) {
      throw new ValidationError('Gift token amount must be positive');
    }

    const maxRedemptions = opts.maxRedemptions ?? 1;
    if (maxRedemptions < 1) {
      throw new ValidationError('Max redemptions must be at least 1');
    }

    const code = generateGiftCode();
    const amountMicros = usdToMicros(opts.amountUsd);

    const [token] = await db
      .insert(giftTokens)
      .values({
        id: generateId(),
        code,
        amountMicros,
        maxRedemptions,
        createdByUserId: opts.createdByUserId,
        note: opts.note ?? null,
        expiresAt: opts.expiresAt ?? null,
      })
      .returning();
    if (!token) {
      throw new Error('createGiftToken: insert returned nothing');
    }

    return token;
  }

  async function listGiftTokens(): Promise<GiftTokenWithStatus[]> {
    const redemptionCountSq = db
      .select({
        giftTokenId: giftTokenRedemptions.giftTokenId,
        count: count().as('count'),
      })
      .from(giftTokenRedemptions)
      .groupBy(giftTokenRedemptions.giftTokenId)
      .as('redemption_counts');

    const tokens = await db
      .select({
        token: giftTokens,
        redemptionCount: sql<number>`coalesce(${redemptionCountSq.count}, 0)`,
      })
      .from(giftTokens)
      .leftJoin(
        redemptionCountSq,
        eq(giftTokens.id, redemptionCountSq.giftTokenId)
      )
      .orderBy(desc(giftTokens.createdAt));

    return tokens.map(({ token, redemptionCount }) => ({
      ...token,
      redemptionCount,
      status: getGiftTokenStatus(token, redemptionCount),
      amountUsd: microsToUsd(micros(token.amountMicros)),
    }));
  }

  // ---- Support: cross-organization sequence/shot access ----

  type SequenceWithCreator = Sequence & {
    creatorName: string | null;
    creatorEmail: string | null;
  };

  async function getAllSequences(opts?: {
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<SequenceWithCreator[]> {
    const { limit = 50, offset = 0, search } = opts ?? {};

    const trimmed = search?.trim().toLowerCase();

    // Resolve a person via ORGANIZATION MEMBERSHIP, not the sequence creator. Support
    // ("show me this customer's account") means their whole organization's work, and
    // `sequences.createdBy` is not a reliable handle for it: it is nullable and
    // `ON DELETE SET NULL`, so a `user`-table rebuild nulls it wholesale (the
    // #612-class incident that stranded 174 prod sequences). Matching any organization
    // member keeps lookup working even when the creator column is lost again.
    const memberUser = alias(user, 'member_user');
    const searchClause = trimmed
      ? or(
          like(sql`lower(${sequences.title})`, `%${trimmed}%`),
          exists(
            db
              .select({ one: sql`1` })
              .from(member)
              .innerJoin(memberUser, eq(memberUser.id, member.userId))
              .where(
                and(
                  eq(member.organizationId, sequences.organizationId),
                  or(
                    like(sql`lower(${memberUser.name})`, `%${trimmed}%`),
                    like(sql`lower(${memberUser.email})`, `%${trimmed}%`)
                  )
                )
              )
          )
        )
      : undefined;

    const rows = await selectSequencesWithCreatorFrom(db)
      .where(and(not(eq(sequences.status, 'archived')), searchClause))
      .orderBy(desc(sequences.createdAt))
      .limit(limit)
      .offset(offset);

    return withSequencePosters(
      db,
      rows.map(({ sequence, creatorName, creatorEmail }) => ({
        ...sequence,
        creatorName,
        creatorEmail,
      }))
    );
  }

  async function getShotsForSequence(sequenceId: string): Promise<ShotView[]> {
    const rows = await selectShotViewRows(db)
      .where(eq(shots.sequenceId, sequenceId))
      .orderBy(...shotHierarchicalOrder);
    return assembleShotViews(db, rows);
  }

  // ---- Support: cross-organization studio images/videos (#1568) ----

  type StudioAssetWithCreator = GeneratedAsset & {
    creatorName: string | null;
    creatorEmail: string | null;
  };

  async function getAllStudioAssets(opts?: {
    activity?: GeneratedAsset['activity'];
    search?: string;
    favoritesOnly?: boolean;
    order?: 'newest' | 'oldest';
    limit?: number;
    cursor?: string;
  }): Promise<{
    assets: StudioAssetWithCreator[];
    nextCursor: string | null;
  }> {
    const {
      activity,
      search,
      favoritesOnly,
      order = 'newest',
      limit = 40,
      cursor,
    } = opts ?? {};

    const trimmed = search?.trim().toLowerCase();
    const memberUser = alias(user, 'member_user');
    const searchClause = trimmed
      ? or(
          like(sql`lower(${generatedAssets.input})`, `%${trimmed}%`),
          exists(
            db
              .select({ one: sql`1` })
              .from(member)
              .innerJoin(memberUser, eq(memberUser.id, member.userId))
              .where(
                and(
                  eq(member.organizationId, generatedAssets.organizationId),
                  or(
                    like(sql`lower(${memberUser.name})`, `%${trimmed}%`),
                    like(sql`lower(${memberUser.email})`, `%${trimmed}%`)
                  )
                )
              )
          )
        )
      : undefined;

    const conditions: SQL[] = [eq(generatedAssets.source, 'studio')];
    if (activity) {
      conditions.push(eq(generatedAssets.activity, activity));
    }
    if (favoritesOnly) {
      conditions.push(eq(generatedAssets.isFavorite, true));
    }
    if (cursor) {
      conditions.push(
        order === 'oldest'
          ? gt(generatedAssets.id, cursor)
          : lt(generatedAssets.id, cursor)
      );
    }
    if (searchClause) {
      conditions.push(searchClause);
    }

    const rows = await db
      .select({
        asset: generatedAssets,
        creatorName: user.name,
        creatorEmail: user.email,
      })
      .from(generatedAssets)
      .leftJoin(user, eq(generatedAssets.userId, user.id))
      .where(and(...conditions))
      .orderBy(
        order === 'oldest' ? asc(generatedAssets.id) : desc(generatedAssets.id)
      )
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      assets: page.map(({ asset, creatorName, creatorEmail }) => ({
        ...asset,
        creatorName,
        creatorEmail,
      })),
      nextCursor: rows.length > limit && last ? last.asset.id : null,
    };
  }

  // ---- User activity reporting ----

  async function listUserActivity(): Promise<UserActivityRow[]> {
    // Subquery: sequence stats per organization (count, failures, avg duration)
    const seqStatsSq = db
      .select({
        organizationId: sequences.organizationId,
        count: count().as('seq_count'),
        failedCount:
          sql<number>`sum(case when ${sequences.status} = 'failed' then 1 else 0 end)`.as(
            'failed_count'
          ),
        avgAnalysisDurationMs:
          sql<number>`avg(case when ${sequences.analysisDurationMs} > 0 then ${sequences.analysisDurationMs} else null end)`.as(
            'avg_analysis_duration_ms'
          ),
      })
      .from(sequences)
      .groupBy(sequences.organizationId)
      .as('seq_stats');

    // Subquery: credit spending, purchases, and gifts per organization
    const txSumsSq = db
      .select({
        organizationId: transactions.organizationId,
        spent:
          sql<number>`coalesce(sum(case when ${transactions.type} = 'credit_usage' then abs(${transactions.amount}) else 0 end), 0)`.as(
            'spent'
          ),
        purchased:
          sql<number>`coalesce(sum(case when ${transactions.type} = 'credit_purchase' then ${transactions.amount} else 0 end), 0)`.as(
            'purchased'
          ),
        gifted:
          sql<number>`coalesce(sum(case when ${transactions.type} = 'credit_adjustment' then ${transactions.amount} else 0 end), 0)`.as(
            'gifted'
          ),
      })
      .from(transactions)
      .groupBy(transactions.organizationId)
      .as('tx_sums');

    const rows = await db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
        status: user.status,
        organizationId: organization.id,
        organizationName: organization.name,
        sequenceCount: sql<number>`coalesce(${seqStatsSq.count}, 0)`,
        failedCount: sql<number>`coalesce(${seqStatsSq.failedCount}, 0)`,
        avgAnalysisDurationMs: sql<
          number | null
        >`${seqStatsSq.avgAnalysisDurationMs}`,
        creditsSpentMicros: sql<number>`coalesce(${txSumsSq.spent}, 0)`,
        creditsPurchasedMicros: sql<number>`coalesce(${txSumsSq.purchased}, 0)`,
        creditsGiftedMicros: sql<number>`coalesce(${txSumsSq.gifted}, 0)`,
        currentBalanceMicros: sql<number>`coalesce(${credits.balance}, 0)`,
      })
      .from(user)
      .innerJoin(member, eq(user.id, member.userId))
      .innerJoin(organization, eq(member.organizationId, organization.id))
      .leftJoin(seqStatsSq, eq(organization.id, seqStatsSq.organizationId))
      .leftJoin(txSumsSq, eq(organization.id, txSumsSq.organizationId))
      .leftJoin(credits, eq(organization.id, credits.organizationId))
      .orderBy(desc(user.createdAt));

    return rows;
  }

  return {
    createGiftToken,
    listGiftTokens,
    getAllSequences,
    getShotsForSequence,
    getAllStudioAssets,
    listUserActivity,
  };
}
