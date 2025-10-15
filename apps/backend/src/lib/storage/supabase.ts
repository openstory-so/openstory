/**
 * Supabase Storage utilities
 * Handles uploading generated images and videos to Supabase Storage
 */

import { createClient } from "@supabase/supabase-js";

// Create Supabase client for Storage only (not for auth or database)
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export interface UploadOptions {
  bucket: string;
  path: string;
  file: Buffer | Uint8Array;
  contentType: string;
  upsert?: boolean;
}

export interface StorageResult {
  success: boolean;
  url?: string;
  path?: string;
  error?: string;
}

/**
 * Upload a file to Supabase Storage
 */
export async function uploadToStorage(
  options: UploadOptions,
): Promise<StorageResult> {
  try {
    const { bucket, path, file, contentType, upsert = true } = options;

    // Upload to Supabase Storage
    const { error } = await supabase.storage.from(bucket).upload(path, file, {
      contentType,
      upsert,
    });

    if (error) {
      throw new Error(`Storage upload failed: ${error.message}`);
    }

    // Get public URL
    const {
      data: { publicUrl },
    } = supabase.storage.from(bucket).getPublicUrl(path);

    return {
      success: true,
      url: publicUrl,
      path,
    };
  } catch (error) {
    console.error("[Storage] Upload failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to upload file",
    };
  }
}

/**
 * Upload image from URL to Supabase Storage
 */
export async function uploadImageFromUrl(params: {
  imageUrl: string;
  teamId: string;
  sequenceId: string;
  frameId: string;
}): Promise<StorageResult> {
  try {
    const { imageUrl, teamId, sequenceId, frameId } = params;

    // Download image from URL
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }

    const imageBlob = await response.blob();
    const imageBuffer = await imageBlob.arrayBuffer();
    const imageData = new Uint8Array(imageBuffer);

    // Construct storage path
    const storagePath = `teams/${teamId}/sequences/${sequenceId}/frames/${frameId}/thumbnail.png`;

    // Upload to Supabase Storage
    return await uploadToStorage({
      bucket: "thumbnails",
      path: storagePath,
      file: imageData,
      contentType: "image/png",
      upsert: true,
    });
  } catch (error) {
    console.error("[Storage] Image upload from URL failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to upload image",
    };
  }
}

/**
 * Upload video from URL to Supabase Storage
 */
export async function uploadVideoFromUrl(params: {
  videoUrl: string;
  teamId: string;
  sequenceId: string;
  frameId: string;
}): Promise<StorageResult> {
  try {
    const { videoUrl, teamId, sequenceId, frameId } = params;

    // Download video from URL
    const response = await fetch(videoUrl);

    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.statusText}`);
    }

    const videoBlob = await response.blob();
    const videoBuffer = await videoBlob.arrayBuffer();
    const videoData = new Uint8Array(videoBuffer);

    // Construct storage path
    const storagePath = `teams/${teamId}/sequences/${sequenceId}/frames/${frameId}/motion.mp4`;

    // Upload to Supabase Storage
    return await uploadToStorage({
      bucket: "videos",
      path: storagePath,
      file: videoData,
      contentType: "video/mp4",
      upsert: true,
    });
  } catch (error) {
    console.error("[Storage] Video upload from URL failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to upload video",
    };
  }
}

/**
 * Generate a signed URL for temporary file access
 */
export async function getSignedUrl(
  bucket: string,
  path: string,
  expiresIn: number = 3600, // 1 hour default
): Promise<StorageResult> {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
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
    console.error("[Storage] Failed to create signed URL:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to create signed URL",
    };
  }
}

/**
 * Delete a file from Supabase Storage
 */
export async function deleteFromStorage(
  bucket: string,
  path: string,
): Promise<StorageResult> {
  try {
    const { error } = await supabase.storage.from(bucket).remove([path]);

    if (error) {
      throw new Error(`Failed to delete file: ${error.message}`);
    }

    return {
      success: true,
      path,
    };
  } catch (error) {
    console.error("[Storage] Delete failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to delete file",
    };
  }
}
