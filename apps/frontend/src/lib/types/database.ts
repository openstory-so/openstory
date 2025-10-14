import type {
  Database,
  Enums,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
} from "@/lib/supabase/gen.types";

// Re-export the Database and Json types for infrastructure code
// Note: Use specific table types (UserProfile, Team, etc.) instead of raw Database types in application code
export type { Json, Database };

// User profile type (use UserProfileRow for database operations)
// This is kept for backward compatibility but prefer UserProfileRow
export type UserProfile = Tables<"users">;

// Table row types (what you get from SELECT)
export type Team = Tables<"teams">;
export type TeamMember = Tables<"team_members">;
export type TeamInvitation = Tables<"team_invitations">;
export type Sequence = Tables<"sequences">;
export type Frame = Tables<"frames">;
export type Style = Tables<"styles">;
export type Character = Tables<"characters">;
export type Audio = Tables<"audio">;
export type VFX = Tables<"vfx">;
export type Job = Tables<"jobs">;
export type Credit = Tables<"credits">;
export type Transaction = Tables<"transactions">;
export type FalRequest = Tables<"fal_requests">;
export type LetzAIRequest = Tables<"letzai_requests">;

// BetterAuth tables (using standard names)
export type BetterAuthUser = Tables<"user">;
export type BetterAuthSession = Tables<"session">;
export type BetterAuthAccount = Tables<"account">;
export type BetterAuthVerification = Tables<"verification">;

// User profile (separate from BetterAuth user table)
export type UserProfileRow = Tables<"users">;
// Insert types (for creating new records)
export type TeamInsert = TablesInsert<"teams">;
export type TeamMemberInsert = TablesInsert<"team_members">;
export type TeamInvitationInsert = TablesInsert<"team_invitations">;
export type SequenceInsert = TablesInsert<"sequences">;
export type FrameInsert = TablesInsert<"frames">;
export type StyleInsert = TablesInsert<"styles">;
export type CharacterInsert = TablesInsert<"characters">;
export type AudioInsert = TablesInsert<"audio">;
export type VFXInsert = TablesInsert<"vfx">;
export type JobInsert = TablesInsert<"jobs">;
export type CreditInsert = TablesInsert<"credits">;
export type TransactionInsert = TablesInsert<"transactions">;
export type FalRequestInsert = TablesInsert<"fal_requests">;
export type LetzAIRequestInsert = TablesInsert<"letzai_requests">;
// Update types (for updating existing records)
export type TeamUpdate = TablesUpdate<"teams">;
export type TeamMemberUpdate = TablesUpdate<"team_members">;
export type TeamInvitationUpdate = TablesUpdate<"team_invitations">;
export type SequenceUpdate = TablesUpdate<"sequences">;
export type FrameUpdate = TablesUpdate<"frames">;
export type StyleUpdate = TablesUpdate<"styles">;
export type CharacterUpdate = TablesUpdate<"characters">;
export type AudioUpdate = TablesUpdate<"audio">;
export type VFXUpdate = TablesUpdate<"vfx">;
export type JobUpdate = TablesUpdate<"jobs">;
export type CreditUpdate = TablesUpdate<"credits">;
export type TransactionUpdate = TablesUpdate<"transactions">;
export type FalRequestUpdate = TablesUpdate<"fal_requests">;
export type LetzAIRequestUpdate = TablesUpdate<"letzai_requests">;
// Enum types
export type SequenceStatus = Enums<"sequence_status">;
export type TeamMemberRole = Enums<"team_member_role">;
export type InvitationStatus = Enums<"invitation_status">;
export type TransactionType = Enums<"transaction_type">;
export type FalRequestStatus = Enums<"fal_request_status">;
export type LetzAIRequestStatus = Enums<"letzai_request_status">;
