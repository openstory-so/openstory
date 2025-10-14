/**
 * Unit tests for QStash client wrapper
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Client } from "@upstash/qstash";
import { ConfigurationError, VelroError } from "@/lib/errors";
import { getQStashClient, QStashClient } from "./client";
import { createTestJobPayload, setupBunMocks } from "./test-utils";

// Mock the @upstash/qstash module
mock.module("@upstash/qstash", () => ({
  Client: mock(),
}));

describe.skip("QStashClient", () => {
  let mockClient: any;
  let testSetup: ReturnType<typeof setupBunMocks>;

  beforeEach(() => {
    testSetup = setupBunMocks();

    // Create mock client instance
    mockClient = {
      publishJSON: mock(),
      messages: {
        delete: mock(),
        get: mock(),
      },
    };

    // Mock the Client constructor
    (Client as any).mockImplementation(() => mockClient);
  });

  afterEach(() => {
    testSetup.restoreConsole();
    testSetup.cleanupEnv();
    mock.restore();
  });

  describe("constructor", () => {
    it("should initialize with valid environment variables", () => {
      const _client = new QStashClient();
      expect(Client).toHaveBeenCalledWith({
        token: "test-qstash-token-12345",
      });
    });

    it("should throw ConfigurationError if QSTASH_TOKEN is missing", () => {
      delete process.env.QSTASH_TOKEN;

      expect(() => new QStashClient()).toThrow(ConfigurationError);
      expect(() => new QStashClient()).toThrow(
        "QSTASH_TOKEN environment variable is required",
      );
    });

    it("should initialize with getAbsoluteUrl when no VERCEL_URL is set", () => {
      // Should not throw when NEXT_PUBLIC_API_URL is missing
      // as it now uses getAbsoluteUrl internally
      expect(() => new QStashClient()).not.toThrow();
    });
  });

  describe("publishMessage", () => {
    let client: QStashClient;

    beforeEach(() => {
      client = new QStashClient();
    });

    it("should publish a message successfully", async () => {
      const mockResponse = { messageId: "msg_test123", deduplicated: false };
      mockClient.publishJSON.mockResolvedValue(mockResponse);

      const message = {
        url: "https://example.com/webhook",
        body: { test: "data" },
        headers: { "custom-header": "value" },
        delay: 1000,
        deduplicationId: "dedup-123",
      };

      const result = await client.publishMessage(message);

      expect(mockClient.publishJSON).toHaveBeenCalledWith({
        url: "https://example.com/webhook",
        body: { test: "data" },
        headers: {
          "Content-Type": "application/json",
          "custom-header": "value",
        },
        delay: 1000,
        notBefore: undefined,
        deduplicationId: "dedup-123",
        contentBasedDeduplication: undefined,
        retries: 3,
        callback: undefined,
        failureCallback: undefined,
      });

      expect(result).toEqual(mockResponse);
    });

    it("should handle publish errors and wrap in VelroError", async () => {
      const publishError = new Error("QStash API error");
      mockClient.publishJSON.mockRejectedValue(publishError);

      const message = {
        url: "https://example.com/webhook",
        body: { test: "data" },
      };

      await expect(client.publishMessage(message)).rejects.toThrow(VelroError);
      await expect(client.publishMessage(message)).rejects.toThrow(
        "Failed to publish QStash message: QStash API error",
      );
    });

    it("should handle unknown errors", async () => {
      mockClient.publishJSON.mockRejectedValue("Unknown error");

      const message = {
        url: "https://example.com/webhook",
        body: { test: "data" },
      };

      await expect(client.publishMessage(message)).rejects.toThrow(
        "Failed to publish QStash message: Unknown error",
      );
    });
  });

  describe("publishImageJob", () => {
    let client: QStashClient;

    beforeEach(() => {
      client = new QStashClient();
    });

    it("should publish an image job successfully", async () => {
      const mockResponse = { messageId: "msg_image123", deduplicated: false };
      mockClient.publishJSON.mockResolvedValue(mockResponse);

      const payload = createTestJobPayload({ type: "image" });
      const options = { delay: 5000, deduplicationId: "custom-dedup" };

      const result = await client.publishImageJob(payload, options);

      expect(mockClient.publishJSON).toHaveBeenCalledWith({
        url: "https://test-api.example.com/api/v1/webhooks/qstash/image",
        body: payload,
        headers: {
          "Content-Type": "application/json",
        },
        delay: 5000,
        notBefore: undefined,
        deduplicationId: "custom-dedup",
        contentBasedDeduplication: false,
        retries: 3,
        callback: undefined,
        failureCallback: undefined,
      });

      expect(result).toEqual(mockResponse);
    });

    it("should use jobId as deduplicationId when not provided", async () => {
      const mockResponse = { messageId: "msg_image123", deduplicated: false };
      mockClient.publishJSON.mockResolvedValue(mockResponse);

      const payload = createTestJobPayload({ type: "image" });

      await client.publishImageJob(payload);

      expect(mockClient.publishJSON).toHaveBeenCalledWith(
        expect.objectContaining({
          deduplicationId: payload.jobId,
        }),
      );
    });
  });

  describe("publishVideoJob", () => {
    let client: QStashClient;

    beforeEach(() => {
      client = new QStashClient();
    });

    it("should publish a video job successfully", async () => {
      const mockResponse = { messageId: "msg_video123", deduplicated: false };
      mockClient.publishJSON.mockResolvedValue(mockResponse);

      const payload = createTestJobPayload({ type: "video" });

      const result = await client.publishVideoJob(payload);

      expect(mockClient.publishJSON).toHaveBeenCalledWith({
        url: "https://test-api.example.com/api/v1/webhooks/qstash/video",
        body: payload,
        headers: {
          "Content-Type": "application/json",
        },
        delay: undefined,
        notBefore: undefined,
        deduplicationId: payload.jobId,
        contentBasedDeduplication: false,
        retries: 3,
        callback: undefined,
        failureCallback: undefined,
      });

      expect(result).toEqual(mockResponse);
    });
  });

  describe("publishScriptJob", () => {
    let client: QStashClient;

    beforeEach(() => {
      client = new QStashClient();
    });

    it("should publish a script job successfully", async () => {
      const mockResponse = { messageId: "msg_script123", deduplicated: false };
      mockClient.publishJSON.mockResolvedValue(mockResponse);

      const payload = createTestJobPayload({ type: "script" });

      const result = await client.publishScriptJob(payload);

      expect(mockClient.publishJSON).toHaveBeenCalledWith({
        url: "https://test-api.example.com/api/v1/webhooks/qstash/script",
        body: payload,
        headers: {
          "Content-Type": "application/json",
        },
        delay: undefined,
        notBefore: undefined,
        deduplicationId: payload.jobId,
        contentBasedDeduplication: false,
        retries: 3,
        callback: undefined,
        failureCallback: undefined,
      });

      expect(result).toEqual(mockResponse);
    });
  });

  describe("cancelMessage", () => {
    let client: QStashClient;

    beforeEach(() => {
      client = new QStashClient();
    });

    it("should cancel a message successfully", async () => {
      mockClient.messages.delete.mockResolvedValue(undefined);

      const messageId = "msg_test123";

      await client.cancelMessage(messageId);

      expect(mockClient.messages.delete).toHaveBeenCalledWith(messageId);
    });

    it("should handle cancellation errors", async () => {
      const cancelError = new Error("Message not found");
      mockClient.messages.delete.mockRejectedValue(cancelError);

      const messageId = "msg_test123";

      await expect(client.cancelMessage(messageId)).rejects.toThrow(VelroError);
      await expect(client.cancelMessage(messageId)).rejects.toThrow(
        "Failed to cancel QStash message: Message not found",
      );
    });
  });

  describe("getMessage", () => {
    let client: QStashClient;

    beforeEach(() => {
      client = new QStashClient();
    });

    it("should get a message successfully", async () => {
      const mockMessage = {
        messageId: "msg_test123",
        url: "https://example.com",
      };
      mockClient.messages.get.mockResolvedValue(mockMessage);

      const messageId = "msg_test123";

      const result = await client.getMessage(messageId);

      expect(mockClient.messages.get).toHaveBeenCalledWith(messageId);
      expect(result).toEqual(mockMessage);
    });

    it("should handle get message errors", async () => {
      const getError = new Error("Message not found");
      mockClient.messages.get.mockRejectedValue(getError);

      const messageId = "msg_test123";

      await expect(client.getMessage(messageId)).rejects.toThrow(VelroError);
      await expect(client.getMessage(messageId)).rejects.toThrow(
        "Failed to get QStash message: Message not found",
      );
    });
  });

  describe("getQStashClient singleton", () => {
    it("should return the same instance on multiple calls", () => {
      const client1 = getQStashClient();
      const client2 = getQStashClient();

      expect(client1).toBe(client2);
    });
  });
});
