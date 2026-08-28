/**
 * Drizzle ORM Schema Index
 * Central export point for all database schemas.
 *
 * Relations are defined separately in ./relations.ts using defineRelations()
 * (Drizzle Relations v2 — single consolidated definition, no per-table relations() calls).
 */

import {
  account,
  apikey,
  deviceCode,
  passkey,
  session,
  user,
  verification,
} from './auth';

import { teamInvitations, teamMembers, teams } from './teams';

import { sequences } from './sequences';

import { dbSceneId, scenes } from './scenes';
import { sceneScriptVersions } from './scene-script-versions';

import { shots } from './shots';

import { shotVariants } from './shot-variants';

// SSF redesign (#990) — render segments (scene render units) + flat video
// versions (replaces shot_variants video slice).
import { renderSegments } from './render-segments';
import { videoVariants } from './video-variants';

// SSF redesign (#987) — additive image/event surface. Empty until #988+ wire it.
import { frames } from './frames';
import { frameVariants } from './frame-variants';
import { framePromptVersions } from './frame-prompt-versions';
import { sequenceEvents } from './sequence-events';

import { characterSheetVariants } from './character-sheet-variants';

import { locationSheetVariants } from './location-sheet-variants';

import { talentSheetVariants } from './talent-sheet-variants';

import { shotPromptVersions } from './shot-prompt-versions';

import { sequenceMusicPromptVersions } from './sequence-music-prompt-versions';

import { sequenceMusicVariants } from './sequence-music-variants';
import { sequenceExports } from './sequence-exports';

import { characters } from './characters';

// Location Library (team-level templates)
import { locationLibrary } from './location-library';

// Sequence Locations (script-extracted)
import { sequenceLocations } from './sequence-locations';

import { locationSheets } from './location-sheets';

// Sequence Elements (user-uploaded reference images)
import { sequenceElements } from './sequence-elements';

import { talent, talentMedia, talentSheets } from './talent';

import {
  audio,
  StyleConfigSchema,
  StyleSampleVideoSchema,
  styles,
  vfx,
} from './libraries';

import {
  creditBatches,
  creditReservations,
  credits,
  teamBillingSettings,
  transactions,
} from './credits';

import { teamApiKeys } from './team-api-keys';

import { giftTokenRedemptions, giftTokens } from './gift-tokens';

import { appMetadata } from './app-metadata';

// Generated Assets (#458 — direct model access)
import { generatedAssets } from './generated-assets';

// Model Pricing (#1069 — live per-provider pricing snapshot + history)
import {
  modelPricing,
  modelPricingHistory,
  modelUsageObservations,
} from './model-pricing';

// Compliance (#1180 — AIGC traceability, rights attestations, abuse
// reports, enforcement)
import {
  contentProvenance,
  contentReports,
  enforcementActions,
  uploadAttestations,
} from './compliance';

// Better Auth tables
export { account, apikey, deviceCode, passkey, session, user, verification };

export type { User } from './auth';

// Teams
export { teamInvitations, teamMembers, teams };

// Sequences
export { sequences };

export type { NewSequence, Sequence } from './sequences';

// Scenes (narrative units; each owns an ordered list of shots)
export { dbSceneId, scenes };

export type { DbSceneId, NewScene, SceneRow } from './scenes';

// Scene script versions (per-scene script history; #1030)
export { sceneScriptVersions };

export type {
  SceneScriptVersion,
  SceneScriptSource,
} from './scene-script-versions';

// Shots
export { shots };

export type { NewShot, Shot } from './shots';

// Shot Variants
export { shotVariants };

export type { ShotVariant, NewShotVariant } from './shot-variants';

// Render Segments (#990 — scene render units; a scene is tiled into ≤cap
// contiguous-shot segments, membership via shots.renderSegmentId).
export { renderSegments };

/** @public consumed from #990+ */
export type { RenderSegment, NewRenderSegment } from './render-segments';

// Video Variants (#990 — flat video render versions; replaces the shot_variants
// video slice). Keyed by (renderSegmentId, model); manifest snapshots the
// referenced prompt/frame versions.
export { videoVariants };

/** @public consumed from #990+ */
export type {
  VideoVariant,
  NewVideoVariant,
  VideoManifest,
  VideoManifestEntry,
} from './video-variants';

/**
 * SSF redesign (#987) — the still-image + activity-log surface, added ahead of
 * its consumers (#988 scoped-db layer onward). The tables ship empty; the app
 * still reads/writes the `shots` image columns until later phases repoint it.
 * Each table must stay individually exported (drizzle-kit only diffs top-level
 * exports — see the creditBatches note below).
 *
 * @public consumed from #988+, not yet in the app import graph
 */
export { frames, frameVariants, framePromptVersions, sequenceEvents };

/** @public used by #988+ (frames = the IMAGE unit; still keyframes per shot) */
export { FRAME_ROLES } from './frames';

/** @public used by #988+ */
export type { Frame, NewFrame, FrameRole } from './frames';

/** @public used by #988+ (flat still-image versions; variant = model|framing) */
export { FRAME_VARIANT_KINDS } from './frame-variants';

/** @public used by #988+ */
export type {
  FrameVariant,
  NewFrameVariant,
  FrameVariantKind,
} from './frame-variants';

/** @public used by #988+ (visual/image prompt version history) */
export type {
  FramePromptVersion,
  PromptVersionSource,
  PromptVersionStatus,
} from './frame-prompt-versions';

/** @public used by #988+ (append-only cross-sequence activity log) */
export { SEQUENCE_EVENT_TARGET_TYPES } from './sequence-events';

/** @public used by #988+ */
export type {
  SequenceEvent,
  NewSequenceEvent,
  SequenceEventTargetType,
  SequenceEventData,
} from './sequence-events';

// Sheet Variants (Stage 2: divergent character/location/talent sheet outputs)
export { characterSheetVariants };

export type {
  CharacterSheetVariant,
  NewCharacterSheetVariant,
} from './character-sheet-variants';

export { locationSheetVariants };

export type {
  LocationSheetVariant,
  LocationSheetVariantParentType,
  NewLocationSheetVariant,
} from './location-sheet-variants';

export { talentSheetVariants };

export type {
  NewTalentSheetVariant,
  TalentSheetVariant,
} from './talent-sheet-variants';

// Shot Prompt Versions (visual/motion prompt history; renamed from
// shot_prompt_variants in #988)
export { shotPromptVersions };

export { SHOT_PROMPT_TYPES } from './shot-prompt-versions';

export type {
  ShotPromptType,
  ShotPromptVersion,
  ShotPromptVersionComponents,
  PromptVariantSource,
} from './shot-prompt-versions';

// Sequence Music Prompt Versions (music prompt history; renamed from
// sequence_music_prompt_variants in #988)
export { sequenceMusicPromptVersions };

export type { SequenceMusicPromptVersion } from './sequence-music-prompt-versions';

// Sequence-level variants (music)
export { sequenceMusicVariants };

export type {
  NewSequenceMusicVariant,
  SequenceMusicVariant,
} from './sequence-music-variants';

// Sequence exports (browser-rendered MP4 snapshots)
export { sequenceExports };

export type { NewSequenceExport, SequenceExport } from './sequence-exports';

// Characters (scripted roles)
export { characters };

export type {
  Character,
  CharacterMinimal,
  CharacterWithTalent,
  NewCharacter,
  SheetStatus,
} from './characters';

// Location Library (team-level templates)
export { locationLibrary };

export type { LibraryLocation, NewLibraryLocation } from './location-library';

// Sequence Locations (extracted from script)
export { sequenceLocations };

export type {
  NewSequenceLocation,
  ReferenceStatus,
  SequenceLocation,
  SequenceLocationMinimal,
} from './sequence-locations';

// Location Sheets (location-specific variations for library locations)
export { locationSheets };

export type { LocationSheet, NewLocationSheet } from './location-sheets';

// Sequence Elements (per-sequence uploaded reference images)
export { sequenceElements };

export type {
  ElementVisionStatus,
  NewSequenceElement,
  SequenceElement,
  SequenceElementMinimal,
} from './sequence-elements';

// Talent Library
export { talent, talentMedia, talentSheets };

export type {
  NewTalent,
  NewTalentMedia,
  NewTalentSheet,
  Talent,
  TalentMediaRecord,
  TalentSheet,
  TalentWithSheets,
} from './talent';

// Library Resources
export { audio, StyleConfigSchema, StyleSampleVideoSchema, styles, vfx };

export type { Audio, NewStyle, Style, StyleConfig, Vfx } from './libraries';

// Credits, Transactions, and Billing
export { creditReservations, credits, transactions };

/**
 * drizzle-kit only diffs TOP-LEVEL exported tables — tables reachable only
 * through the `schema` object below are treated as deleted and produce
 * DROP TABLE migrations (this bit us when the knip sweep removed these two).
 * Keep every table individually exported.
 *
 * @public used by drizzle-kit generate, not the app graph
 */
export { creditBatches, teamBillingSettings };

// Team API Keys
export { teamApiKeys };

export { API_KEY_PROVIDERS } from './team-api-keys';
export type { ApiKeyProvider } from './team-api-keys';

// Gift Tokens
export { giftTokens, giftTokenRedemptions };

// App Metadata (key/value bookkeeping, e.g. system-template seed hash)
export { appMetadata };

// Generated Assets (#458 — direct model access; flat team-scoped runs of
// arbitrary fal endpoints, decoupled from the sequence graph)
export { generatedAssets };

export { GENERATED_ASSET_ACTIVITIES } from './generated-assets';

// Model Pricing (#1069 — live per-provider pricing snapshot + price-change
// history, refreshed daily by the Worker cron; fal rows today)
export { modelPricing, modelPricingHistory, modelUsageObservations };

export type {
  GeneratedAsset,
  NewGeneratedAsset,
  GeneratedAssetActivity,
  GeneratedAssetInput,
  GeneratedAssetOutput,
  GeneratedAssetSource,
  JsonValue,
} from './generated-assets';

/**
 * Compliance (#1180). Each table stays individually exported — drizzle-kit only
 * diffs top-level exports, and a table reachable only through `schema` below is
 * treated as deleted, which makes the next `db:generate` emit DROP TABLE for it
 * (see the creditBatches note above). Consumers import these from
 * `@/lib/db/schema/compliance` directly, so nothing in the app graph reads them
 * from here.
 *
 * @public used by drizzle-kit generate, not the app graph
 */
export {
  contentProvenance,
  contentReports,
  enforcementActions,
  uploadAttestations,
};

/**
 * Complete schema object for Drizzle client initialization (tables only).
 * Relations are defined separately in ./relations.ts using defineRelations().
 */
export const schema = {
  // Better Auth
  user,
  session,
  account,
  verification,
  passkey,
  apikey,
  deviceCode,

  // Teams
  teams,
  teamMembers,
  teamInvitations,

  // Sequences
  sequences,
  scenes,
  sceneScriptVersions,
  shots,
  shotVariants,
  // SSF redesign (#990) — render segments + flat video render versions
  renderSegments,
  videoVariants,
  // SSF redesign (#987) — additive image/event surface
  frames,
  frameVariants,
  framePromptVersions,
  sequenceEvents,
  characterSheetVariants,
  locationSheetVariants,
  talentSheetVariants,
  shotPromptVersions,
  sequenceMusicPromptVersions,
  sequenceMusicVariants,
  sequenceExports,

  // Characters (scripted roles extracted from script)
  characters,

  // Location Library (team-level templates)
  locationLibrary,

  // Sequence Locations (extracted from script)
  sequenceLocations,

  // Location Sheets (location-specific variations for library locations)
  locationSheets,

  // Sequence Elements (user-uploaded reference images)
  sequenceElements,

  // Talent Library
  talent,
  talentSheets,
  talentMedia,

  // Libraries
  styles,
  vfx,
  audio,

  // Credits & Billing
  credits,
  creditBatches,
  creditReservations,
  transactions,
  teamBillingSettings,

  // Team API Keys
  teamApiKeys,

  // Gift Tokens
  giftTokens,
  giftTokenRedemptions,

  // App Metadata
  appMetadata,

  // Generated Assets (#458 — direct model access)
  generatedAssets,

  // Model Pricing (#1069)
  modelPricing,
  modelPricingHistory,
  modelUsageObservations,

  // Compliance (#1180)
  contentProvenance,
  uploadAttestations,
  contentReports,
  enforcementActions,
};
