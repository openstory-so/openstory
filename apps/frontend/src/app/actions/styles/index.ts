"use server";

import { z } from "zod";
import { getCurrentUser } from "@/app/actions/user";
import { createSessionAwareClient } from "@/lib/supabase/server";
import type { Json, Style, StyleInsert } from "@/types/database";

// Schema definitions
const createStyleSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  config: z.any().default({}), // Use z.any() for Json type compatibility
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  is_public: z.boolean().default(false),
  preview_url: z.string().optional().nullable(),
});

const updateStyleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  config: z.any().optional(), // Use z.any() for Json type compatibility
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  is_public: z.boolean().optional(),
  preview_url: z.string().optional().nullable(),
});

export type CreateStyleInput = z.infer<typeof createStyleSchema>;
export type UpdateStyleInput = z.infer<typeof updateStyleSchema>;

/**
 * Helper function to get the current user's team ID
 */
async function getCurrentUserTeamId(): Promise<string | null> {
  const userResult = await getCurrentUser();
  if (!userResult.success || !userResult.data) {
    return null;
  }

  const supabase = await createSessionAwareClient();
  const { data: teamMembership } = await supabase
    .from("team_members")
    .select("team_id")
    .eq("user_id", userResult.data.user.id)
    .eq("role", "owner")
    .single();

  return teamMembership?.team_id || null;
}

/**
 * Create a new style for the current user's team
 */
export async function createStyle(
  input: CreateStyleInput,
): Promise<{ success: boolean; style?: Style; error?: string }> {
  try {
    const supabase = await createSessionAwareClient();

    // Get the current user's team
    const teamId = await getCurrentUserTeamId();
    if (!teamId) {
      return { success: false, error: "No team found for current user" };
    }

    const validated = createStyleSchema.parse(input);

    const styleData: StyleInsert = {
      team_id: teamId,
      name: validated.name,
      description: validated.description,
      config: validated.config as Json, // Cast to Json type
      category: validated.category,
      tags: validated.tags || [],
      is_public: validated.is_public,
      preview_url: validated.preview_url,
    };

    const { data, error } = await supabase
      .from("styles")
      .insert(styleData)
      .select()
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, style: data };
  } catch (error) {
    console.error("Error creating style:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create style",
    };
  }
}

/**
 * Update an existing style
 */
export async function updateStyle(
  id: string,
  input: UpdateStyleInput,
): Promise<{ success: boolean; style?: Style; error?: string }> {
  try {
    const supabase = await createSessionAwareClient();

    // Get the current user's team to verify ownership
    const teamId = await getCurrentUserTeamId();
    if (!teamId) {
      return { success: false, error: "No team found for current user" };
    }

    const validated = updateStyleSchema.parse(input);

    const updateData: Record<
      string,
      Json | string | string[] | boolean | null | undefined
    > = {
      updated_at: new Date().toISOString(),
    };

    // Only include fields that were provided
    if (validated.name !== undefined) updateData.name = validated.name;
    if (validated.description !== undefined)
      updateData.description = validated.description;
    if (validated.config !== undefined)
      updateData.config = validated.config as Json;
    if (validated.category !== undefined)
      updateData.category = validated.category;
    if (validated.tags !== undefined) updateData.tags = validated.tags;
    if (validated.is_public !== undefined)
      updateData.is_public = validated.is_public;
    if (validated.preview_url !== undefined)
      updateData.preview_url = validated.preview_url;

    const { data, error } = await supabase
      .from("styles")
      .update(updateData)
      .eq("id", id)
      .eq("team_id", teamId) // Ensure user can only update their team's styles
      .select()
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, style: data };
  } catch (error) {
    console.error("Error updating style:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to update style",
    };
  }
}

/**
 * Delete a style (admin/owner only)
 */
export async function deleteStyle(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createSessionAwareClient();

    // Get current user
    const user = await getCurrentUser();
    if (!user.success || !user.data) {
      return { success: false, error: "Authentication required" };
    }

    // Get the style to verify team ownership
    const { data: style, error: fetchError } = await supabase
      .from("styles")
      .select("team_id")
      .eq("id", id)
      .single();

    if (fetchError || !style) {
      return { success: false, error: "Style not found" };
    }

    // Check if user has admin/owner role for this team
    const { data: membership, error: memberError } = await supabase
      .from("team_members")
      .select("role")
      .eq("user_id", user.data.user.id)
      .eq("team_id", style.team_id)
      .single();

    if (memberError || !membership) {
      return { success: false, error: "Not a member of this team" };
    }

    // Only admin or owner can delete
    if (membership.role !== "admin" && membership.role !== "owner") {
      return {
        success: false,
        error: "Permission denied: admin or owner role required",
      };
    }

    const { error } = await supabase
      .from("styles")
      .delete()
      .eq("id", id)
      .eq("team_id", style.team_id);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error("Error deleting style:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to delete style",
    };
  }
}

/**
 * Get a single style by ID
 */
export async function getStyle(
  id: string,
): Promise<{ success: boolean; style?: Style; error?: string }> {
  try {
    const supabase = await createSessionAwareClient();

    const { data, error } = await supabase
      .from("styles")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, style: data };
  } catch (error) {
    console.error("Error getting style:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get style",
    };
  }
}

/**
 * List styles available to the current user
 * Returns the user's team styles and public styles
 */
export async function listStyles(): Promise<{
  success: boolean;
  styles?: Style[];
  error?: string;
}> {
  try {
    const supabase = await createSessionAwareClient();

    // Get the current user's team
    const teamId = await getCurrentUserTeamId();

    if (!teamId) {
      // If no team, just return public styles
      const { data, error } = await supabase
        .from("styles")
        .select("*")
        .eq("is_public", true)
        .order("created_at", { ascending: false });

      if (error) {
        return { success: false, error: error.message };
      }

      return { success: true, styles: data || [] };
    }

    // Get team styles and public styles
    const { data, error } = await supabase
      .from("styles")
      .select("*")
      .or(`team_id.eq.${teamId},is_public.eq.true`)
      .order("created_at", { ascending: false });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, styles: data || [] };
  } catch (error) {
    console.error("Error listing styles:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to list styles",
    };
  }
}

/**
 * Get default/template styles for new teams
 */
export async function getTemplateStyles(): Promise<{
  success: boolean;
  styles?: Style[];
  error?: string;
}> {
  try {
    const supabase = await createSessionAwareClient();

    const { data, error } = await supabase
      .from("styles")
      .select("*")
      .eq("is_template", true)
      .order("name", { ascending: true });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, styles: data || [] };
  } catch (error) {
    console.error("Error getting template styles:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to get template styles",
    };
  }
}
