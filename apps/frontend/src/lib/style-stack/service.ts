import { getCurrentUser } from "#actions/user";
import {
  type ApplyStyleToFramesInput,
  ApplyStyleToFramesSchema,
  type CreateStyleAdaptationInput,
  CreateStyleAdaptationSchema,
  type CreateStyleInput,
  CreateStyleSchema,
  type DuplicateStyleInput,
  DuplicateStyleSchema,
  type ExportStyleInput,
  ExportStyleSchema,
  type GetStyleByIdInput,
  GetStyleByIdSchema,
  type GetTeamStylesInput,
  GetTeamStylesSchema,
  type ImportStyleInput,
  ImportStyleSchema,
  type StyleStackConfig,
  type UpdateStyleInput,
  UpdateStyleSchema,
} from "@/lib/schemas/style-stack";
import { createAdminClient } from "@/lib/supabase/server";
import type { Json, Style, StyleInsert, StyleUpdate } from "@/types/database";

export interface StyleWithAdaptations extends Style {
  style_adaptations?: {
    id: string;
    model_provider: string;
    model_name: string;
    adapted_config: Json;
    created_at: string;
  }[];
}

export interface PaginatedStyles {
  data: Style[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export class StyleStackService {
  private adminClient = createAdminClient();

  // Use admin client for most operations, session-aware client for auth-specific needs
  private get supabase() {
    return this.adminClient;
  }

  /**
   * Create a new style for a team
   */
  async createStyle(input: CreateStyleInput, userId?: string): Promise<Style> {
    const validatedInput = CreateStyleSchema.parse(input);

    // Get current user if userId provided
    let teamId: string;
    if (userId) {
      const user = await getCurrentUser();
      if (!user.success || !user.data) {
        throw new Error("Unauthorized: Invalid user session");
      }

      // Get user's default team (for now, using first team they're a member of)
      const { data: teamMember, error: teamError } = await this.supabase
        .from("team_members")
        .select("team_id")
        .eq("user_id", userId)
        .limit(1)
        .single();

      if (teamError || !teamMember) {
        throw new Error("No team found for user");
      }

      teamId = teamMember.team_id;
    } else {
      throw new Error("User ID is required to create a style");
    }

    const styleData: StyleInsert = {
      team_id: teamId,
      name: validatedInput.name,
      description: validatedInput.description || null,
      config: validatedInput.config as Json,
      category: validatedInput.category || null,
      tags: validatedInput.tags,
      is_public: validatedInput.is_public,
      is_template: false, // Only admins can create templates
      preview_url: validatedInput.preview_url || null,
      created_by: userId,
    };

    const { data, error } = await this.adminClient
      .from("styles")
      .insert(styleData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create style: ${error.message}`);
    }

    return data;
  }

  /**
   * Get styles for a team with filtering and pagination
   */
  async getTeamStyles(input: GetTeamStylesInput): Promise<PaginatedStyles> {
    const validatedInput = GetTeamStylesSchema.parse(input);

    let query = this.supabase
      .from("styles")
      .select("*", { count: "exact" })
      .eq("team_id", validatedInput.team_id);

    // Apply filters
    if (validatedInput.category) {
      query = query.eq("category", validatedInput.category);
    }

    if (validatedInput.tags && validatedInput.tags.length > 0) {
      query = query.contains("tags", validatedInput.tags);
    }

    if (validatedInput.is_public !== undefined) {
      query = query.eq("is_public", validatedInput.is_public);
    }

    if (validatedInput.is_template !== undefined) {
      query = query.eq("is_template", validatedInput.is_template);
    }

    if (validatedInput.search) {
      query = query.or(
        `name.ilike.%${validatedInput.search}%,description.ilike.%${validatedInput.search}%`,
      );
    }

    // Apply pagination and ordering
    query = query
      .order("usage_count", { ascending: false })
      .order("created_at", { ascending: false })
      .range(
        validatedInput.offset,
        validatedInput.offset + validatedInput.limit - 1,
      );

    const { data, error, count } = await query;

    if (error) {
      throw new Error(`Failed to get team styles: ${error.message}`);
    }

    const total = count || 0;
    const page = Math.floor(validatedInput.offset / validatedInput.limit) + 1;
    const hasMore = validatedInput.offset + validatedInput.limit < total;

    return {
      data: data || [],
      total,
      page,
      limit: validatedInput.limit,
      hasMore,
    };
  }

  /**
   * Get a style by ID with optional adaptations
   */
  async getStyleById(
    input: GetStyleByIdInput,
  ): Promise<StyleWithAdaptations | null> {
    const validatedInput = GetStyleByIdSchema.parse(input);

    const query = this.supabase
      .from("styles")
      .select("*")
      .eq("id", validatedInput.id)
      .single();

    const { data: style, error } = await query;

    if (error && error.code !== "PGRST116") {
      throw new Error(`Failed to get style: ${error.message}`);
    }

    if (!style) {
      return null;
    }

    // Get adaptations if requested
    let adaptations: StyleWithAdaptations["style_adaptations"];
    if (validatedInput.include_adaptations) {
      const { data: adaptationsData, error: adaptationsError } =
        await this.supabase
          .from("style_adaptations")
          .select("id, model_provider, model_name, adapted_config, created_at")
          .eq("style_id", validatedInput.id);

      if (adaptationsError) {
        throw new Error(
          `Failed to get style adaptations: ${adaptationsError.message}`,
        );
      }

      adaptations = adaptationsData;
    }

    return {
      ...style,
      ...(adaptations && { style_adaptations: adaptations }),
    };
  }

  /**
   * Update an existing style
   */
  async updateStyle(input: UpdateStyleInput, userId: string): Promise<Style> {
    const validatedInput = UpdateStyleSchema.parse(input);

    // Verify user has permission to update this style
    const existingStyle = await this.getStyleById({
      id: validatedInput.id,
      include_adaptations: false,
    });
    if (!existingStyle) {
      throw new Error("Style not found");
    }

    // Check if user is member of the team that owns this style
    const { data: teamMember, error: teamError } = await this.supabase
      .from("team_members")
      .select("role")
      .eq("team_id", existingStyle.team_id)
      .eq("user_id", userId)
      .single();

    if (teamError || !teamMember) {
      throw new Error("Unauthorized: Not a member of the owning team");
    }

    const updateData: Partial<StyleUpdate> = {};

    if (validatedInput.name !== undefined)
      updateData.name = validatedInput.name;
    if (validatedInput.description !== undefined)
      updateData.description = validatedInput.description;
    if (validatedInput.config !== undefined)
      updateData.config = validatedInput.config as Json;
    if (validatedInput.category !== undefined)
      updateData.category = validatedInput.category;
    if (validatedInput.tags !== undefined)
      updateData.tags = validatedInput.tags;
    if (validatedInput.is_public !== undefined)
      updateData.is_public = validatedInput.is_public;
    if (validatedInput.preview_url !== undefined)
      updateData.preview_url = validatedInput.preview_url;

    const { data, error } = await this.adminClient
      .from("styles")
      .update(updateData)
      .eq("id", validatedInput.id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update style: ${error.message}`);
    }

    return data;
  }

  /**
   * Delete a style
   */
  async deleteStyle(styleId: string, userId: string): Promise<void> {
    // Verify user has permission to delete this style
    const existingStyle = await this.getStyleById({
      id: styleId,
      include_adaptations: false,
    });
    if (!existingStyle) {
      throw new Error("Style not found");
    }

    // Check if user is member of the team that owns this style
    const { data: teamMember, error: teamError } = await this.supabase
      .from("team_members")
      .select("role")
      .eq("team_id", existingStyle.team_id)
      .eq("user_id", userId)
      .single();

    if (teamError || !teamMember) {
      throw new Error("Unauthorized: Not a member of the owning team");
    }

    // Don't allow deletion of templates
    if (existingStyle.is_template) {
      throw new Error("Cannot delete template styles");
    }

    const { error } = await this.adminClient
      .from("styles")
      .delete()
      .eq("id", styleId);

    if (error) {
      throw new Error(`Failed to delete style: ${error.message}`);
    }
  }

  /**
   * Duplicate an existing style
   */
  async duplicateStyle(
    input: DuplicateStyleInput,
    userId: string,
  ): Promise<Style> {
    const validatedInput = DuplicateStyleSchema.parse(input);

    // Get the original style
    const originalStyle = await this.getStyleById({
      id: validatedInput.id,
      include_adaptations: true,
    });

    if (!originalStyle) {
      throw new Error("Original style not found");
    }

    // Check if style is public or user has access
    let canDuplicate = originalStyle.is_public;

    if (!canDuplicate) {
      const { data: teamMember, error: teamError } = await this.supabase
        .from("team_members")
        .select("role")
        .eq("team_id", originalStyle.team_id)
        .eq("user_id", userId)
        .single();

      canDuplicate = !teamError && !!teamMember;
    }

    if (!canDuplicate) {
      throw new Error("Unauthorized: Cannot duplicate private style");
    }

    // Get user's team
    const { data: userTeamMember, error: userTeamError } = await this.supabase
      .from("team_members")
      .select("team_id")
      .eq("user_id", userId)
      .limit(1)
      .single();

    if (userTeamError || !userTeamMember) {
      throw new Error("No team found for user");
    }

    // Create duplicate
    const duplicateData: StyleInsert = {
      team_id: userTeamMember.team_id,
      name: validatedInput.name,
      description: validatedInput.description || originalStyle.description,
      config: originalStyle.config,
      category: originalStyle.category,
      tags: originalStyle.tags || [],
      is_public: false, // Duplicates are private by default
      is_template: false,
      parent_id: originalStyle.id,
      preview_url: originalStyle.preview_url,
      created_by: userId,
    };

    const { data, error } = await this.adminClient
      .from("styles")
      .insert(duplicateData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to duplicate style: ${error.message}`);
    }

    // Copy adaptations if they exist
    if (
      originalStyle.style_adaptations &&
      originalStyle.style_adaptations.length > 0
    ) {
      const adaptations = originalStyle.style_adaptations.map((adaptation) => ({
        style_id: data.id,
        model_provider: adaptation.model_provider,
        model_name: adaptation.model_name,
        adapted_config: adaptation.adapted_config,
      }));

      const { error: adaptationsError } = await this.adminClient
        .from("style_adaptations")
        .insert(adaptations);

      if (adaptationsError) {
        console.warn(`Failed to copy adaptations: ${adaptationsError.message}`);
      }
    }

    return data;
  }

  /**
   * Increment usage count when style is applied
   */
  async incrementUsageCount(styleId: string): Promise<void> {
    const { error } = await this.adminClient.rpc("increment_style_usage", {
      style_uuid: styleId,
    });

    if (error) {
      // Don't throw error for usage count failures, just log
      console.warn(
        `Failed to increment usage count for style ${styleId}: ${error.message}`,
      );
    }
  }

  /**
   * Create a style adaptation for a specific model
   */
  async createStyleAdaptation(
    input: CreateStyleAdaptationInput,
  ): Promise<void> {
    const validatedInput = CreateStyleAdaptationSchema.parse(input);

    // Verify style exists
    const style = await this.getStyleById({
      id: validatedInput.style_id,
      include_adaptations: false,
    });
    if (!style) {
      throw new Error("Style not found");
    }

    const { error } = await this.adminClient.from("style_adaptations").insert({
      style_id: validatedInput.style_id,
      model_provider: validatedInput.model_provider,
      model_name: validatedInput.model_name,
      adapted_config: validatedInput.adapted_config as Json,
    });

    if (error) {
      throw new Error(`Failed to create style adaptation: ${error.message}`);
    }
  }

  /**
   * Apply style to frames
   */
  async applyStyleToFrames(
    input: ApplyStyleToFramesInput,
    userId: string,
  ): Promise<void> {
    const validatedInput = ApplyStyleToFramesSchema.parse(input);

    // Verify style exists and user has access
    const style = await this.getStyleById({
      id: validatedInput.style_id,
      include_adaptations: true,
    });

    if (!style) {
      throw new Error("Style not found");
    }

    // Check if style is public or user has access
    let hasAccess = style.is_public;

    if (!hasAccess) {
      const { data: teamMember, error: teamError } = await this.supabase
        .from("team_members")
        .select("role")
        .eq("team_id", style.team_id)
        .eq("user_id", userId)
        .single();

      hasAccess = !teamError && !!teamMember;
    }

    if (!hasAccess) {
      throw new Error("Unauthorized: Cannot apply private style");
    }

    // Verify user has access to all frames
    const { data: frames, error: framesError } = await this.supabase
      .from("frames")
      .select("id, sequence_id")
      .in("id", validatedInput.frame_ids);

    if (framesError) {
      throw new Error(`Failed to get frames: ${framesError.message}`);
    }

    if (frames.length !== validatedInput.frame_ids.length) {
      throw new Error("Some frames not found");
    }

    // Check user has access to all sequences containing these frames
    const sequenceIds = [...new Set(frames.map((f) => f.sequence_id))];
    for (const sequenceId of sequenceIds) {
      const { data: sequence, error: seqError } = await this.supabase
        .from("sequences")
        .select("team_id")
        .eq("id", sequenceId)
        .single();

      if (seqError || !sequence) {
        throw new Error("Sequence not found");
      }

      const { data: teamMember, error: teamError } = await this.supabase
        .from("team_members")
        .select("role")
        .eq("team_id", sequence.team_id)
        .eq("user_id", userId)
        .single();

      if (teamError || !teamMember) {
        throw new Error("Unauthorized: No access to sequence");
      }
    }

    // Apply style to frames by updating their metadata
    const styleMetadata = {
      applied_style_id: style.id,
      applied_style_name: style.name,
      applied_style_config: style.config,
      style_applied_at: new Date().toISOString(),
      applied_by: userId,
    };

    // Update each frame's metadata
    for (const frameId of validatedInput.frame_ids) {
      const { data: currentFrame, error: getFrameError } = await this.supabase
        .from("frames")
        .select("metadata")
        .eq("id", frameId)
        .single();

      if (getFrameError) {
        throw new Error(
          `Failed to get frame ${frameId}: ${getFrameError.message}`,
        );
      }

      const currentMetadata =
        (currentFrame.metadata as Record<string, unknown>) || {};

      // Preserve existing metadata based on options
      let newMetadata = { ...currentMetadata };

      if (validatedInput.options?.override_existing) {
        // Replace style-related metadata completely
        newMetadata = {
          ...currentMetadata,
          ...styleMetadata,
        };
      } else {
        // Only add style if no existing style
        if (!currentMetadata.applied_style_id) {
          newMetadata = {
            ...currentMetadata,
            ...styleMetadata,
          };
        }
      }

      // Preserve characters if requested
      if (
        validatedInput.options?.preserve_characters &&
        currentMetadata.characters
      ) {
        newMetadata.characters = currentMetadata.characters;
      }

      const { error: updateError } = await this.adminClient
        .from("frames")
        .update({ metadata: newMetadata as Json })
        .eq("id", frameId);

      if (updateError) {
        throw new Error(
          `Failed to update frame ${frameId}: ${updateError.message}`,
        );
      }
    }

    // Increment usage count
    await this.incrementUsageCount(validatedInput.style_id);
  }

  /**
   * Get default style templates
   */
  async getDefaultTemplates(): Promise<Style[]> {
    const { data, error } = await this.supabase
      .from("styles")
      .select("*")
      .eq("is_template", true)
      .eq("is_public", true)
      .order("usage_count", { ascending: false })
      .order("name", { ascending: true });

    if (error) {
      throw new Error(`Failed to get default templates: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Import a style from external data
   */
  async importStyle(input: ImportStyleInput, userId: string): Promise<Style> {
    const validatedInput = ImportStyleSchema.parse(input);

    // Get user's team
    const { data: userTeamMember, error: userTeamError } = await this.supabase
      .from("team_members")
      .select("team_id")
      .eq("user_id", userId)
      .limit(1)
      .single();

    if (userTeamError || !userTeamMember) {
      throw new Error("No team found for user");
    }

    // Create the imported style
    const styleData: StyleInsert = {
      team_id: userTeamMember.team_id,
      name: validatedInput.name || validatedInput.style_data.name,
      description: `Imported style: ${validatedInput.style_data.name}`,
      config: validatedInput.style_data as Json,
      category: validatedInput.category || null,
      tags: validatedInput.tags,
      is_public: false, // Imported styles are private by default
      is_template: false,
      created_by: userId,
    };

    const { data, error } = await this.adminClient
      .from("styles")
      .insert(styleData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to import style: ${error.message}`);
    }

    return data;
  }

  /**
   * Export a style to external format
   */
  async exportStyle(
    input: ExportStyleInput,
    userId: string,
  ): Promise<{
    style: StyleStackConfig;
    metadata: {
      exported_at: string;
      exported_by: string;
      original_id: string;
      version: string;
    };
    adaptations?: Record<string, Record<string, unknown>>;
  }> {
    const validatedInput = ExportStyleSchema.parse(input);

    // Get style with optional adaptations
    const style = await this.getStyleById({
      id: validatedInput.id,
      include_adaptations: validatedInput.include_adaptations,
    });

    if (!style) {
      throw new Error("Style not found");
    }

    // Check access permissions
    let hasAccess = style.is_public;

    if (!hasAccess) {
      const { data: teamMember, error: teamError } = await this.supabase
        .from("team_members")
        .select("role")
        .eq("team_id", style.team_id)
        .eq("user_id", userId)
        .single();

      hasAccess = !teamError && !!teamMember;
    }

    if (!hasAccess) {
      throw new Error("Unauthorized: Cannot export private style");
    }

    const exportData: {
      style: StyleStackConfig;
      metadata: {
        exported_at: string;
        exported_by: string;
        original_id: string;
        version: string;
      };
      adaptations?: Record<string, Record<string, unknown>>;
    } = {
      style: style.config as StyleStackConfig,
      metadata: {
        exported_at: new Date().toISOString(),
        exported_by: userId,
        original_id: style.id,
        version: style.version?.toString() || "1",
      },
    };

    // Include adaptations if requested and available
    if (validatedInput.include_adaptations && style.style_adaptations) {
      exportData.adaptations = {};
      for (const adaptation of style.style_adaptations) {
        const key = `${adaptation.model_provider}:${adaptation.model_name}`;
        exportData.adaptations[key] = adaptation.adapted_config as Record<
          string,
          unknown
        >;
      }
    }

    return exportData;
  }
}
