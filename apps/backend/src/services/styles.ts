/**
 * Style service layer
 * Business logic for Style Stack operations
 */

import {
  getStyleById,
  getTeamStyles,
  getPublicStyles,
  createStyle,
  updateStyle,
  deleteStyle,
} from "@/db/queries/styles";
import { requireTeamMember } from "@/lib/auth/rbac";
import type { User } from "@/lib/auth/config";
import type { CreateStyleInput, UpdateStyleInput } from "@/schemas/styles";
import { NotFoundError, AuthorizationError } from "@/plugins/error";

export class StyleService {
  /**
   * Get style by ID
   * Public styles are accessible to all, private styles require team membership
   */
  static async getById(styleId: string, user: User | null) {
    const style = await getStyleById(styleId);

    if (!style) {
      throw new NotFoundError("Style not found");
    }

    // Public styles are accessible to all
    if (style.isPublic) {
      return style;
    }

    // Private styles require team membership
    if (!user) {
      throw new AuthorizationError("Authentication required to access private styles");
    }

    await requireTeamMember(user, style.teamId);

    return style;
  }

  /**
   * List styles for a team (includes public styles)
   * Requires team membership
   */
  static async listByTeam(teamId: string, user: User) {
    // Check team membership
    await requireTeamMember(user, teamId);

    return await getTeamStyles(teamId);
  }

  /**
   * List public styles
   * No authentication required
   */
  static async listPublic() {
    return await getPublicStyles();
  }

  /**
   * Create a new style
   * Requires team membership
   */
  static async create(
    teamId: string,
    input: CreateStyleInput,
    user: User
  ) {
    // Check team membership
    await requireTeamMember(user, teamId);

    // Create style
    const style = await createStyle({
      teamId,
      name: input.name,
      configJson: input.configJson,
      isPublic: input.isPublic || false,
      createdBy: user.id,
    });

    return style;
  }

  /**
   * Update a style
   * Requires team membership
   */
  static async update(
    styleId: string,
    input: UpdateStyleInput,
    user: User
  ) {
    // Get style and check ownership
    const style = await getStyleById(styleId);

    if (!style) {
      throw new NotFoundError("Style not found");
    }

    // Check team membership
    await requireTeamMember(user, style.teamId);

    // Update style
    const updated = await updateStyle(styleId, {
      name: input.name,
      configJson: input.configJson,
      isPublic: input.isPublic,
    });

    return updated;
  }

  /**
   * Delete a style
   * Requires team membership
   */
  static async delete(styleId: string, user: User) {
    // Get style and check ownership
    const style = await getStyleById(styleId);

    if (!style) {
      throw new NotFoundError("Style not found");
    }

    // Check team membership
    await requireTeamMember(user, style.teamId);

    // Delete style
    await deleteStyle(styleId);

    return { success: true };
  }
}

