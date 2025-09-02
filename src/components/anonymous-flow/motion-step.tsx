import * as React from "react";
import {
  generateBatchMotion,
  generateFrameMotion,
  type MotionGenerationResult,
} from "@/app/actions/anonymous-flow/index.mock";
import { MotionPreview } from "@/components/sequence/motion-preview";
import { SectionHeading } from "@/components/typography";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useAnonymousSession,
  useUpgradePrompts,
} from "@/hooks/use-anonymous-session";
import type {
  AnonymousFlowAction,
  AnonymousFlowState,
} from "@/reducers/anonymous-flow-reducer";

interface MotionStepProps {
  state: AnonymousFlowState;
  dispatch: React.Dispatch<AnonymousFlowAction>;
  onPrevious: () => void;
}

export const MotionStep: React.FC<MotionStepProps> = ({
  state,
  dispatch,
  onPrevious,
}) => {
  const { sessionData, upgradeToMagicLink } = useAnonymousSession();
  const { shouldShowUpgradePrompt } = useUpgradePrompts(sessionData);

  const [generatingFrameIds, setGeneratingFrameIds] = React.useState<
    Set<string>
  >(new Set());
  const [showUpgradeDialog, setShowUpgradeDialog] = React.useState(false);
  const [upgradeEmail, setUpgradeEmail] = React.useState("");
  const [isUpgrading, setIsUpgrading] = React.useState(false);

  // Show upgrade prompt after generating motion
  React.useEffect(() => {
    if (shouldShowUpgradePrompt("motion_generated") && !showUpgradeDialog) {
      const hasMotion = state.sequence?.frames.some((frame) => frame.video_url);
      if (hasMotion) {
        dispatch({ type: "SET_SHOW_UPGRADE_PROMPT", payload: true });
      }
    }
  }, [
    state.sequence?.frames,
    shouldShowUpgradePrompt,
    showUpgradeDialog,
    dispatch,
  ]);

  const handleGenerateFrameMotion = React.useCallback(
    async (frameId: string) => {
      if (!state.sequence || !state.sequence.styleId) return;

      const frame = state.sequence.frames.find((f) => f.id === frameId);
      if (!frame) return;

      setGeneratingFrameIds((prev) => new Set([...prev, frameId]));
      dispatch({ type: "START_MOTION_GENERATION", payload: frameId });

      try {
        const result: MotionGenerationResult = await generateFrameMotion(
          frameId,
          frame.description || `Frame ${frameId}`,
          state.sequence.styleId,
        );

        if (result.success) {
          dispatch({
            type: "COMPLETE_MOTION_GENERATION",
            payload: { frameId, videoUrl: result.videoUrl },
          });
        } else {
          dispatch({
            type: "FAIL_MOTION_GENERATION",
            payload: result.error || "Failed to generate motion",
          });
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Unexpected error during motion generation";
        dispatch({ type: "FAIL_MOTION_GENERATION", payload: errorMessage });
      } finally {
        setGeneratingFrameIds((prev) => {
          const next = new Set(prev);
          next.delete(frameId);
          return next;
        });
      }
    },
    [state.sequence, dispatch],
  );

  const handleGenerateAllMotion = React.useCallback(async () => {
    if (!state.sequence || !state.sequence.styleId) return;

    const framesToGenerate = state.sequence.frames.filter(
      (frame) => !frame.video_url,
    );
    if (framesToGenerate.length === 0) return;

    const frameIds = framesToGenerate.map((f) => f.id);
    setGeneratingFrameIds(new Set(frameIds));

    dispatch({
      type: "SET_CURRENT_OPERATION",
      payload: "Generating motion for all frames...",
    });

    try {
      const results = await generateBatchMotion(
        framesToGenerate.map((f) => ({
          id: f.id,
          description: f.description || `Frame ${f.id}`,
        })),
        state.sequence.styleId,
      );

      for (const { frameId, result } of results) {
        if (result.success) {
          dispatch({
            type: "COMPLETE_MOTION_GENERATION",
            payload: { frameId, videoUrl: result.videoUrl },
          });
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unexpected error during batch motion generation";
      dispatch({ type: "FAIL_MOTION_GENERATION", payload: errorMessage });
    } finally {
      setGeneratingFrameIds(new Set());
      dispatch({ type: "SET_CURRENT_OPERATION", payload: null });
    }
  }, [state.sequence, dispatch]);

  const handleUpgradeAccount = React.useCallback(async () => {
    if (!upgradeEmail.trim()) return;

    setIsUpgrading(true);
    try {
      const result = await upgradeToMagicLink(upgradeEmail);
      if (result.success) {
        setShowUpgradeDialog(false);
        // Show success message
        alert(
          "Magic link sent! Check your email to complete account creation.",
        );
      } else {
        alert(result.error || "Failed to send magic link");
      }
    } catch (_error) {
      alert("Failed to upgrade account");
    } finally {
      setIsUpgrading(false);
    }
  }, [upgradeEmail, upgradeToMagicLink]);

  const framesWithMotion =
    state.sequence?.frames.filter((frame) => frame.video_url) || [];
  const framesWithoutMotion =
    state.sequence?.frames.filter((frame) => !frame.video_url) || [];
  const totalFrames = state.sequence?.frames.length || 0;

  const hasAnyMotion = framesWithMotion.length > 0;
  const allFramesHaveMotion =
    totalFrames > 0 && framesWithMotion.length === totalFrames;

  if (!state.sequence || state.sequence.frames.length === 0) {
    return (
      <div className="space-y-8" data-testid="motion-step">
        <Alert>
          <div className="space-y-2">
            <div className="font-medium">No Frames Available</div>
            <div className="text-sm">
              Please go back and generate your storyboard first.
            </div>
          </div>
        </Alert>

        <div className="flex justify-start">
          <Button
            variant="outline"
            onClick={onPrevious}
            data-testid="back-to-storyboard-button"
          >
            ← Back to Storyboard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="motion-step">
      {/* Header */}
      <div className="space-y-2">
        <SectionHeading>Add Motion</SectionHeading>
        <p className="text-muted-foreground">
          Bring your storyboard to life with AI-generated motion. Generate
          videos for individual frames or all at once.
        </p>
      </div>

      {/* Progress Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Motion Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">
                {framesWithMotion.length} of {totalFrames} frames have motion
              </div>
              <div className="text-sm text-muted-foreground">
                {framesWithoutMotion.length} frames remaining
              </div>
            </div>

            {framesWithoutMotion.length > 0 && (
              <Button
                onClick={handleGenerateAllMotion}
                disabled={generatingFrameIds.size > 0}
                data-testid="generate-all-motion-button"
              >
                {generatingFrameIds.size > 0
                  ? "Generating..."
                  : "Generate All Motion"}
              </Button>
            )}
          </div>

          {state.generation.currentOperation && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
              <span>{state.generation.currentOperation}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Frame Motion List */}
      <div className="space-y-6">
        {state.sequence.frames
          .sort((a, b) => a.order_index - b.order_index)
          .map((frame, index) => (
            <div key={frame.id} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Frame {index + 1}</span>
                <span className="text-xs text-muted-foreground">
                  {frame.video_url ? "✓ Motion generated" : "No motion"}
                </span>
              </div>

              <div className="space-y-4">
                <MotionPreview
                  frame={frame}
                  videoUrl={frame.video_url || undefined}
                  thumbnailUrl={frame.thumbnail_url || ""}
                  duration={frame.duration_ms || undefined}
                  loading={generatingFrameIds.has(frame.id)}
                  data-testid={`motion-preview-${index}`}
                />

                {!frame.video_url && (
                  <Button
                    onClick={() => handleGenerateFrameMotion(frame.id)}
                    disabled={generatingFrameIds.has(frame.id)}
                    size="sm"
                  >
                    {generatingFrameIds.has(frame.id)
                      ? "Generating..."
                      : "Generate Motion"}
                  </Button>
                )}

                {frame.video_url && (
                  <Button
                    variant="outline"
                    onClick={() => handleGenerateFrameMotion(frame.id)}
                    disabled={generatingFrameIds.has(frame.id)}
                    size="sm"
                  >
                    {generatingFrameIds.has(frame.id)
                      ? "Regenerating..."
                      : "Regenerate"}
                  </Button>
                )}
              </div>
            </div>
          ))}
      </div>

      {/* Generation Errors */}
      {state.generation.motionError && (
        <Alert variant="destructive">
          <div className="space-y-2">
            <div className="font-medium">Motion Generation Error</div>
            <div className="text-sm">{state.generation.motionError}</div>
          </div>
        </Alert>
      )}

      {/* Upgrade Prompt */}
      {state.ui.showUpgradePrompt && hasAnyMotion && !showUpgradeDialog && (
        <Alert>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="font-medium">🎉 Great work!</div>
              <div className="text-sm">
                You've created {framesWithMotion.length} motion video
                {framesWithMotion.length !== 1 ? "s" : ""}! Want to save your
                work and unlock more features?
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => setShowUpgradeDialog(true)}
                data-testid="show-upgrade-dialog-button"
              >
                Create Free Account
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  dispatch({ type: "SET_SHOW_UPGRADE_PROMPT", payload: false })
                }
              >
                Maybe Later
              </Button>
            </div>
          </div>
        </Alert>
      )}

      {/* Upgrade Dialog (simplified inline version) */}
      {showUpgradeDialog && (
        <Card>
          <CardHeader>
            <CardTitle>Create Your Free Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm text-muted-foreground">
                Enter your email to save your work and unlock additional
                features:
              </div>
              <ul className="text-sm list-disc list-inside space-y-1">
                <li>Save and restore your sequences</li>
                <li>Higher quality exports</li>
                <li>More style options</li>
                <li>Team collaboration</li>
              </ul>
            </div>

            <div className="space-y-2">
              <input
                type="email"
                placeholder="Enter your email"
                value={upgradeEmail}
                onChange={(e) => setUpgradeEmail(e.target.value)}
                className="w-full px-3 py-2 border rounded-md"
                data-testid="upgrade-email-input"
              />

              <div className="flex gap-2">
                <Button
                  onClick={handleUpgradeAccount}
                  disabled={!upgradeEmail.trim() || isUpgrading}
                  data-testid="upgrade-account-button"
                >
                  {isUpgrading ? "Sending..." : "Send Magic Link"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowUpgradeDialog(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Completion Status */}
      {allFramesHaveMotion && (
        <Alert>
          <div className="space-y-2">
            <div className="font-medium">🎬 Sequence Complete!</div>
            <div className="text-sm">
              All frames now have motion videos. Your sequence is ready!
            </div>
          </div>
        </Alert>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          onClick={onPrevious}
          data-testid="back-to-storyboard-button"
        >
          ← Back to Storyboard
        </Button>

        {hasAnyMotion && (
          <div className="text-sm text-muted-foreground">
            Step 3 of 3 - Motion generation complete!
          </div>
        )}
      </div>
    </div>
  );
};
