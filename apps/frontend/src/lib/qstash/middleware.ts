/**
 * QStash signature verification middleware for webhook endpoints
 * Verifies incoming webhook requests are authentically from QStash
 */

import { Receiver } from "@upstash/qstash";
import { type NextRequest, NextResponse } from "next/server";
import { ConfigurationError, VelroError } from "@/lib/errors";

export interface QStashVerifiedRequest extends NextRequest {
  qstashSignatureVerified: true;
  qstashMessageId?: string;
  qstashScheduleId?: string;
  qstashRetryCount?: number;
}

/**
 * Middleware function to verify QStash signatures
 */
export async function verifyQStashSignature(
  request: NextRequest,
): Promise<QStashVerifiedRequest> {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentSigningKey) {
    throw new ConfigurationError(
      "QSTASH_CURRENT_SIGNING_KEY environment variable is required",
    );
  }

  if (!nextSigningKey) {
    throw new ConfigurationError(
      "QSTASH_NEXT_SIGNING_KEY environment variable is required",
    );
  }

  try {
    // Create receiver with signing keys
    const receiver = new Receiver({
      currentSigningKey,
      nextSigningKey,
    });

    // Extract QStash headers for debugging and tracking
    const signature = request.headers.get("upstash-signature");
    const messageId = request.headers.get("upstash-message-id");
    const scheduleId = request.headers.get("upstash-schedule-id");
    const retryCount = request.headers.get("upstash-retried");

    if (!signature) {
      throw new VelroError(
        "Missing QStash signature header",
        "QSTASH_SIGNATURE_MISSING",
        401,
        {
          url: request.url,
          method: request.method,
        },
      );
    }

    // Get the raw request body
    const body = await request.text();

    // Verify the signature
    const isValid = await receiver.verify({
      signature,
      body,
    });

    if (!isValid) {
      throw new VelroError(
        "Invalid QStash signature",
        "QSTASH_SIGNATURE_INVALID",
        401,
        {
          url: request.url,
          method: request.method,
        },
      );
    }

    // Create a new request with the body (since we consumed it)
    const enhancedRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body,
    }) as QStashVerifiedRequest;

    enhancedRequest.qstashSignatureVerified = true;
    enhancedRequest.qstashMessageId = messageId || undefined;
    enhancedRequest.qstashScheduleId = scheduleId || undefined;
    enhancedRequest.qstashRetryCount = retryCount
      ? Number.parseInt(retryCount, 10)
      : undefined;

    return enhancedRequest;
  } catch (error) {
    console.error("[QStash Middleware] Signature verification failed", {
      url: request.url,
      error: error instanceof Error ? error.message : "Unknown error",
      headers: Object.fromEntries(
        Array.from(request.headers.entries()).filter(([key]) =>
          key.toLowerCase().startsWith("upstash-"),
        ),
      ),
    });

    if (error instanceof Error) {
      throw new VelroError(
        `QStash signature verification failed: ${error.message}`,
        "QSTASH_SIGNATURE_VERIFICATION_FAILED",
        401,
        {
          originalError: error.name,
          url: request.url,
          method: request.method,
        },
      );
    }

    throw new VelroError(
      "QStash signature verification failed: Unknown error",
      "QSTASH_SIGNATURE_VERIFICATION_FAILED",
      401,
      {
        url: request.url,
        method: request.method,
      },
    );
  }
}

/**
 * Higher-order function to wrap webhook handlers with signature verification
 */
export function withQStashVerification(
  handler: (request: QStashVerifiedRequest) => Promise<NextResponse>,
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    try {
      // Verify the signature first
      const verifiedRequest = await verifyQStashSignature(request);

      // Call the actual handler with the verified request
      return await handler(verifiedRequest);
    } catch (error) {
      console.error("[QStash Middleware] Request handling failed", {
        url: request.url,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      if (error instanceof VelroError) {
        return NextResponse.json(
          {
            success: false,
            message: error.message,
            error: error.toJSON(),
            timestamp: new Date().toISOString(),
          },
          { status: error.statusCode },
        );
      }

      // Handle unexpected errors
      const unexpectedError = new VelroError(
        "Internal server error during webhook processing",
        "WEBHOOK_PROCESSING_ERROR",
        500,
        {
          originalError: error instanceof Error ? error.name : typeof error,
        },
      );

      return NextResponse.json(
        {
          success: false,
          message: unexpectedError.message,
          error: unexpectedError.toJSON(),
          timestamp: new Date().toISOString(),
        },
        { status: unexpectedError.statusCode },
      );
    }
  };
}

/**
 * Extract QStash metadata from headers
 */
export function extractQStashMetadata(request: NextRequest) {
  return {
    messageId: request.headers.get("upstash-message-id"),
    scheduleId: request.headers.get("upstash-schedule-id"),
    signature: request.headers.get("upstash-signature"),
    timestamp: request.headers.get("upstash-timestamp"),
    retryCount: (() => {
      const retried = request.headers.get("upstash-retried");
      return retried ? Number.parseInt(retried, 10) : 0;
    })(),
    forwardedFor: request.headers.get("upstash-forwarded-for"),
  };
}

/**
 * Check if request is from QStash by examining headers
 */
export function isQStashRequest(request: NextRequest): boolean {
  return (
    !!request.headers.get("upstash-signature") &&
    !!request.headers.get("upstash-timestamp")
  );
}

/**
 * Log QStash request details for debugging
 */
export function logQStashRequest(
  request: NextRequest,
  _context?: Record<string, unknown>,
) {
  const _metadata = extractQStashMetadata(request);

  // QStash request logging disabled for production
  // const requestInfo = {
  //   url: request.url,
  //   method: request.method,
  //   ...metadata,
  //   isQStashRequest: isQStashRequest(request),
  //   ...context,
  // });
}
