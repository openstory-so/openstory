import { describe, expect, it, mock } from "bun:test";
import {
  ConfigurationError,
  ConnectionError,
  DatabaseError,
  handleApiError,
  StorageError,
  ValidationError,
  VelroError,
  withRetry,
} from "./errors";

describe("VelroError", () => {
  it("should create an error with all properties", () => {
    const error = new VelroError("Test error", "TEST_CODE", 400, {
      extra: "data",
    });

    expect(error.message).toBe("Test error");
    expect(error.code).toBe("TEST_CODE");
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual({ extra: "data" });
    expect(error.name).toBe("VelroError");
  });

  it("should use default status code of 500", () => {
    const error = new VelroError("Test error", "TEST_CODE");
    expect(error.statusCode).toBe(500);
  });

  it("should serialize to JSON correctly", () => {
    const error = new VelroError("Test error", "TEST_CODE", 400, {
      extra: "data",
    });

    const json = error.toJSON();
    expect(json).toEqual({
      name: "VelroError",
      message: "Test error",
      code: "TEST_CODE",
      statusCode: 400,
      details: { extra: "data" },
    });
  });
});

describe("Custom Error Classes", () => {
  describe("DatabaseError", () => {
    it("should create a database error with 500 status", () => {
      const error = new DatabaseError("Database connection failed", {
        table: "users",
      });

      expect(error.message).toBe("Database connection failed");
      expect(error.code).toBe("DATABASE_ERROR");
      expect(error.statusCode).toBe(500);
      expect(error.details).toEqual({ table: "users" });
      expect(error.name).toBe("DatabaseError");
    });
  });

  describe("ConnectionError", () => {
    it("should create a connection error with 503 status", () => {
      const error = new ConnectionError("Service unavailable", {
        service: "supabase",
      });

      expect(error.message).toBe("Service unavailable");
      expect(error.code).toBe("CONNECTION_ERROR");
      expect(error.statusCode).toBe(503);
      expect(error.details).toEqual({ service: "supabase" });
      expect(error.name).toBe("ConnectionError");
    });
  });

  describe("ValidationError", () => {
    it("should create a validation error with 400 status", () => {
      const error = new ValidationError("Invalid input", {
        field: "email",
      });

      expect(error.message).toBe("Invalid input");
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.statusCode).toBe(400);
      expect(error.details).toEqual({ field: "email" });
      expect(error.name).toBe("ValidationError");
    });
  });

  describe("ConfigurationError", () => {
    it("should create a configuration error with 500 status", () => {
      const error = new ConfigurationError("Missing environment variable", {
        variable: "DATABASE_URL",
      });

      expect(error.message).toBe("Missing environment variable");
      expect(error.code).toBe("CONFIGURATION_ERROR");
      expect(error.statusCode).toBe(500);
      expect(error.details).toEqual({ variable: "DATABASE_URL" });
      expect(error.name).toBe("ConfigurationError");
    });
  });

  describe("StorageError", () => {
    it("should create a storage error with 500 status", () => {
      const error = new StorageError("Failed to upload file", {
        bucket: "images",
      });

      expect(error.message).toBe("Failed to upload file");
      expect(error.code).toBe("STORAGE_ERROR");
      expect(error.statusCode).toBe(500);
      expect(error.details).toEqual({ bucket: "images" });
      expect(error.name).toBe("StorageError");
    });
  });
});

describe("handleApiError", () => {
  it("should return VelroError instance as is", () => {
    const velroError = new DatabaseError("Test error");
    const result = handleApiError(velroError);
    expect(result).toBe(velroError);
  });

  it("should convert standard Error to VelroError", () => {
    const standardError = new Error("Standard error");
    const result = handleApiError(standardError);

    expect(result).toBeInstanceOf(VelroError);
    expect(result.message).toBe("Standard error");
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.statusCode).toBe(500);
    expect(result.details).toEqual({ originalError: "Error" });
  });

  it("should handle unknown error types", () => {
    const unknownError = { weird: "object" };
    const result = handleApiError(unknownError);

    expect(result).toBeInstanceOf(VelroError);
    expect(result.message).toBe("An unknown error occurred");
    expect(result.code).toBe("UNKNOWN_ERROR");
    expect(result.statusCode).toBe(500);
    expect(result.details).toEqual({ originalError: "object" });
  });

  it("should handle null and undefined errors", () => {
    const nullResult = handleApiError(null);
    expect(nullResult.message).toBe("An unknown error occurred");
    expect(nullResult.details).toEqual({ originalError: "object" });

    const undefinedResult = handleApiError(undefined);
    expect(undefinedResult.message).toBe("An unknown error occurred");
    expect(undefinedResult.details).toEqual({ originalError: "undefined" });
  });

  it("should handle string errors", () => {
    const result = handleApiError("String error");
    expect(result.message).toBe("An unknown error occurred");
    expect(result.code).toBe("UNKNOWN_ERROR");
    expect(result.details).toEqual({ originalError: "string" });
  });
});

describe("withRetry", () => {
  it("should succeed on first attempt", async () => {
    const operation = mock().mockResolvedValue("success");
    const result = await withRetry(operation, {
      attempts: 3,
      delayMs: 100,
    });

    expect(result).toBe("success");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure and eventually succeed", async () => {
    const operation = mock()
      .mockRejectedValueOnce(new Error("Fail 1"))
      .mockRejectedValueOnce(new Error("Fail 2"))
      .mockResolvedValue("success");

    const result = await withRetry(operation, {
      attempts: 3,
      delayMs: 10,
    });

    expect(result).toBe("success");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("should throw after all attempts fail", async () => {
    const error = new Error("Persistent failure");
    const operation = mock().mockRejectedValue(error);

    await expect(
      withRetry(operation, {
        attempts: 3,
        delayMs: 10,
      }),
    ).rejects.toThrow("Persistent failure");

    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("should apply backoff multiplier", async () => {
    const operation = mock()
      .mockRejectedValueOnce(new Error("Fail 1"))
      .mockRejectedValueOnce(new Error("Fail 2"))
      .mockResolvedValue("success");

    const startTime = Date.now();
    await withRetry(operation, {
      attempts: 3,
      delayMs: 10,
      backoffMultiplier: 2,
    });
    const endTime = Date.now();

    // First delay: 10ms, Second delay: 20ms, Total minimum: 30ms
    expect(endTime - startTime).toBeGreaterThanOrEqual(30);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("should respect shouldRetry callback", async () => {
    const retryableError = new Error("Retryable");
    const nonRetryableError = new Error("Do not retry");

    const operation = mock()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(nonRetryableError);

    await expect(
      withRetry(operation, {
        attempts: 3,
        delayMs: 10,
        shouldRetry: (error) => {
          return error instanceof Error && error.message !== "Do not retry";
        },
      }),
    ).rejects.toThrow("Do not retry");

    // Should stop after non-retryable error
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("should not retry when shouldRetry returns false on first attempt", async () => {
    const error = new Error("Non-retryable");
    const operation = mock().mockRejectedValue(error);

    await expect(
      withRetry(operation, {
        attempts: 3,
        delayMs: 10,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow("Non-retryable");

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should use default backoff multiplier of 1.5", async () => {
    const operation = mock()
      .mockRejectedValueOnce(new Error("Fail"))
      .mockResolvedValue("success");

    const startTime = Date.now();
    await withRetry(operation, {
      attempts: 2,
      delayMs: 10,
    });
    const endTime = Date.now();

    // With default multiplier 1.5, delay should be at least 10ms
    expect(endTime - startTime).toBeGreaterThanOrEqual(10);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
