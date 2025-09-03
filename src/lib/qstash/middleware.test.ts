/**
 * Unit tests for QStash signature verification middleware
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { Receiver } from "@upstash/qstash";
import { type NextRequest, NextResponse } from "next/server";
import { ConfigurationError, VelroError } from "@/lib/errors";
import {
  extractQStashMetadata,
  isQStashRequest,
  logQStashRequest,
  verifyQStashSignature,
  withQStashVerification,
} from "./middleware";
import {
  createMockQStashReceiver,
  createTestWebhookRequest,
  setupBunMocks,
} from "./test-utils";

// Mock the @upstash/qstash module
mock.module("@upstash/qstash", () => ({
  Receiver: mock(),
}));

// Mock Next.js
mock.module("next/server", () => ({
  NextResponse: {
    json: mock().mockImplementation((data, options) => ({
      ok: true,
      status: options?.status || 200,
      json: () => Promise.resolve(data),
    })),
  },
}));

describe.skip("QStash Middleware", () => {
  let testSetup: ReturnType<typeof setupBunMocks>;
  let mockReceiver: ReturnType<typeof createMockQStashReceiver>;

  beforeEach(() => {
    testSetup = setupBunMocks();
    mockReceiver = createMockQStashReceiver(true);

    // Mock the Receiver constructor
    (Receiver as any).mockImplementation(() => mockReceiver);
  });

  afterEach(() => {
    testSetup.restoreConsole();
    testSetup.cleanupEnv();
    mock.restore();
  });

  describe("verifyQStashSignature", () => {
    it("should verify signature successfully", async () => {
      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-signature": "valid-signature",
          "upstash-message-id": "msg_test123",
          "upstash-timestamp": "1704067200",
        },
        body: { jobId: "test-job", type: "image", data: {} },
      });

      const result = await verifyQStashSignature(mockRequest as any);

      expect(Receiver).toHaveBeenCalledWith({
        currentSigningKey: "test-current-signing-key",
        nextSigningKey: "test-next-signing-key",
      });
      expect(mockReceiver.verify).toHaveBeenCalledWith({
        signature: "valid-signature",
        body: expect.any(String),
      });
      expect(result.qstashSignatureVerified).toBe(true);
      expect(result.qstashMessageId).toBe("msg_test123");
    });

    it("should throw ConfigurationError if QSTASH_CURRENT_SIGNING_KEY is missing", async () => {
      delete process.env.QSTASH_CURRENT_SIGNING_KEY;

      const mockRequest = createTestWebhookRequest();

      await expect(verifyQStashSignature(mockRequest as any)).rejects.toThrow(
        ConfigurationError,
      );
      await expect(verifyQStashSignature(mockRequest as any)).rejects.toThrow(
        "QSTASH_CURRENT_SIGNING_KEY environment variable is required",
      );
    });

    it("should throw ConfigurationError if QSTASH_NEXT_SIGNING_KEY is missing", async () => {
      delete process.env.QSTASH_NEXT_SIGNING_KEY;

      const mockRequest = createTestWebhookRequest();

      await expect(verifyQStashSignature(mockRequest as any)).rejects.toThrow(
        ConfigurationError,
      );
      await expect(verifyQStashSignature(mockRequest as any)).rejects.toThrow(
        "QSTASH_NEXT_SIGNING_KEY environment variable is required",
      );
    });

    it("should throw VelroError if signature header is missing", async () => {
      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-message-id": "msg_test123",
        },
      });

      await expect(verifyQStashSignature(mockRequest as any)).rejects.toThrow(
        VelroError,
      );
      await expect(verifyQStashSignature(mockRequest as any)).rejects.toThrow(
        "Missing QStash signature header",
      );
    });

    it("should throw VelroError if signature is invalid", async () => {
      mockReceiver = createMockQStashReceiver(false);
      (Receiver as any).mockImplementation(() => mockReceiver);

      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-signature": "invalid-signature",
          "upstash-message-id": "msg_test123",
        },
      });

      await expect(verifyQStashSignature(mockRequest as any)).rejects.toThrow(
        VelroError,
      );
      await expect(verifyQStashSignature(mockRequest as any)).rejects.toThrow(
        "Invalid QStash signature",
      );
    });

    it("should handle receiver errors", async () => {
      const receiverError = new Error("Signature verification failed");
      mockReceiver.verify.mockRejectedValue(receiverError);

      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-signature": "test-signature",
          "upstash-message-id": "msg_test123",
        },
      });

      await expect(verifyQStashSignature(mockRequest as any)).rejects.toThrow(
        VelroError,
      );
      await expect(verifyQStashSignature(mockRequest as any)).rejects.toThrow(
        "QStash signature verification failed: Signature verification failed",
      );
    });

    it("should parse retry count correctly", async () => {
      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-signature": "valid-signature",
          "upstash-message-id": "msg_test123",
          "upstash-retried": "3",
        },
      });

      const result = await verifyQStashSignature(
        mockRequest as unknown as NextRequest,
      );

      expect(result.qstashRetryCount).toBe(3);
    });

    it("should handle missing retry count", async () => {
      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-signature": "valid-signature",
          "upstash-message-id": "msg_test123",
        },
      });

      const result = await verifyQStashSignature(
        mockRequest as unknown as NextRequest,
      );

      expect(result.qstashRetryCount).toBeUndefined();
    });
  });

  describe("withQStashVerification", () => {
    it("should wrap handler with signature verification", async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      };
      const mockHandler = mock().mockResolvedValue(mockResponse);
      const wrappedHandler = withQStashVerification(mockHandler);

      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-signature": "valid-signature",
          "upstash-message-id": "msg_test123",
          "upstash-timestamp": "1704067200",
        },
      });

      const result = await wrappedHandler(mockRequest as any);

      expect(mockReceiver.verify).toHaveBeenCalled();
      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          qstashSignatureVerified: true,
          qstashMessageId: "msg_test123",
        }),
      );
      expect(result).toBeDefined();
      expect(result.status).toBe(200);
      const resultData = await result.json();
      expect(resultData).toEqual(expect.objectContaining({ success: true }));
    });

    it("should return error response if signature verification fails", async () => {
      mockReceiver = createMockQStashReceiver(false);
      (Receiver as any).mockImplementation(() => mockReceiver);

      const mockHandler = mock();
      const wrappedHandler = withQStashVerification(mockHandler);

      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-signature": "invalid-signature",
        },
      });

      const _result = await wrappedHandler(mockRequest as any);

      expect(mockHandler).not.toHaveBeenCalled();
      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message:
            "QStash signature verification failed: Invalid QStash signature",
          error: expect.objectContaining({
            code: "QSTASH_SIGNATURE_VERIFICATION_FAILED",
          }),
          timestamp: expect.any(String),
        }),
        { status: 401 },
      );
    });

    it("should handle handler errors", async () => {
      const handlerError = new Error("Handler failed");
      const mockHandler = mock().mockRejectedValue(handlerError);
      const wrappedHandler = withQStashVerification(mockHandler);

      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-signature": "valid-signature",
        },
      });

      const _result = await wrappedHandler(mockRequest as any);

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "Internal server error during webhook processing",
        }),
        { status: 500 },
      );
    });

    it("should handle VelroError from handler", async () => {
      const velroError = new VelroError(
        "Custom handler error",
        "HANDLER_ERROR",
        422,
      );
      const mockHandler = mock().mockRejectedValue(velroError);
      const wrappedHandler = withQStashVerification(mockHandler);

      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-signature": "valid-signature",
        },
      });

      const _result = await wrappedHandler(mockRequest as any);

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "Custom handler error",
        }),
        { status: 422 },
      );
    });
  });

  describe("extractQStashMetadata", () => {
    it("should extract all QStash metadata from headers", () => {
      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-message-id": "msg_test123",
          "upstash-schedule-id": "sched_test456",
          "upstash-signature": "signature123",
          "upstash-timestamp": "1704067200",
          "upstash-retried": "2",
          "upstash-forwarded-for": "192.168.1.1",
        },
      });

      const metadata = extractQStashMetadata(mockRequest as any);

      expect(metadata).toEqual({
        messageId: "msg_test123",
        scheduleId: "sched_test456",
        signature: "signature123",
        timestamp: "1704067200",
        retryCount: 2,
        forwardedFor: "192.168.1.1",
      });
    });

    it("should handle missing headers", () => {
      const mockRequest = createTestWebhookRequest({
        headers: {},
      });

      const metadata = extractQStashMetadata(mockRequest as any);

      expect(metadata).toEqual({
        messageId: null,
        scheduleId: null,
        signature: null,
        timestamp: null,
        retryCount: 0,
        forwardedFor: null,
      });
    });

    it("should parse retry count correctly", () => {
      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-retried": "5",
        },
      });

      const metadata = extractQStashMetadata(mockRequest as any);

      expect(metadata.retryCount).toBe(5);
    });
  });

  describe("isQStashRequest", () => {
    it("should return true for requests with QStash headers", () => {
      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-signature": "signature123",
          "upstash-timestamp": "1704067200",
        },
      });

      const result = isQStashRequest(mockRequest as any);

      expect(result).toBe(true);
    });

    it("should return false for requests missing signature", () => {
      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-timestamp": "1704067200",
        },
      });

      const result = isQStashRequest(mockRequest as any);

      expect(result).toBe(false);
    });

    it("should return false for requests missing timestamp", () => {
      const mockRequest = createTestWebhookRequest({
        headers: {
          "upstash-signature": "signature123",
        },
      });

      const result = isQStashRequest(mockRequest as any);

      expect(result).toBe(false);
    });

    it("should return false for requests with no QStash headers", () => {
      const mockRequest = createTestWebhookRequest({
        headers: {
          "content-type": "application/json",
        },
      });

      const result = isQStashRequest(mockRequest as any);

      expect(result).toBe(false);
    });
  });

  describe("logQStashRequest", () => {
    it("should log request details with metadata", () => {
      const consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      const mockRequest = createTestWebhookRequest({
        url: "https://example.com/webhook",
        method: "POST",
        headers: {
          "upstash-message-id": "msg_test123",
          "upstash-signature": "signature123",
          "upstash-timestamp": "1704067200",
        },
      });

      logQStashRequest(mockRequest as any, { custom: "context" });

      expect(consoleSpy).toHaveBeenCalledWith(
        "[QStash Request]",
        expect.objectContaining({
          url: "https://example.com/webhook",
          method: "POST",
          messageId: "msg_test123",
          signature: "signature123",
          timestamp: "1704067200",
          isQStashRequest: true,
          custom: "context",
          retryCount: 0,
          scheduleId: null,
          forwardedFor: null,
        }),
      );

      consoleSpy.mockRestore();
    });
  });
});
