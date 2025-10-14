import {
  callOpenRouter,
  type OpenRouterMessage,
  type OpenRouterResponse,
  RECOMMENDED_MODELS,
} from "@/lib/ai/openrouter-client";
import { STYLE_CATEGORIES } from "@/lib/schemas/style-stack";
import { LoggerService } from "@/lib/services/logger.service";
import { createServerClient } from "@/lib/supabase/server";
import {
  DNAConfigSchema,
  type DNADirectorParams,
  type DNADirectorResponse,
  type DNADirectorTemplateMessage,
  type DNADirectorTemplateMessageContent,
} from "./types";

export async function DNADirectorProcessor(
  styleId: string,
  prompt: string,
): Promise<DNADirectorResponse> {
  const supabase = createServerClient();
  const { data: style, error: styleError } = await supabase
    .from("styles")
    .select("id, name, description, config, category")
    .eq("id", styleId)
    .single();

  const result: DNADirectorResponse = {
    status: false,
    error: undefined,
    data: undefined,
    config: undefined,
  };

  if (styleError) {
    result.error = styleError.message;
    result.status = false;
    return result;
  }

  if (!style) {
    result.error = "Style not found";
    return result;
  }

  if (!style.description) {
    result.error = "Style missing description";
    return result;
  }

  if (!style.config) {
    result.error = "Style missing config";
    return result;
  }

  const parsedConfig = DNAConfigSchema.safeParse(style.config);
  if (!parsedConfig.success) {
    result.error = "Invalid style config";
    result.status = false;
    return result;
  }

  const DNAConfig = parsedConfig.data;
  const dnaConfig = {
    styleCategory: style?.category,
    directorialIntent: style?.description,
    mood: DNAConfig.mood,
    visualStyle: DNAConfig.artStyle,
    lighting: DNAConfig.lighting,
    colorPalette: DNAConfig.colorPalette,
    cameraLanguage: DNAConfig?.cameraWork,
    cinematicReferences: DNAConfig?.referenceFilms,
    aspectRatio: DNAConfig.aspectRatio,
    frameLookAndExtras: [
      DNAConfig.frameRate ?? "24fps",
      DNAConfig.colorGrading ?? "Natural",
    ].filter(Boolean),
    referenceImageUrl: null,
  };

  result.config = dnaConfig;

  const payload = {
    prompt,
    ...dnaConfig,
  };
  let llmResponse: OpenRouterResponse | undefined;
  try {
    const directorTemplate = await DNADirectorTemplate(
      payload as DNADirectorParams,
    );
    llmResponse = await callOpenRouter({
      model: RECOMMENDED_MODELS.creative,
      messages: directorTemplate as OpenRouterMessage[],
    });

    if (llmResponse?.choices && llmResponse?.choices.length > 0) {
      const content = llmResponse.choices[0].message.content;
      const messageText =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? ((content as Array<{ type: string; text?: string }>).find(
                (c) => c.type === "text",
              )?.text ?? "")
            : typeof content === "object" &&
                content !== null &&
                "type" in content &&
                (content as { type: string }).type === "text"
              ? ((content as { text?: string }).text ?? "")
              : "";

      if (messageText && messageText.trim().length > 0) {
        result.data = {
          message: messageText,
          promptTokens: llmResponse?.usage?.prompt_tokens ?? 0,
          completionTokens: llmResponse?.usage?.completion_tokens ?? 0,
          totalTokens: llmResponse?.usage?.total_tokens ?? 0,
        };
        result.status = true;
      } else {
        result.error = "Empty response from LLM";
        result.status = false;
      }
    } else {
      result.error = "Empty response from LLM";
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.status = false;
  }

  return result;
}

const DNADirectorTemplate = async (params: DNADirectorParams) => {
  const {
    prompt,
    styleCategory,
    directorialIntent,
    mood,
    visualStyle,
    lighting,
    colorPalette,
    cameraLanguage,
    cinematicReferences,
    aspectRatio,
    frameLookAndExtras,
    referenceImageUrl,
  } = params;

  const loggerService = new LoggerService("DNADirectorTemplate");
  // Get all categories
  const allCategories = STYLE_CATEGORIES; // Returns the array above

  const userContent: DNADirectorTemplateMessageContent = {
    scene: prompt,
    directorialIntent: directorialIntent,
    characters: [],
    styleConfig: {
      styleName: styleCategory,
      mood: mood,
      artStyle: visualStyle,
      lighting: lighting,
      frameRate: frameLookAndExtras[0],
      cameraWork: cameraLanguage,
      aspectRatio: aspectRatio,
      colorGrading: frameLookAndExtras[1],
      colorPalette: colorPalette,
      referenceFilms: cinematicReferences,
    },
  };

  const referencedImages: {
    type: string;
    source: {
      type: string;
      media_type: string;
      data: string;
    };
  }[] = [];

  // Validate URL
  let imgUrl: string | null = referenceImageUrl;
  try {
    const url = new URL(referenceImageUrl || "");
    if (!["http:", "https:"].includes(url.protocol)) {
      loggerService.logWarning(
        "Invalid protocol in reference URL, ignoring image",
      );
      imgUrl = null; // Fall back to no image
    }
  } catch {
    loggerService.logWarning("Invalid reference image URL, ignoring image");
    imgUrl = null; // Fall back to no image
  }

  // If there is a reference image, add it to the messages
  if (imgUrl) {
    const url = new URL(imgUrl);
    const hostname = url.hostname.toLowerCase();
    // Block private/internal addresses
    if (
      hostname === "localhost" ||
      hostname.startsWith("127.") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("169.254.") || // AWS metadata
      hostname.startsWith("[::1]") || // IPv6 localhost
      hostname.startsWith("metadata.google.internal") // GCP metadata
    ) {
      loggerService.logError("Blocked attempt to access internal URL");
    }

    // Fetch with size limit and timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
      const res = await fetch(imgUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "Velro/1.0" },
      });

      if (!res.ok) {
        loggerService.logError(`HTTP ${res.status}: ${res.statusText}`);
      }

      const contentType = res.headers.get("content-type");
      if (!contentType?.startsWith("image/")) {
        loggerService.logError("URL does not point to an image");
      }

      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
        // 10MB limit
        loggerService.logError("Image too large");
      }

      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > 10 * 1024 * 1024) {
        loggerService.logError("Image too large");
      }
      const mimeType = contentType || "image/jpeg";
      const base64Image = Buffer.from(buffer).toString("base64");

      referencedImages.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mimeType,
          data: base64Image,
        },
      });
    } catch (error) {
      loggerService.logError(`Error fetching reference image: ${error}`);
      loggerService.logError("Ignoring reference image");
    } finally {
      clearTimeout(timeout);
    }
  }

  const messages: DNADirectorTemplateMessage[] = [
    {
      role: "system",
      content: `You are an experienced film director and screenwriter AI capable of translating scene descriptions into rich, immersive storytelling. You understand visual storytelling, lighting, pacing, and tone. Adapt the story based on the given style configuration (${allCategories.join(", ")}).`,
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Scene: ${userContent.scene}\nDirectorial Intent: ${userContent.directorialIntent}\nStyle Config:\n${Object.entries(
            userContent.styleConfig,
          )
            .map(([key, value]) => `- ${key.toUpperCase()}: ${value}`)
            .join("\n")}`,
        },
        ...referencedImages.map((image) => ({
          type: "image_url",
          image_url: { url: image.source.data },
        })),
      ],
    },
  ];

  return messages;
};
