import { Elysia } from "elysia";

/**
 * Custom error classes for the application
 */
export class VelroError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message);
    this.name = "VelroError";
  }
}

export class ValidationError extends VelroError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class AuthenticationError extends VelroError {
  constructor(message: string = "Authentication required") {
    super(message, 401, "AUTHENTICATION_ERROR");
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends VelroError {
  constructor(message: string = "Insufficient permissions") {
    super(message, 403, "AUTHORIZATION_ERROR");
    this.name = "AuthorizationError";
  }
}

export class NotFoundError extends VelroError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class ConflictError extends VelroError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
    this.name = "ConflictError";
  }
}

/**
 * Error handling plugin for Elysia
 * Provides consistent error responses across the API
 */
export const errorPlugin = new Elysia({ name: "error" }).onError(
  ({ code, error, set }) => {
    // Log error for debugging
    console.error(`[ERROR] ${code}:`, error);

    // Handle custom VelroError instances
    if (error instanceof VelroError) {
      set.status = error.statusCode;
      return {
        success: false,
        error: {
          message: error.message,
          code: error.code,
          statusCode: error.statusCode,
        },
      };
    }

    // Handle Elysia validation errors
    if (code === "VALIDATION") {
      set.status = 400;
      return {
        success: false,
        error: {
          message: "Validation failed",
          code: "VALIDATION_ERROR",
          statusCode: 400,
          details: error.message,
        },
      };
    }

    // Handle not found errors
    if (code === "NOT_FOUND") {
      set.status = 404;
      return {
        success: false,
        error: {
          message: "Resource not found",
          code: "NOT_FOUND",
          statusCode: 404,
        },
      };
    }

    // Handle parse errors
    if (code === "PARSE") {
      set.status = 400;
      return {
        success: false,
        error: {
          message: "Invalid request body",
          code: "PARSE_ERROR",
          statusCode: 400,
        },
      };
    }

    // Handle internal server errors
    set.status = 500;
    return {
      success: false,
      error: {
        message:
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : error instanceof Error ? error.message : "Unknown error",
        code: "INTERNAL_ERROR",
        statusCode: 500,
      },
    };
  }
);

