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

  // ---- Teams ----
  teams: {
    members: r.many.teamMembers(),
    invitations: r.many.teamInvitations(),
  },
  teamMembers: {
    team: r.one.teams({ from: r.teamMembers.teamId, to: r.teams.id }),
    user: r.one.user({ from: r.teamMembers.userId, to: r.user.id }),
  },
  teamInvitations: {
    team: r.one.teams({ from: r.teamInvitations.teamId, to: r.teams.id }),
    user: r.one.user({ from: r.teamInvitations.invitedBy, to: r.user.id }),
  },

  // ---- Sequences ----
  sequences: {
    team: r.one.teams({ from: r.sequences.teamId, to: r.teams.id }),
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
    characters: r.many.characters(),
    locations: r.many.sequenceLocations(),
    elements: r.many.sequenceElements(),
    musicPromptVariants: r.many.sequenceMusicPromptVersions(),
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
    sequence: r.one.sequences({
      from: r.characters.sequenceId,
      to: r.sequences.id,
    }),
    talent: r.one.talent({
      from: r.characters.talentId,
      to: r.talent.id,
    }),
    sheetVariants: r.many.characterSheetVariants(),
  },

  // ---- Character Sheet Variants ----
  characterSheetVariants: {
    character: r.one.characters({
      from: r.characterSheetVariants.characterId,
      to: r.characters.id,
    }),
  },

  // ---- Location Library ----
  locationLibrary: {
    team: r.one.teams({
      from: r.locationLibrary.teamId,
      to: r.teams.id,
    }),
    createdByUser: r.one.user({
      from: r.locationLibrary.createdBy,
      to: r.user.id,
    }),
  },

  // ---- Sequence Locations ----
  sequenceLocations: {
    sequence: r.one.sequences({
      from: r.sequenceLocations.sequenceId,
      to: r.sequences.id,
    }),
    libraryLocation: r.one.locationLibrary({
      from: r.sequenceLocations.libraryLocationId,
      to: r.locationLibrary.id,
    }),
  },

  // ---- Location Sheets ----
  locationSheets: {
    location: r.one.locationLibrary({
      from: r.locationSheets.locationId,
      to: r.locationLibrary.id,
    }),
  },

  // ---- Sequence Elements ----
  sequenceElements: {
    sequence: r.one.sequences({
      from: r.sequenceElements.sequenceId,
      to: r.sequences.id,
    }),
  },

  // ---- Talent ----
  talent: {
    team: r.one.teams({ from: r.talent.teamId, to: r.teams.id }),
    createdByUser: r.one.user({
      from: r.talent.createdBy,
      to: r.user.id,
    }),
    sheets: r.many.talentSheets(),
    media: r.many.talentMedia(),
  },
  talentSheets: {
    talent: r.one.talent({
      from: r.talentSheets.talentId,
      to: r.talent.id,
    }),
    variants: r.many.talentSheetVariants(),
  },
  talentSheetVariants: {
    talentSheet: r.one.talentSheets({
      from: r.talentSheetVariants.talentSheetId,
      to: r.talentSheets.id,
    }),
  },
  talentMedia: {
    talent: r.one.talent({
      from: r.talentMedia.talentId,
      to: r.talent.id,
    }),
  },

  // ---- Libraries ----
  styles: {
    team: r.one.teams({ from: r.styles.teamId, to: r.teams.id }),
    user: r.one.user({ from: r.styles.createdBy, to: r.user.id }),
  },
  vfx: {
    team: r.one.teams({ from: r.vfx.teamId, to: r.teams.id }),
    user: r.one.user({ from: r.vfx.createdBy, to: r.user.id }),
  },
  audio: {
    team: r.one.teams({ from: r.audio.teamId, to: r.teams.id }),
    user: r.one.user({ from: r.audio.createdBy, to: r.user.id }),
  },

  // ---- Credits & Billing ----
  credits: {
    team: r.one.teams({ from: r.credits.teamId, to: r.teams.id }),
  },
  transactions: {
    team: r.one.teams({ from: r.transactions.teamId, to: r.teams.id }),
    user: r.one.user({ from: r.transactions.userId, to: r.user.id }),
  },
  teamBillingSettings: {
    team: r.one.teams({
      from: r.teamBillingSettings.teamId,
      to: r.teams.id,
    }),
  },
  creditBatches: {
    team: r.one.teams({
      from: r.creditBatches.teamId,
      to: r.teams.id,
    }),
    transaction: r.one.transactions({
      from: r.creditBatches.transactionId,
      to: r.transactions.id,
    }),
  },
  creditReservations: {
    team: r.one.teams({
      from: r.creditReservations.teamId,
      to: r.teams.id,
    }),
    user: r.one.user({
      from: r.creditReservations.userId,
      to: r.user.id,
    }),
  },

  // ---- Team API Keys ----
  teamApiKeys: {
    team: r.one.teams({ from: r.teamApiKeys.teamId, to: r.teams.id }),
    addedByUser: r.one.user({
      from: r.teamApiKeys.addedBy,
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
    team: r.one.teams({
      from: r.giftTokenRedemptions.teamId,
      to: r.teams.id,
    }),
    user: r.one.user({
      from: r.giftTokenRedemptions.userId,
      to: r.user.id,
      alias: 'giftTokenRedemptions_user',
    }),
  },
}));
