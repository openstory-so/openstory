import { Play, Video } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import * as React from "react";
import { useCallback, useRef, useState } from "react";
import { generateFrameMotion } from "#actions/sequence";
import type { GeneratedImageStatusResponse } from "@/app/actions/generates/image/types";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { MOTION_ACCESS_DENIED_MESSAGE } from "@/constants";
import { useAuthNavigation } from "@/hooks/use-auth-navigation";
import {
  useEstimateImageCostByFal,
  useGenerateImageByFal,
  useGenerateImageStatusByJobId,
} from "@/hooks/use-fal-models";
import { cn } from "@/lib/utils";
import type { Frame, Style } from "@/types/database";

interface ModelInfo {
  id: string;
  name: string;
  model: string;
  type: "image" | "video";
  cost?: number;
  costUnit?: string;
}

interface StoryboardFrameWithScriptProps {
  frame: Frame;
  isGeneratingPreview?: boolean;
  styleId?: string;
  onEdit?: (frameId: string) => void;
  onDelete?: (frameId: string) => void;
  onRegenerate?: (payload: Record<string, unknown>) => void;
  onFrameUpdate?: (frame: Frame) => void;
  falModels?: ModelInfo[];
  styles?: Style[];
}

export const StoryboardFrameWithScript: React.FC<
  StoryboardFrameWithScriptProps
> = ({
  frame,
  isGeneratingPreview = false,
  styleId,
  onEdit,
  onDelete,
  onRegenerate,
  onFrameUpdate,
  falModels,
}) => {
  // Extract script chunk from metadata or use description
  const metadata = frame.metadata as Record<string, unknown> | null;
  const scriptChunk = metadata?.scriptChunk as string | undefined;
  const displayScript = scriptChunk || frame.description;

  // Auth navigation for redirect preservation
  const { loginUrl } = useAuthNavigation();

  // Video playback state
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  const [isGeneratingMotion, setIsGeneratingMotion] = useState(false);
  const [motionError, setMotionError] = useState<string | null>(null);

  const hasVideo = Boolean(frame.video_url);
  const hasThumbnail = Boolean(frame.thumbnail_url);

  // Image generation with selected model
  const [selectedModel, setSelectedModel] = useState<string | null>("");
  const generateImageMutation = useGenerateImageByFal();
  const estimateImageCostMutation = useEstimateImageCostByFal();
  const [jobId, setJobId] = useState<string | null>(null);
  const [processedJobId, setProcessedJobId] = useState<string | null>(null);
  const { data: activeJob } = useGenerateImageStatusByJobId(jobId || "", {
    enabled: !!jobId,
  });

  // Handle video playback
  const handlePlay = useCallback(() => {
    console.log("[handlePlay] Called", {
      hasVideo,
      showVideo,
      isPlaying,
      videoUrl: frame.video_url,
    });

    if (!hasVideo) {
      console.log("[handlePlay] No video URL");
      return;
    }

    if (!showVideo) {
      console.log("[handlePlay] Showing video element");
      setShowVideo(true);
      // Wait for video to be rendered before playing
      setTimeout(() => {
        if (videoRef.current) {
          console.log("[handlePlay] Playing video");
          videoRef.current.play().catch((err) => {
            console.error("[handlePlay] Error playing video:", err);
          });
          setIsPlaying(true);
        } else {
          console.error("[handlePlay] Video ref is null after timeout");
        }
      }, 100);
    } else if (isPlaying) {
      console.log("[handlePlay] Pausing video");
      videoRef.current?.pause();
      setIsPlaying(false);
    } else {
      console.log("[handlePlay] Resuming video");
      videoRef.current?.play().catch((err) => {
        console.error("[handlePlay] Error resuming video:", err);
      });
      setIsPlaying(true);
    }
  }, [hasVideo, showVideo, isPlaying, frame.video_url]);

  // Handle video ended
  const handleVideoEnded = useCallback(() => {
    setIsPlaying(false);
    // Keep showing video so user can replay
  }, []);

  // Generate motion for the frame
  const handleGenerateMotion = useCallback(async () => {
    if (!styleId) {
      setMotionError("Style ID is required for motion generation");
      return;
    }

    setIsGeneratingMotion(true);
    setMotionError(null);

    try {
      const result = await generateFrameMotion(
        frame.id,
        displayScript || `Frame ${frame.order_index + 1}`,
        styleId,
      );

      if (result.success && result.videoUrl) {
        // Update the frame with the new video URL
        const updatedFrame = {
          ...frame,
          video_url: result.videoUrl,
          duration_ms: result.duration
            ? result.duration * 1000
            : frame.duration_ms,
        };
        onFrameUpdate?.(updatedFrame);
      } else {
        setMotionError(result.error || "Failed to generate motion");
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unexpected error during motion generation";
      setMotionError(errorMessage);
    } finally {
      setIsGeneratingMotion(false);
    }
  }, [frame, displayScript, styleId, onFrameUpdate]);

  // Handle FAL generation with style and script
  const handleGenerateWithSelectedModel = useCallback(async () => {
    if (!selectedModel) return;
    console.log(
      "[handleGenerateWithSelectedModel] displayScript:",
      displayScript,
    );
    try {
      const result = await generateImageMutation.mutateAsync({
        frame_id: frame.id,
        sequence_id: frame.sequence_id,
        model: selectedModel as string,
        prompt: displayScript || "",
        extra_params: {
          image_url: frame.thumbnail_url || "",
        },
        ...(styleId?.trim() && { style_id: styleId.trim() }),
      });
      if (result?.success && result?.jobId) {
        onFrameUpdate?.({
          ...frame,
          thumbnail_url: null,
        });
        setJobId(result.jobId);
      }
    } catch (error) {
      console.error(
        "[handleGenerateWithSelectedModel] FAL generation failed",
        error,
      );
    }
  }, [
    frame,
    generateImageMutation,
    selectedModel,
    displayScript,
    onFrameUpdate,
    styleId,
  ]);

  // check cost per frame with style
  const handleCheckCost = useCallback(async () => {
    if (!selectedModel) return;

    const result = await estimateImageCostMutation.mutateAsync({
      model: selectedModel,
      prompt: displayScript || "",
      extra_params: {
        frame_id: frame.id,
        sequence_id: frame.sequence_id,
      },
    });

    console.log("[handleCheckCost] Cost result:", result);
  }, [frame, selectedModel, displayScript, estimateImageCostMutation]);

  React.useEffect(() => {
    if (
      jobId &&
      activeJob?.data?.status === "completed" &&
      jobId !== processedJobId
    ) {
      const imageProcessed =
        activeJob?.data as unknown as GeneratedImageStatusResponse;
      const imageUrls =
        (imageProcessed?.result as unknown as { imageUrls?: string[] })
          ?.imageUrls ?? [];
      const imageUrl = imageUrls.at(-1) ?? "";

      if (imageUrl && imageUrl !== frame.thumbnail_url) {
        onFrameUpdate?.({
          ...frame,
          thumbnail_url: imageUrl,
        });
        setProcessedJobId(jobId);
      }
    }
  }, [
    jobId,
    activeJob?.data,
    processedJobId,
    frame.thumbnail_url,
    frame,
    onFrameUpdate,
  ]);

  return (
    <div
      className="group relative flex gap-6 rounded-lg border bg-card p-6 transition-all hover:shadow-md"
      data-testid={`storyboard-frame-${frame.order_index}`}
    >
      {/* Frame number badge */}
      <div className="absolute -left-3 top-8 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
        {frame.order_index + 1}
      </div>

      {/* Script section - Left side */}
      <div className="flex-1 space-y-3">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Script Section
        </div>
        <div className="prose prose-sm max-w-none">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {displayScript}
          </p>
        </div>
        {frame.duration_ms && (
          <div className="text-xs text-muted-foreground">
            Duration: {(frame.duration_ms / 1000).toFixed(1)}s
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="w-px bg-border" />

      {/* Frame preview - Right side */}
      <div className="flex-1 space-y-3">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Generated Frame
        </div>

        {/* Frame image/video */}
        <div className="relative aspect-video w-full overflow-hidden rounded-md bg-muted">
          {/* Video element (hidden when not playing) */}
          {hasVideo && showVideo && (
            <video
              ref={videoRef}
              className="absolute inset-0 h-full w-full object-cover z-10"
              src={frame.video_url || ""}
              poster={
                hasThumbnail ? frame.thumbnail_url || undefined : undefined
              }
              onEnded={handleVideoEnded}
              onPause={() => setIsPlaying(false)}
              onPlay={() => setIsPlaying(true)}
              onError={(e) => {
                console.error("[Video] Error loading video:", e);
                console.error("[Video] URL:", frame.video_url);
              }}
              onLoadedMetadata={() => {
                console.log(
                  "[Video] Metadata loaded for frame",
                  frame.order_index,
                );
              }}
              controls={false}
              playsInline
              muted
            />
          )}

          {/* Thumbnail image (shown when video not playing) */}
          {(!showVideo || !hasVideo) && hasThumbnail ? (
            <Image
              src={frame.thumbnail_url || ""}
              alt={`Frame ${frame.order_index + 1} preview`}
              className="h-full w-full object-cover"
              width={1920}
              height={1080}
            />
          ) : (
            !showVideo &&
            !hasThumbnail && (
              <div className="flex h-full w-full items-center justify-center bg-muted">
                {isGeneratingPreview ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                    <span className="text-xs text-muted-foreground">
                      Generating preview...
                    </span>
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    No preview available
                  </span>
                )}
              </div>
            )
          )}

          {/* Play button overlay */}
          {hasVideo && (
            <Button
              variant="secondary"
              size="icon"
              className={cn(
                "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20",
                "h-12 w-12 rounded-full bg-black/60 text-white",
                "transition-opacity hover:bg-black/80",
                isPlaying ? "opacity-0 pointer-events-none" : "opacity-100",
              )}
              onClick={handlePlay}
            >
              <Play className="h-5 w-5 ml-0.5" />
            </Button>
          )}

          {/* Motion generation status */}
          {isGeneratingMotion && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-30">
              <div className="flex flex-col items-center gap-2 text-white">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-white" />
                <span className="text-xs">Generating motion...</span>
              </div>
            </div>
          )}

          {/* Video indicator badge */}
          {hasVideo && (
            <div className="absolute top-2 right-2 z-15">
              <div className="bg-black/60 text-white flex items-center gap-1 rounded px-1.5 py-0.5 backdrop-blur-sm">
                <Video className="h-3 w-3" />
                <span className="text-xs font-medium">Motion</span>
              </div>
            </div>
          )}
        </div>

        {/* Motion error */}
        {motionError && (
          <div className="text-xs text-destructive mt-1">
            {motionError}
            {motionError === MOTION_ACCESS_DENIED_MESSAGE && (
              <Link
                href={loginUrl}
                className="ml-2 underline text-primary hover:text-primary/80"
              >
                Sign in
              </Link>
            )}
          </div>
        )}

        {/* Action buttons - shown on hover */}
        <div className="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
          {!hasVideo && styleId && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleGenerateMotion}
              disabled={isGeneratingMotion}
              className="flex-1"
            >
              {isGeneratingMotion ? "Generating..." : "Generate Motion"}
            </Button>
          )}
          {hasVideo && (
            <Button
              size="sm"
              variant="outline"
              onClick={handlePlay}
              className="flex-1"
            >
              {isPlaying ? "Pause" : "Play Video"}
            </Button>
          )}
          {onRegenerate && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleGenerateWithSelectedModel()}
              className="flex-1"
              disabled={!selectedModel}
            >
              {isGeneratingPreview ? "Generating..." : "Regenerate Frame"}
            </Button>
          )}
          {onEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onEdit(frame.id)}
              className="flex-1"
            >
              Edit
            </Button>
          )}
          {onDelete && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDelete(frame.id)}
              className="flex-1"
            >
              Delete
            </Button>
          )}

          {
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => handleCheckCost()}
            >
              Check Cost
            </Button>
          }
        </div>

        {/* Select model */}
        {falModels && (
          <div className="opacity-0 transition-opacity group-hover:opacity-100">
            <div className="w-full flex-1 flex flex-col gap-2">
              <Select
                placeholder="Select Model"
                options={falModels.map((model) => ({
                  label: model.name,
                  value: model.id,
                }))}
                onChange={(value) => {
                  setSelectedModel(value);
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
