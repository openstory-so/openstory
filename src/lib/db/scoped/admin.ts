/**
 * Scoped Admin Sub-module
 * Admin-only operations: gift token creation, listing, and redemption.
 * Not team-scoped (admin operations span all teams).
 */

import { micros, microsToUsd, usdToMicros } from '@/lib/billing/money';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/shared/id';
import { user } from '@/lib/db/schema/auth';
import { credits, transactions } from '@/lib/db/schema/credits';
import { shots } from '@/lib/db/schema/shots';
import {
  assembleShotViews,
  selectShotViewRows,
  shotHierarchicalOrder,
} from './shot-view-query';
import { giftTokenRedemptions, giftTokens } from '@/lib/db/schema/gift-tokens';
import type { GiftToken } from '@/lib/db/schema/gift-tokens';
import { sequences } from '@/lib/db/schema/sequences';
import type { Sequence } from '@/lib/db/schema';
import type { ShotView } from '@/lib/shots/shot-view';
import { teamMembers, teams } from '@/lib/db/schema/teams';
import { ValidationError } from '@/shared/errors';
import { and, count, desc, eq, exists, like, not, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

// Ambiguity-free alphabet (no 0/O/1/I) -- 32 chars -> 32^6 ~ 1B combinations
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateGiftCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes)
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
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
  teamId: string;
  teamName: string;
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

  // ---- Support: cross-team sequence/shot access ----

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

    // Resolve a person via TEAM MEMBERSHIP, not the sequence creator. Support
    // ("show me this customer's account") means their whole team's work, and
    // `sequences.createdBy` is not a reliable handle for it: it is nullable and
    // `ON DELETE SET NULL`, so a `user`-table rebuild nulls it wholesale (the
    // #612-class incident that stranded 174 prod sequences). Matching any team
    // member keeps lookup working even when the creator column is lost again.
    const memberUser = alias(user, 'member_user');
    const searchClause = trimmed
      ? or(
          like(sql`lower(${sequences.title})`, `%${trimmed}%`),
          exists(
            db
              .select({ one: sql`1` })
              .from(teamMembers)
              .innerJoin(memberUser, eq(memberUser.id, teamMembers.userId))
              .where(
                and(
                  eq(teamMembers.teamId, sequences.teamId),
                  or(
                    like(sql`lower(${memberUser.name})`, `%${trimmed}%`),
                    like(sql`lower(${memberUser.email})`, `%${trimmed}%`)
                  )
                )
              )
          )
        )
      : undefined;

    const rows = await db
      .select({
        sequence: sequences,
        creatorName: user.name,
        creatorEmail: user.email,
      })
      .from(sequences)
      .leftJoin(user, eq(sequences.createdBy, user.id))
      .where(and(not(eq(sequences.status, 'archived')), searchClause))
      .orderBy(desc(sequences.createdAt))
      .limit(limit)
      .offset(offset);

    return rows.map(({ sequence, creatorName, creatorEmail }) => ({
      ...sequence,
      creatorName,
      creatorEmail,
    }));
  }

  async function getShotsForSequence(sequenceId: string): Promise<ShotView[]> {
    const rows = await selectShotViewRows(db)
      .where(eq(shots.sequenceId, sequenceId))
      .orderBy(...shotHierarchicalOrder);
    return assembleShotViews(db, rows);
  }

  // ---- User activity reporting ----

  async function listUserActivity(): Promise<UserActivityRow[]> {
    // Subquery: sequence stats per team (count, failures, avg duration)
    const seqStatsSq = db
      .select({
        teamId: sequences.teamId,
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
      .groupBy(sequences.teamId)
      .as('seq_stats');

    // Subquery: credit spending, purchases, and gifts per team
    const txSumsSq = db
      .select({
        teamId: transactions.teamId,
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
      .groupBy(transactions.teamId)
      .as('tx_sums');

    const rows = await db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
        status: user.status,
        teamId: teams.id,
        teamName: teams.name,
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
      .innerJoin(teamMembers, eq(user.id, teamMembers.userId))
      .innerJoin(teams, eq(teamMembers.teamId, teams.id))
      .leftJoin(seqStatsSq, eq(teams.id, seqStatsSq.teamId))
      .leftJoin(txSumsSq, eq(teams.id, txSumsSq.teamId))
      .leftJoin(credits, eq(teams.id, credits.teamId))
      .orderBy(desc(user.createdAt));

    return rows;
  }

  return {
    createGiftToken,
    listGiftTokens,
    getAllSequences,
    getShotsForSequence,
    listUserActivity,
  };
}
