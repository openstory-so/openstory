/**
 * Custom error classes for better error handling and categorization
 */

export class VelroError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      details: this.details,
    };
  }
}

export class DatabaseError extends VelroError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "DATABASE_ERROR", 500, details);
  }
}

export class ConnectionError extends VelroError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CONNECTION_ERROR", 503, details);
  }
}

export class ValidationError extends VelroError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", 400, details);
  }
}

export class ConfigurationError extends VelroError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CONFIGURATION_ERROR", 500, details);
  }
}

export class StorageError extends VelroError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "STORAGE_ERROR", 500, details);
  }
}

/**
 * Utility function to handle and format errors consistently for API routes
 */
export const handleApiError = (error: unknown): VelroError => {
  if (error instanceof VelroError) {
    return error;
  }

  if (error instanceof Error) {
    return new VelroError(error.message, "INTERNAL_ERROR", 500, {
      originalError: error.name,
    });
  }

  return new VelroError("An unknown error occurred", "UNKNOWN_ERROR", 500, {
    originalError: typeof error,
  });
};

/**
 * Create standardized error response for Server Actions
 */
export function createActionErrorResponse(error: unknown): {
  success: false;
  error: string;
  code?: string;
} {
  if (error instanceof VelroError) {
    return {
      success: false,
      error: error.message,
      code: error.code,
    };
  }

  if (error instanceof Error) {
    return {
      success: false,
      error: error.message,
    };
  }

  return {
    success: false,
    error: "An unknown error occurred",
  };
}

/**
 * Retry utility for handling transient failures
 */
export interface RetryOptions {
  attempts: number;
  delayMs: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export const withRetry = async <T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  const {
    attempts,
    delayMs,
    backoffMultiplier = 1.5,
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;
  let currentDelay = delayMs;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry if this is the last attempt or if shouldRetry returns false
      if (attempt === attempts || !shouldRetry(error)) {
        break;
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
      currentDelay *= backoffMultiplier;
    }
  }

  throw lastError;
};
