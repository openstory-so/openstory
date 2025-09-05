import { faker } from "@faker-js/faker";
import { generateMockFrame } from "@/lib/mocks/data-generators";
import type { Frame } from "@/types/database";

// Set consistent seed for reproducible results
faker.seed(456);

// Simulation delays for realistic user experience
export const DELAYS = {
  SCRIPT_VALIDATION: 500,
  SCRIPT_ENHANCEMENT: 1500,
  FRAME_GENERATION: 2500,
  MOTION_GENERATION: 3500,
} as const;

// Mock frame generation response
interface FrameGenerationResult {
  success: boolean;
  frames: Frame[];
  error?: string;
}

// Mock motion generation response
interface MotionGenerationResult {
  success: boolean;
  videoUrl: string;
  duration: number; // in milliseconds
  error?: string;
}

/**
 * Generate frames from script (mock)
 */
export async function generateFrames(
  script: string,
  styleId: string,
  sequenceId: string,
): Promise<FrameGenerationResult> {
  // Simulate processing time
  await new Promise((resolve) => setTimeout(resolve, DELAYS.FRAME_GENERATION));

  const trimmedScript = script.trim();

  if (!trimmedScript) {
    return {
      success: false,
      frames: [],
      error: "Cannot generate frames from empty script",
    };
  }

  if (!styleId) {
    return {
      success: false,
      frames: [],
      error: "Style is required for frame generation",
    };
  }

  // Split script into scenes/frames based on sentences and length
  const sentences = trimmedScript
    .split(/[.!?]+/)
    .filter((s) => s.trim().length > 0);
  const frameCount = Math.min(Math.max(1, Math.ceil(sentences.length / 2)), 8); // Max 8 frames

  const frames: Frame[] = [];

  for (let i = 0; i < frameCount; i++) {
    const startSentence = Math.floor((i / frameCount) * sentences.length);
    const endSentence = Math.floor(((i + 1) / frameCount) * sentences.length);
    const frameScript = sentences.slice(startSentence, endSentence).join(". ");

    // Generate diverse thumbnail URLs using different Unsplash collections
    const imageCategories = [
      "1478720568477-152d9b164e26", // Cinema
      "1485846234645-a62644f84728", // Film production
      "1524712245354-2c4e5e7121c0", // Cinematic landscape
      "1536098561742-ca998e48cbcc", // Action scene
      "1440404653325-ab127d49abc1", // Movie scene
      "1514565131-fce0801e5785", // City skyline
      "1506905925346-21bda4d32df4", // Mountain landscape
      "1507003211169-0a1dd7228f2d", // Portrait
      "1519904981063-e0895b8d4c89", // Nature scene
      "1511884642898-093c83e36043", // Abstract
    ];

    const imageId = faker.helpers.arrayElement(imageCategories);
    const thumbnailUrl = `https://picsum.photos/seed/${imageId}/1920/1080`;

    // Generate frame with realistic metadata
    const frame = generateMockFrame({
      id: `${sequenceId}_frame_${i + 1}`,
      sequence_id: sequenceId,
      order_index: i + 1,
      description: frameScript.trim() || `Frame ${i + 1}`,
      thumbnail_url: thumbnailUrl,
      video_url: null, // Will be generated in motion step
      duration_ms: faker.number.int({ min: 3000, max: 8000 }),
      metadata: {
        generated: true,
        styleId,
        scriptSegment: frameScript.trim(),
        generateOrder: i + 1,
        // Include some default mock metadata
        characters: [],
        setting: "Generated Scene",
        mood: "Dynamic",
      },
    });

    frames.push(frame);
  }

  return {
    success: true,
    frames,
  };
}

/**
 * Generate motion video for a specific frame (mock)
 */
export async function generateFrameMotion(
  frameId: string,
  frameDescription: string,
  styleId: string,
): Promise<MotionGenerationResult> {
  // Simulate processing time
  await new Promise((resolve) => setTimeout(resolve, DELAYS.MOTION_GENERATION));

  if (!frameId || !frameDescription) {
    return {
      success: false,
      videoUrl: "",
      duration: 0,
      error: "Frame ID and description are required",
    };
  }

  if (!styleId) {
    return {
      success: false,
      videoUrl: "",
      duration: 0,
      error: "Style is required for motion generation",
    };
  }

  // Simulate occasional failures for realism
  if (faker.number.float() < 0.1) {
    // 10% failure rate
    const errors = [
      "Motion generation failed - please try again",
      "Server temporarily unavailable",
      "Style not compatible with motion generation",
      "Frame description too complex for motion",
    ];

    return {
      success: false,
      videoUrl: "",
      duration: 0,
      error: faker.helpers.arrayElement(errors),
    };
  }

  // Generate mock video URL using real sample videos
  // These are actual working video URLs for testing
  const sampleVideos = [
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
  ];

  // Select a random video from the list
  const videoUrl = faker.helpers.arrayElement(sampleVideos);

  const duration = faker.number.int({ min: 3000, max: 8000 }); // 3-8 seconds

  return {
    success: true,
    videoUrl,
    duration,
  };
}

/**
 * Batch generate motion for multiple frames
 */
export async function generateBatchMotion(
  frames: Array<{ id: string; description: string }>,
  styleId: string,
): Promise<Array<{ frameId: string; result: MotionGenerationResult }>> {
  const results = await Promise.all(
    frames.map(async (frame) => ({
      frameId: frame.id,
      result: await generateFrameMotion(frame.id, frame.description, styleId),
    })),
  );

  return results;
}

/**
 * Get generation progress (mock)
 */
interface GenerationProgress {
  type: "storyboard" | "motion";
  progress: number; // 0-100
  currentStep: string;
  estimatedTimeRemaining: number; // in seconds
  completed: boolean;
  error?: string;
}

export async function getGenerationProgress(
  _jobId: string,
): Promise<GenerationProgress> {
  // Simulate progress check
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Mock progress based on job age (in a real app, this would come from the job queue)
  const progress = faker.number.int({ min: 10, max: 100 });
  const isCompleted = progress >= 100;

  const storyboardSteps = [
    "Analyzing script structure...",
    "Identifying key scenes...",
    "Generating visual descriptions...",
    "Creating frame compositions...",
    "Rendering thumbnail images...",
    "Finalizing storyboard...",
  ];

  const motionSteps = [
    "Processing frame data...",
    "Analyzing motion requirements...",
    "Generating camera movements...",
    "Creating motion vectors...",
    "Rendering video sequence...",
    "Finalizing motion video...",
  ];

  const steps = faker.helpers.arrayElement([storyboardSteps, motionSteps]);
  const currentStepIndex = Math.floor((progress / 100) * (steps.length - 1));
  const currentStep = steps[currentStepIndex];

  const estimatedTimeRemaining = isCompleted
    ? 0
    : faker.number.int({ min: 5, max: 30 });

  return {
    type: faker.helpers.arrayElement(["storyboard", "motion"]),
    progress,
    currentStep,
    estimatedTimeRemaining,
    completed: isCompleted,
  };
}
