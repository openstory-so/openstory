/**
 * Video Storage Service
 * Handles uploading and managing videos in Supabase Storage
 */

import { createAdminClient } from "@/lib/supabase/server";

interface UploadVideoOptions {
  videoUrl: string;
  teamId: string;
  sequenceId: string;
  frameId: string;
}

interface StorageResult {
  success: boolean;
  url?: string;
  path?: string;
  error?: string;
}

/**
 * Upload a video from URL to Supabase Storage
 */
export async function uploadVideoToStorage(
  options: UploadVideoOptions,
): Promise<StorageResult> {
  try {
    const { videoUrl, teamId, sequenceId, frameId } = options;
    const supabase = createAdminClient();

    // Construct storage path
    const storagePath = `teams/${teamId}/sequences/${sequenceId}/frames/${frameId}/motion.mp4`;

    // Download video from URL
    const response = await fetch(videoUrl);

    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.statusText}`);
    }

    const videoBlob = await response.blob();
    const videoBuffer = await videoBlob.arrayBuffer();
    const videoData = new Uint8Array(videoBuffer);

    // Upload to Supabase Storage
    const { error } = await supabase.storage
      .from("videos")
      .upload(storagePath, videoData, {
        contentType: "video/mp4",
        upsert: true, // Overwrite if exists
      });

    if (error) {
      throw new Error(`Storage upload failed: ${error.message}`);
    }

    // Get public URL
    const {
      data: { publicUrl },
    } = supabase.storage.from("videos").getPublicUrl(storagePath);

    return {
      success: true,
      url: publicUrl,
      path: storagePath,
    };
  } catch (error) {
    console.error("[Video Storage] Upload failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to upload video",
    };
  }
}

/**
 * Generate a signed URL for temporary video access
 */
export async function getSignedVideoUrl(
  path: string,
  expiresIn: number = 3600, // 1 hour default
): Promise<StorageResult> {
  try {
    const supabase = createAdminClient();

    const { data, error } = await supabase.storage
      .from("videos")
      .createSignedUrl(path, expiresIn);

    if (error) {
      throw new Error(`Failed to create signed URL: ${error.message}`);
    }

    return {
      success: true,
      url: data.signedUrl,
      path,
    };
  } catch (error) {
    console.error("[Video Storage] Failed to create signed URL:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to create signed URL",
    };
  }
}

/**
 * Delete a video from storage
 */
export async function deleteVideoFromStorage(
  path: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createAdminClient();

    const { error } = await supabase.storage.from("videos").remove([path]);

    if (error) {
      throw new Error(`Failed to delete video: ${error.message}`);
    }

    return { success: true };
  } catch (error) {
    console.error("[Video Storage] Failed to delete video:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to delete video",
    };
  }
}

/**
 * List all videos for a sequence
 */
export async function listSequenceVideos(
  teamId: string,
  sequenceId: string,
): Promise<{
  success: boolean;
  videos?: Array<{ name: string; size: number; path: string }>;
  error?: string;
}> {
  try {
    const supabase = createAdminClient();
    const folderPath = `teams/${teamId}/sequences/${sequenceId}/frames/`;

    const { data, error } = await supabase.storage
      .from("videos")
      .list(folderPath, {
        limit: 100,
        offset: 0,
      });

    if (error) {
      throw new Error(`Failed to list videos: ${error.message}`);
    }

    const videos = data
      ?.filter((file) => file.name.endsWith(".mp4"))
      .map((file) => ({
        name: file.name,
        size: file.metadata?.size || 0,
        path: `${folderPath}${file.name}`,
      }));

    return {
      success: true,
      videos: videos || [],
    };
  } catch (error) {
    console.error("[Video Storage] Failed to list videos:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to list videos",
    };
  }
}

/**
 * Calculate total storage used by a team
 */
export async function calculateTeamStorageUsage(teamId: string): Promise<{
  success: boolean;
  totalBytes?: number;
  totalMB?: number;
  error?: string;
}> {
  try {
    const supabase = createAdminClient();
    const folderPath = `teams/${teamId}/`;

    const { data, error } = await supabase.storage
      .from("videos")
      .list(folderPath, {
        limit: 1000,
        offset: 0,
      });

    if (error) {
      throw new Error(`Failed to calculate storage: ${error.message}`);
    }

    const totalBytes =
      data?.reduce((sum, file) => {
        return sum + (file.metadata?.size || 0);
      }, 0) || 0;

    return {
      success: true,
      totalBytes,
      totalMB: totalBytes / (1024 * 1024),
    };
  } catch (error) {
    console.error("[Video Storage] Failed to calculate storage:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to calculate storage",
    };
  }
}
