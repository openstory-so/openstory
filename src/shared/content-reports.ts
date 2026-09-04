/**
 * Content-report vocabularies. Plain string enums shared by the report form
 * (client), the moderation queue (client) and the `content_reports` table
 * (server) — kept out of `db/schema` so the client never imports a Drizzle
 * table module for a list of strings (#1445).
 */

/**
 * Why something was reported. Ordered loosely by escalation posture, and kept
 * deliberately coarse: a reporter picking from twelve overlapping options
 * mislabels, and the triage queue reads the free-text `details` anyway.
 * `csam` exists as its own category because it alone routes to immediate
 * takedown plus external referral rather than to normal triage.
 */
export const CONTENT_REPORT_REASONS = [
  'csam',
  'portrait_rights',
  'deepfake_impersonation',
  'copyright',
  'sexual_content',
  'violence_or_harm',
  'hate_or_harassment',
  'illegal_or_regulated',
  'misleading_content',
  'other',
] as const;
export type ContentReportReason = (typeof CONTENT_REPORT_REASONS)[number];

/**
 * What the report points at: generated assets, the library entities that own
 * them, accounts, and off-platform URLs. Deliberately NOT the same list as
 * `PROVENANCE_ASSET_KINDS` in `db/schema/compliance.ts` (which is per-artifact
 * provenance, and is not exported) — reports point at what a human can name.
 */
export const CONTENT_REPORT_TARGET_TYPES = [
  'sequence',
  'frame_variant',
  'video_variant',
  'music_variant',
  'sequence_export',
  'generated_asset',
  'talent',
  'sequence_element',
  'style',
  'user',
  'external_url',
] as const;
export type ContentReportTargetType =
  (typeof CONTENT_REPORT_TARGET_TYPES)[number];

export const CONTENT_REPORT_STATUSES = [
  'open',
  'triaged',
  'actioned',
  'dismissed',
] as const;
export type ContentReportStatus = (typeof CONTENT_REPORT_STATUSES)[number];
