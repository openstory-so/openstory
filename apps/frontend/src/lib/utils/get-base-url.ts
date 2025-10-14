/**
 * Get the base URL for the application
 * Works in both server and client environments
 */
export function getBaseUrl(): string {
  // Browser should use relative URL
  if (typeof window !== "undefined") {
    return "";
  }

  // Vercel deployment
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  // Local development with QStash tunnel
  if (process.env.QSTASH_TUNNEL_URL) {
    return process.env.QSTASH_TUNNEL_URL;
  }

  // Fallback to APP_URL if set (for backwards compatibility)
  if (process.env.APP_URL) {
    return process.env.APP_URL;
  }

  // Default to localhost
  return "http://localhost:3000";
}

/**
 * Get the absolute URL for the application
 * Useful for external services that need the full URL
 */
export function getAbsoluteUrl(): string {
  const baseUrl = getBaseUrl();

  // If we got an empty string (client-side), construct from window.location
  if (baseUrl === "" && typeof window !== "undefined") {
    return window.location.origin;
  }

  return baseUrl;
}

/**
 * Get the URL for QStash webhooks
 * In production, QStash needs a publicly accessible URL
 * In local development, we use a local QStash server that can reach localhost
 */
export function getQStashWebhookUrl(): string {
  // In production (Vercel deployment)
  if (process.env.VERCEL_URL) {
    const baseUrl = process.env.BASE_URL || `https://${process.env.VERCEL_URL}`;
    return baseUrl;
  }

  // Local development with QStash tunnel (if using cloud QStash)
  if (process.env.QSTASH_TUNNEL_URL) {
    return process.env.QSTASH_TUNNEL_URL;
  }

  // Fallback to APP_URL if explicitly set
  if (process.env.APP_URL) {
    return process.env.APP_URL;
  }

  // Local development with local QStash server (default)
  // The local QStash server at localhost:8080 can reach localhost:3000
  return "http://localhost:3000";
}
