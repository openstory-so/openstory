import type { SupabaseClient } from "@supabase/supabase-js";
import { getQStashClient } from "@/lib/qstash/client";
import { getJobManager, JobType } from "@/lib/qstash/job-manager";
import { DNADirectorProcessor } from "@/lib/services/dna-director/dna-director.service";
import {
  type CreateFrameParams,
  type FrameService,
  frameService,
} from "@/lib/services/frame.service";
import { ShotTypes } from "@/lib/services/frame-generation-job/enum";
import { createServerClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/types/database";
import { LoggerService } from "../logger.service";
import type { ProcessSceneJobParams } from "./types";

export class FrameGenerationJobService {
  private loggerService: LoggerService;
  private frameService: FrameService;

  constructor(
    private supabase: SupabaseClient<Database> = createServerClient(),
    frameServiceInstance?: FrameService,
  ) {
    this.loggerService = new LoggerService("FrameGenerationJobService");
    this.frameService = frameServiceInstance ?? frameService;
  }

  async processScene(params: ProcessSceneJobParams) {
    const { sequenceId, scene, aiModel, imageSize, generateThumbnails } =
      params;
    const serviceStartTime = Date.now(); // Record service start time
    const orderIndex = scene.orderIndex;

    if (!scene) {
      this.loggerService.logError("No scene provided");
    }

    // Fetch the sequence record securely
    const { data: sequence, error: sequenceError } = await this.supabase
      .from("sequences")
      .select("id, script, status, style_id")
      .eq("id", sequenceId)
      .single();

    if (sequenceError || !sequence) {
      this.loggerService.logError("Sequence not found");
      return;
    }

    let styleId = sequence.style_id;
    // Fallback to default style if no style_id or specific style not found
    if (!sequence.style_id) {
      this.loggerService.logInfo("Using default style");
      const { data: defaultStyle, error: defaultStyleError } =
        await this.supabase
          .from("styles")
          .select("id")
          .eq("category", "cinematic")
          .single();

      if (defaultStyleError || !defaultStyle) {
        this.loggerService.logError("No styles available in database");
      }

      styleId = defaultStyle.id;
      this.loggerService.logInfo(`Using default style: ${defaultStyle.id}`);
    }

    if (!styleId) {
      this.loggerService.logError("No style ID found");
    }

    const shotTypes = ShotTypes[orderIndex % ShotTypes.length];
    const dnaResult = await DNADirectorProcessor(
      styleId,
      scene.scriptContent || "",
    );
    const originalSceneScript = scene.scriptContent;
    if (dnaResult.status) {
      scene.scriptContent =
        dnaResult.data?.message || scene.scriptContent || "";
      this.loggerService.logDebug(
        `Original scene script: ${JSON.stringify(scene.scriptContent)}`,
      );
      this.loggerService.logDebug(
        `DNA Director scene script: ${JSON.stringify(dnaResult.data?.message)}`,
      );
    } else {
      this.loggerService.logError(`DNA Director error: ${dnaResult.error}`);
    }

    // Calculate service execution time
    const serviceEndTime = Date.now();
    const serviceDurationMs = serviceEndTime - serviceStartTime;

    const frameData: CreateFrameParams = {
      description: scene.scriptContent,
      orderIndex: orderIndex,
      durationMs: serviceDurationMs,
      sequenceId: sequenceId,
      metadata: {
        scene: orderIndex || 0,
        scriptChunk: scene.scriptContent,
        shotType: shotTypes,
        sceneType: scene.type,
        sceneIntensity: scene.intensity,
        characters: scene.characters || [],
        settings: scene.settings || [],
        durationMs: serviceDurationMs,
        startTime: new Date(serviceStartTime).toISOString(),
        endTime: new Date(serviceEndTime).toISOString(),
        userId: params.userId,
        teamId: params.teamId,
        shouldGenerateImage: generateThumbnails,
        originalSceneScript: originalSceneScript,
        dnaSceneScript: scene.scriptContent,
        dnaConfig: dnaResult.config as Json,
      },
    };

    const frame = await this.frameService.createFrame(frameData);

    if (!generateThumbnails) {
      this.loggerService.logInfo(
        `Skipping thumbnail generation for frame ${frame.id}, please check frame metadata for shouldGenerateImage flag`,
      );
      return;
    }

    if (!frame.description) {
      this.loggerService.logError(`Frame ${frame.id} has no description`);
      return;
    }

    const qstashClient = getQStashClient();
    const jobManager = getJobManager();
    const selectedModel = aiModel || "flux_krea_lora";
    const selectedImageSize = imageSize || "landscape_16_9";

    // Create an image generation job for each frame
    const imageJob = await jobManager.createJob({
      type: JobType.IMAGE,
      payload: {
        frameId: frame.id,
        sequenceId: params.sequenceId,
        prompt: frame.description,
        model: selectedModel,
        image_size: selectedImageSize,
        num_images: 1,
      },
      userId: params.userId,
      teamId: params.teamId,
    });

    // Queue the image generation job
    const imagePayload = {
      jobId: imageJob.id,
      type: JobType.IMAGE,
      userId: params.userId,
      teamId: params.teamId,
      data: {
        frameId: frame.id,
        sequenceId: params.sequenceId,
        prompt: frame.description || "",
        model: selectedModel,
        image_size: selectedImageSize,
        num_images: 1,
        style: styleId,
      },
    };

    const result = await qstashClient.publishImageJob(imagePayload, {
      delay: 0, // Process immediately
    });

    this.loggerService.logInfo(
      `Image job queued for frame ${frame.id}: ${result.messageId}`,
    );
  }
}
