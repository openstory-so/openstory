/**
 * Drizzle Relations v2
 * Unified relation definitions using defineRelations()
 */

import { defineRelations } from 'drizzle-orm';
import { schema } from './index';

export const relations = defineRelations(schema, (r) => ({
  // ---- Auth ----
  user: {
    sessions: r.many.session(),
    accounts: r.many.account(),
    passkeys: r.many.passkey(),
  },
  session: {
    user: r.one.user({ from: r.session.userId, to: r.user.id }),
  },
  account: {
    user: r.one.user({ from: r.account.userId, to: r.user.id }),
  },
  passkey: {
    user: r.one.user({ from: r.passkey.userId, to: r.user.id }),
  },

  // ---- Sequences ----
  sequences: {
    organization: r.one.organization({
      from: r.sequences.organizationId,
      to: r.organization.id,
    }),
    user_createdBy: r.one.user({
      from: r.sequences.createdBy,
      to: r.user.id,
      alias: 'sequences_createdBy_users_id',
    }),
    user_updatedBy: r.one.user({
      from: r.sequences.updatedBy,
      to: r.user.id,
      alias: 'sequences_updatedBy_users_id',
    }),
    style: r.one.styles({ from: r.sequences.styleId, to: r.styles.id }),
    scenes: r.many.scenes(),
    shots: r.many.shots(),
    frames: r.many.frames(),
    renderSegments: r.many.renderSegments(),
    videoVariants: r.many.videoVariants(),
    events: r.many.sequenceEvents(),
    cast: r.many.sequenceCast(),
    locationLinks: r.many.sequenceLocationLinks(),
    elements: r.many.sequenceElements(),
    musicPromptVariants: r.many.sequenceMusicPromptVersions(),
    dialogueSpeeches: r.many.dialogueSpeeches(),
  },

  dialogueSpeeches: {
    sequence: r.one.sequences({
      from: r.dialogueSpeeches.sequenceId,
      to: r.sequences.id,
    }),
  },

  // ---- Scenes ----
  scenes: {
    sequence: r.one.sequences({
      from: r.scenes.sequenceId,
      to: r.sequences.id,
    }),
    shots: r.many.shots(),
    renderSegments: r.many.renderSegments(),
    scriptVersions: r.many.sceneScriptVersions(),
  },

  sceneScriptVersions: {
    scene: r.one.scenes({
      from: r.sceneScriptVersions.sceneId,
      to: r.scenes.id,
    }),
  },

  // ---- Render Segments (SSF #990 — scene render units) ----
  renderSegments: {
    scene: r.one.scenes({
      from: r.renderSegments.sceneId,
      to: r.scenes.id,
    }),
    sequence: r.one.sequences({
      from: r.renderSegments.sequenceId,
      to: r.sequences.id,
    }),
    shots: r.many.shots(),
    videoVariants: r.many.videoVariants(),
  },

  // ---- Video Variants (SSF #990 — flat video render versions per segment) ----
  videoVariants: {
    renderSegment: r.one.renderSegments({
      from: r.videoVariants.renderSegmentId,
      to: r.renderSegments.id,
    }),
    sequence: r.one.sequences({
      from: r.videoVariants.sequenceId,
      to: r.sequences.id,
    }),
  },

  // ---- Shots ----
  shots: {
    sequence: r.one.sequences({
      from: r.shots.sequenceId,
      to: r.sequences.id,
    }),
    scene: r.one.scenes({
      from: r.shots.sceneId,
      to: r.scenes.id,
    }),
    renderSegment: r.one.renderSegments({
      from: r.shots.renderSegmentId,
      to: r.renderSegments.id,
    }),
    frames: r.many.frames(),
    variants: r.many.shotVariants(),
    promptVariants: r.many.shotPromptVersions(),
    dialogueVersions: r.many.shotDialogueVersions(),
    dialogueSections: r.many.shotDialogueSections(),
    dialogueClaims: r.many.shotDialogueClaims(),
  },

  shotDialogueVersions: {
    shot: r.one.shots({
      from: r.shotDialogueVersions.shotId,
      to: r.shots.id,
    }),
  },

  shotDialogueSections: {
    shot: r.one.shots({
      from: r.shotDialogueSections.shotId,
      to: r.shots.id,
    }),
  },

  shotDialogueClaims: {
    shot: r.one.shots({
      from: r.shotDialogueClaims.shotId,
      to: r.shots.id,
    }),
  },

  // ---- Shot Variants ----
  shotVariants: {
    shot: r.one.shots({
      from: r.shotVariants.shotId,
      to: r.shots.id,
    }),
    sequence: r.one.sequences({
      from: r.shotVariants.sequenceId,
      to: r.sequences.id,
    }),
  },

  // ---- Frames (SSF #987 — IMAGE unit; still keyframes within a shot) ----
  frames: {
    shot: r.one.shots({
      from: r.frames.shotId,
      to: r.shots.id,
    }),
    sequence: r.one.sequences({
      from: r.frames.sequenceId,
      to: r.sequences.id,
    }),
    variants: r.many.frameVariants(),
    promptVersions: r.many.framePromptVersions(),
  },

  // ---- Frame Variants (SSF #987 — flat still-image versions) ----
  frameVariants: {
    frame: r.one.frames({
      from: r.frameVariants.frameId,
      to: r.frames.id,
    }),
    sequence: r.one.sequences({
      from: r.frameVariants.sequenceId,
      to: r.sequences.id,
    }),
  },

  // ---- Frame Prompt Versions (SSF #987 — visual prompt history) ----
  framePromptVersions: {
    frame: r.one.frames({
      from: r.framePromptVersions.frameId,
      to: r.frames.id,
    }),
    createdByUser: r.one.user({
      from: r.framePromptVersions.createdBy,
      to: r.user.id,
    }),
  },

  // ---- Sequence Events (SSF #987 — append-only activity log) ----
  sequenceEvents: {
    sequence: r.one.sequences({
      from: r.sequenceEvents.sequenceId,
      to: r.sequences.id,
    }),
    actor: r.one.user({
      from: r.sequenceEvents.actorId,
      to: r.user.id,
    }),
  },

  // ---- Shot Prompt Versions ----
  shotPromptVersions: {
    shot: r.one.shots({
      from: r.shotPromptVersions.shotId,
      to: r.shots.id,
    }),
    createdByUser: r.one.user({
      from: r.shotPromptVersions.createdBy,
      to: r.user.id,
    }),
  },

  // ---- Sequence Music Prompt Versions ----
  sequenceMusicPromptVersions: {
    sequence: r.one.sequences({
      from: r.sequenceMusicPromptVersions.sequenceId,
      to: r.sequences.id,
    }),
    createdByUser: r.one.user({
      from: r.sequenceMusicPromptVersions.createdBy,
      to: r.user.id,
    }),
  },

  // ---- Characters ----
  characters: {
    voiceVersions: r.many.characterVoiceVersions(),
    sheetVariants: r.many.characterSheetVariants(),
    looks: r.many.characterLooks(),
    cast: r.many.sequenceCast(),
  },

  // ---- Sequence cast (#2017) ----
  sequenceCast: {
    sequence: r.one.sequences({
      from: r.sequenceCast.sequenceId,
      to: r.sequences.id,
    }),
    character: r.one.characters({
      from: r.sequenceCast.characterId,
      to: r.characters.id,
    }),
  },

  characterLooks: {
    character: r.one.characters({
      from: r.characterLooks.characterId,
      to: r.characters.id,
    }),
    versions: r.many.characterLookVersions(),
  },

  characterLookVersions: {
    look: r.one.characterLooks({
      from: r.characterLookVersions.lookId,
      to: r.characterLooks.id,
    }),
  },

  characterVoiceVersions: {
    character: r.one.characters({
      from: r.characterVoiceVersions.characterId,
      to: r.characters.id,
    }),
    createdByUser: r.one.user({
      from: r.characterVoiceVersions.createdBy,
      to: r.user.id,
    }),
  },

  // ---- Character Sheet Variants ----
  characterSheetVariants: {
    character: r.one.characters({
      from: r.characterSheetVariants.characterId,
      to: r.characters.id,
    }),
  },

  // ---- Locations ----
  locations: {
    organization: r.one.organization({
      from: r.locations.organizationId,
      to: r.organization.id,
    }),
  },

  sequenceLocationLinks: {
    sequence: r.one.sequences({
      from: r.sequenceLocationLinks.sequenceId,
      to: r.sequences.id,
    }),
    location: r.one.locations({
      from: r.sequenceLocationLinks.locationId,
      to: r.locations.id,
    }),
  },

  locationReferencePhotos: {
    location: r.one.locations({
      from: r.locationReferencePhotos.locationId,
      to: r.locations.id,
    }),
  },

  // ---- Sequence Elements ----
  sequenceElements: {
    sequence: r.one.sequences({
      from: r.sequenceElements.sequenceId,
      to: r.sequences.id,
    }),
  },

  // ---- Libraries ----
  styles: {
    organization: r.one.organization({
      from: r.styles.organizationId,
      to: r.organization.id,
    }),
    user: r.one.user({ from: r.styles.createdBy, to: r.user.id }),
  },
  vfx: {
    organization: r.one.organization({
      from: r.vfx.organizationId,
      to: r.organization.id,
    }),
    user: r.one.user({ from: r.vfx.createdBy, to: r.user.id }),
  },
  audio: {
    organization: r.one.organization({
      from: r.audio.organizationId,
      to: r.organization.id,
    }),
    user: r.one.user({ from: r.audio.createdBy, to: r.user.id }),
  },

  // ---- Credits & Billing ----
  credits: {
    organization: r.one.organization({
      from: r.credits.organizationId,
      to: r.organization.id,
    }),
  },
  transactions: {
    organization: r.one.organization({
      from: r.transactions.organizationId,
      to: r.organization.id,
    }),
    user: r.one.user({ from: r.transactions.userId, to: r.user.id }),
  },
  organizationBillingSettings: {
    organization: r.one.organization({
      from: r.organizationBillingSettings.organizationId,
      to: r.organization.id,
    }),
  },
  creditBatches: {
    organization: r.one.organization({
      from: r.creditBatches.organizationId,
      to: r.organization.id,
    }),
    transaction: r.one.transactions({
      from: r.creditBatches.transactionId,
      to: r.transactions.id,
    }),
  },
  creditReservations: {
    organization: r.one.organization({
      from: r.creditReservations.organizationId,
      to: r.organization.id,
    }),
    user: r.one.user({
      from: r.creditReservations.userId,
      to: r.user.id,
    }),
  },

  // ---- Organization API Keys ----
  organizationApiKeys: {
    organization: r.one.organization({
      from: r.organizationApiKeys.organizationId,
      to: r.organization.id,
    }),
    addedByUser: r.one.user({
      from: r.organizationApiKeys.addedBy,
      to: r.user.id,
    }),
  },

  // ---- Gift Tokens ----
  giftTokens: {
    createdBy: r.one.user({
      from: r.giftTokens.createdByUserId,
      to: r.user.id,
      alias: 'giftTokens_createdBy',
    }),
    redemptions: r.many.giftTokenRedemptions(),
  },
  giftTokenRedemptions: {
    giftToken: r.one.giftTokens({
      from: r.giftTokenRedemptions.giftTokenId,
      to: r.giftTokens.id,
    }),
    organization: r.one.organization({
      from: r.giftTokenRedemptions.organizationId,
      to: r.organization.id,
    }),
    user: r.one.user({
      from: r.giftTokenRedemptions.userId,
      to: r.user.id,
      alias: 'giftTokenRedemptions_user',
    }),
  },
}));
