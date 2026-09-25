import { describe, expect, it } from 'vitest';
import { supportsDraftMode } from '@/models/models';
import {
  draftBadgeLabel,
  draftExpirySuffix,
  draftTaskUsable,
  theatreDraftLabel,
} from './draft-mode';

const DAY = 24 * 60 * 60 * 1000;

describe('draftTaskUsable', () => {
  const now = Date.UTC(2026, 8, 23);

  it('is usable inside the seven-day window', () => {
    expect(draftTaskUsable(now - 6 * DAY, now)).toBe(true);
    expect(draftTaskUsable(new Date(now - 1000), now)).toBe(true);
  });

  it('expires at seven days', () => {
    expect(draftTaskUsable(now - 7 * DAY, now)).toBe(false);
    expect(draftTaskUsable(new Date(now - 8 * DAY).toISOString(), now)).toBe(
      false
    );
  });
});

describe('supportsDraftMode', () => {
  it('is Seedance 2.5 only — fal has no draft flag and 2.0 has no draft mode', () => {
    expect(supportsDraftMode('seedance_v2_5')).toBe(true);
    expect(supportsDraftMode('seedance_v2')).toBe(false);
    expect(supportsDraftMode('seedance_v2_mini')).toBe(false);
    expect(supportsDraftMode('grok_imagine_video_1_5')).toBe(false);
  });
});

describe('draftExpirySuffix / draftBadgeLabel', () => {
  const now = Date.UTC(2026, 8, 23);

  it('says nothing while more than three days remain', () => {
    expect(draftExpirySuffix(now - 3 * DAY, now)).toBeNull();
    expect(draftBadgeLabel(now, now)).toBe('Draft');
  });

  it('counts down whole days from three, then the last day, then expired', () => {
    expect(draftBadgeLabel(now - 4 * DAY, now)).toBe('Draft · 3 days left');
    expect(draftBadgeLabel(now - 5.5 * DAY, now)).toBe('Draft · 1 day left');
    expect(draftBadgeLabel(now - 6.5 * DAY, now)).toBe('Draft · expires today');
    expect(draftBadgeLabel(now - 7 * DAY, now)).toBe('Draft expired');
  });
});

describe('theatreDraftLabel', () => {
  const now = Date.UTC(2026, 8, 23);
  const draft = (ageDays: number) => ({
    primaryVideo: { draftTaskId: 'cgt-1', createdAt: now - ageDays * DAY },
  });
  const final = { primaryVideo: { draftTaskId: null, createdAt: now } };

  it('is null without a draft and names the mix otherwise', () => {
    expect(theatreDraftLabel([final, { primaryVideo: null }], now)).toBeNull();
    expect(theatreDraftLabel([draft(1), draft(2)], now)).toBe('Draft cut');
    expect(theatreDraftLabel([draft(1), final, final], now)).toBe(
      '1 of 3 shots are drafts'
    );
  });

  it('appends the soonest expiry', () => {
    expect(theatreDraftLabel([draft(1), draft(5)], now)).toBe(
      'Draft cut · 2 days left'
    );
  });
});
