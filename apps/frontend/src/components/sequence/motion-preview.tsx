import { Maximize2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import Image from "next/image";
import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Frame } from "@/types/database";

interface MotionPreviewProps {
  videoUrl?: string;
  thumbnailUrl?: string;
  duration?: number;
  frame: Frame;
  onPlay?: () => void;
  onPause?: () => void;
  onSeek?: (time: number) => void;
  autoPlay?: boolean;
  muted?: boolean;
  loading?: boolean;
}

export const MotionPreview: React.FC<MotionPreviewProps> = ({
  videoUrl,
  thumbnailUrl,
  duration,
  frame,
  onPlay,
  onPause,
  onSeek,
  autoPlay = false,
  muted = true,
  loading = false,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(muted);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [_isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  const hasVideo = Boolean(videoUrl);
  const hasThumbnail = Boolean(thumbnailUrl && thumbnailUrl.trim() !== "");

  // Handle video events
  const handlePlay = () => {
    setIsPlaying(true);
    onPlay?.();
  };

  const handlePause = () => {
    setIsPlaying(false);
    onPause?.();
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setVideoDuration(videoRef.current.duration);
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  // Control handlers
  const togglePlay = useCallback(() => {
    if (!videoRef.current || !hasVideo) return;

    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
  }, [isPlaying, hasVideo]);

  const toggleMute = useCallback(() => {
    if (!videoRef.current) return;

    const newMuted = !isMuted;
    setIsMuted(newMuted);
    videoRef.current.muted = newMuted;
  }, [isMuted]);

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoRef.current || !hasVideo) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const seekTime = percentage * videoDuration;

    videoRef.current.currentTime = seekTime;
    setCurrentTime(seekTime);
    onSeek?.(seekTime);
  };

  const toggleFullscreen = useCallback(async () => {
    if (!videoRef.current) return;

    try {
      if (!document.fullscreenElement) {
        await videoRef.current.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch (error) {
      console.error("Fullscreen error:", error);
    }
  }, []);
  const handleKeyPress = useCallback(
    (e: KeyboardEvent) => {
      if (e.target !== document.body) return; // Only handle when not in input fields

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "m":
          e.preventDefault();
          toggleMute();
          break;
        case "f":
          e.preventDefault();
          toggleFullscreen();
          break;
      }
    },
    [toggleFullscreen, toggleMute, togglePlay],
  );

  // Keyboard shortcuts
  useEffect(() => {
    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [handleKeyPress]);

  // Handle fullscreen change
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // Format time display
  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  // Image handlers
  const handleImageLoad = () => {
    setImageLoading(false);
  };

  const handleImageError = () => {
    setImageLoading(false);
    setImageError(true);
  };

  // Show fallback thumbnail if no video
  if (!hasVideo) {
    return (
      <Card className="relative overflow-hidden">
        <CardContent className="p-0">
          <div className="relative aspect-video w-full overflow-hidden">
            {imageLoading && (
              <div className="bg-muted animate-pulse absolute inset-0" />
            )}
            {!hasThumbnail ? (
              <div className="bg-muted flex h-full w-full items-center justify-center">
                <span className="text-muted-foreground text-sm">
                  No preview available
                </span>
              </div>
            ) : imageError ? (
              <div className="bg-muted flex h-full w-full items-center justify-center">
                <span className="text-muted-foreground text-sm">
                  Failed to load image
                </span>
              </div>
            ) : (
              thumbnailUrl && (
                <Image
                  src={thumbnailUrl}
                  alt={`Frame ${frame.order_index} preview`}
                  className={cn(
                    "h-full w-full object-cover transition-opacity duration-300",
                    imageLoading ? "opacity-0" : "opacity-100",
                  )}
                  onLoad={handleImageLoad}
                  onError={handleImageError}
                  width={1920}
                  height={1080}
                />
              )
            )}

            {/* No motion indicator */}
            <div className="absolute inset-0 flex items-center justify-center bg-black/20">
              <div className="bg-background/90 text-foreground rounded-lg px-3 py-1 text-sm font-medium backdrop-blur-sm">
                No motion generated
              </div>
            </div>
          </div>

          {/* Frame info */}
          <div className="p-3">
            <h3 className="text-sm font-medium">Frame {frame.order_index}</h3>
            {duration && (
              <p className="text-muted-foreground text-xs">
                Expected duration: {(duration / 1000).toFixed(1)}s
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className="group relative overflow-hidden"
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
    >
      <CardContent className="p-0">
        <div className="relative aspect-video w-full overflow-hidden">
          {loading && (
            <div className="bg-muted animate-pulse absolute inset-0 z-10 flex items-center justify-center">
              <span className="text-muted-foreground text-sm">
                Loading video...
              </span>
            </div>
          )}

          {/* Video element */}
          <video
            ref={videoRef}
            className="h-full w-full object-cover"
            poster={hasThumbnail && thumbnailUrl ? thumbnailUrl : undefined}
            muted={isMuted}
            autoPlay={autoPlay}
            onPlay={handlePlay}
            onPause={handlePause}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={handleEnded}
            preload="metadata"
          >
            <source src={videoUrl} type="video/mp4" />
            Your browser does not support the video tag.
          </video>

          {/* Play/Pause overlay button */}
          <div className="absolute inset-0 flex items-center justify-center">
            <Button
              variant="secondary"
              size="icon"
              className={cn(
                "h-12 w-12 rounded-full bg-black/50 text-white backdrop-blur-sm transition-opacity hover:bg-black/70",
                isPlaying || showControls
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100",
              )}
              onClick={togglePlay}
            >
              {isPlaying ? (
                <Pause className="h-5 w-5" />
              ) : (
                <Play className="ml-0.5 h-5 w-5" />
              )}
            </Button>
          </div>

          {/* Video controls overlay */}
          <div
            className={cn(
              "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-4 transition-opacity",
              showControls || isPlaying ? "opacity-100" : "opacity-0",
            )}
          >
            {/* Progress bar */}
            <div className="mb-2">
              {/* biome-ignore lint/a11y/noStaticElementInteractions: seek bar */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: seek bar */}
              <div
                className="bg-white/20 h-1 w-full cursor-pointer rounded-full"
                onClick={handleSeek}
              >
                <div
                  className="bg-primary h-full rounded-full transition-all"
                  style={{
                    width: videoDuration
                      ? `${(currentTime / videoDuration) * 100}%`
                      : "0%",
                  }}
                />
              </div>
            </div>

            {/* Control buttons */}
            <div className="flex items-center justify-between text-white">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={togglePlay}
                  className="text-white hover:bg-white/20"
                >
                  {isPlaying ? (
                    <Pause className="h-4 w-4" />
                  ) : (
                    <Play className="ml-0.5 h-4 w-4" />
                  )}
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleMute}
                  className="text-white hover:bg-white/20"
                >
                  {isMuted ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </Button>

                <span className="text-xs">
                  {formatTime(currentTime)} / {formatTime(videoDuration)}
                </span>
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={toggleFullscreen}
                className="text-white hover:bg-white/20"
              >
                <Maximize2 className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Frame info badge */}
          <div className="absolute left-2 top-2">
            <div className="bg-black/50 text-white flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium backdrop-blur-sm">
              Frame {frame.order_index}
              <div className="h-1 w-1 rounded-full bg-green-400" />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
