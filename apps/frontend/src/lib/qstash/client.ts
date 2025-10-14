/**
 * QStash client wrapper for Velro
 * Provides typed message publishing with error handling and logging
 */

import { Client } from "@upstash/qstash";
import { ConfigurationError, VelroError } from "@/lib/errors";
import { LoggerService } from "@/lib/services/logger.service";
import { getQStashWebhookUrl } from "@/lib/utils/get-base-url";
import type { JobPayload as TypedJobPayload } from "./types";

export interface QStashMessage {
  url: string;
  body: JobPayload | Record<string, unknown>;
  headers?: Record<string, string>;
  delay?: number;
  not_before?: number;
  deduplicationId?: string;
  contentBasedDeduplication?: boolean;
  retries?: number;
  callback?: string;
  failure_callback?: string;
}

export interface QStashResponse {
  messageId: string;
  deduplicated?: boolean;
}

// Re-export typed payload for backwards compatibility
export type JobPayload = TypedJobPayload;

class QStashClient {
  private client: Client;
  private baseWebhookUrl: string;
  private loggerService: LoggerService;

  constructor() {
    const token = process.env.QSTASH_TOKEN;

    if (!token) {
      throw new ConfigurationError(
        "QSTASH_TOKEN environment variable is required",
      );
    }

    const apiUrl = getQStashWebhookUrl();
    this.client = new Client({ token });
    this.baseWebhookUrl = `${apiUrl}/api/v1/webhooks/qstash`;
    this.loggerService = new LoggerService("QStashClient");
    // Client initialized successfully
  }

  /**
   * Publish a message to QStash
   */
  async publishMessage(message: QStashMessage): Promise<QStashResponse> {
    try {
      const response = await this.client.publishJSON({
        url: message.url,
        body: message.body,
        headers: {
          "Content-Type": "application/json",
          ...message.headers,
        },
        delay: message.delay,
        notBefore: message.not_before,
        deduplicationId: message.deduplicationId,
        contentBasedDeduplication: message.contentBasedDeduplication,
        retries: message.retries ?? 3, // Default to 3 retries
        callback: message.callback,
        failureCallback: message.failure_callback,
      });

      const result = {
        messageId: response.messageId,
        deduplicated: response.deduplicated,
      };

      return result;
    } catch (error) {
      console.error("[QStash] Failed to publish message", {
        error: error instanceof Error ? error.message : "Unknown error",
        url: message.url,
      });

      if (error instanceof Error) {
        throw new VelroError(
          `Failed to publish QStash message: ${error.message}`,
          "QSTASH_PUBLISH_ERROR",
          503,
          { originalError: error.name, url: message.url },
        );
      }

      throw new VelroError(
        "Failed to publish QStash message: Unknown error",
        "QSTASH_PUBLISH_ERROR",
        503,
        { url: message.url },
      );
    }
  }

  /**
   * Publish an image generation job
   */
  async publishImageJob(
    payload: JobPayload,
    options?: {
      delay?: number;
      deduplicationId?: string;
    },
  ): Promise<QStashResponse> {
    this.loggerService.logDebug(`Publishing image job ${payload.jobId}`);
    return this.publishMessage({
      url: `${this.baseWebhookUrl}/image`,
      body: payload,
      delay: options?.delay,
      deduplicationId: options?.deduplicationId ?? payload.jobId,
      contentBasedDeduplication: false, // Use explicit deduplication ID
      retries: 3,
    });
  }

  /**
   * Publish a video generation job
   */
  async publishVideoJob(
    payload: JobPayload,
    options?: {
      delay?: number;
      deduplicationId?: string;
    },
  ): Promise<QStashResponse> {
    return this.publishMessage({
      url: `${this.baseWebhookUrl}/video`,
      body: payload,
      delay: options?.delay,
      deduplicationId: options?.deduplicationId ?? payload.jobId,
      contentBasedDeduplication: false,
      retries: 3,
    });
  }

  /**
   * Publish a script analysis job
   */
  async publishScriptJob(
    payload: JobPayload,
    options?: {
      delay?: number;
      deduplicationId?: string;
    },
  ): Promise<QStashResponse> {
    return this.publishMessage({
      url: `${this.baseWebhookUrl}/script`,
      body: payload,
      delay: options?.delay,
      deduplicationId: options?.deduplicationId ?? payload.jobId,
      contentBasedDeduplication: false,
      retries: 3,
    });
  }

  /**
   * Publish a frame generation job
   */
  async publishFrameGenerationJob(
    payload: JobPayload,
    options?: {
      delay?: number;
      deduplicationId?: string;
    },
  ): Promise<QStashResponse> {
    return this.publishMessage({
      url: `${this.baseWebhookUrl}/frames`,
      body: payload,
      delay: options?.delay,
      deduplicationId: options?.deduplicationId ?? payload.jobId,
      contentBasedDeduplication: false,
      retries: 3,
    });
  }

  /**
   * Publish a motion generation job (image-to-video)
   */
  async publishMotionJob(
    payload: JobPayload,
    options?: {
      delay?: number;
      deduplicationId?: string;
    },
  ): Promise<QStashResponse> {
    return this.publishMessage({
      url: `${this.baseWebhookUrl}/frames-motion`,
      body: payload,
      delay: options?.delay,
      deduplicationId: options?.deduplicationId ?? payload.jobId,
      contentBasedDeduplication: false,
      retries: 3,
    });
  }

  /**
   * Cancel a message (if it hasn't been processed yet)
   */
  async cancelMessage(messageId: string): Promise<void> {
    try {
      await this.client.messages.delete(messageId);
    } catch (error) {
      console.error("[QStash] Failed to cancel message", {
        error: error instanceof Error ? error.message : "Unknown error",
        messageId,
      });

      if (error instanceof Error) {
        throw new VelroError(
          `Failed to cancel QStash message: ${error.message}`,
          "QSTASH_CANCEL_ERROR",
          503,
          { originalError: error.name, messageId },
        );
      }

      throw new VelroError(
        "Failed to cancel QStash message: Unknown error",
        "QSTASH_CANCEL_ERROR",
        503,
        { messageId },
      );
    }
  }

  /**
   * Get message details
   */
  async getMessage(messageId: string): Promise<unknown> {
    try {
      const message = await this.client.messages.get(messageId);

      return message;
    } catch (error) {
      console.error("[QStash] Failed to get message", {
        error: error instanceof Error ? error.message : "Unknown error",
        messageId,
      });

      if (error instanceof Error) {
        throw new VelroError(
          `Failed to get QStash message: ${error.message}`,
          "QSTASH_GET_ERROR",
          503,
          { originalError: error.name, messageId },
        );
      }

      throw new VelroError(
        "Failed to get QStash message: Unknown error",
        "QSTASH_GET_ERROR",
        503,
        { messageId },
      );
    }
  }
}

// Create a singleton instance
let qstashClient: QStashClient | null = null;

export const getQStashClient = (): QStashClient => {
  if (!qstashClient) {
    qstashClient = new QStashClient();
  }
  return qstashClient;
};

// Export types and client
export { QStashClient };
export default getQStashClient;
