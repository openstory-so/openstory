/**
 * Email Service for Velro
 * Handles sending transactional emails via Resend
 */

import { Resend } from "resend";

// Initialize Resend with API key
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Email sender configuration with strict validation
// In production, EMAIL_FROM is REQUIRED and must be a verified domain in Resend
// In development, falls back to Resend's test address
const FROM_EMAIL =
  process.env.EMAIL_FROM ||
  (process.env.NODE_ENV === "development"
    ? "onboarding@resend.dev" // Resend's official test address
    : (() => {
        throw new Error(
          "EMAIL_FROM environment variable is required in production. Must be a verified sender in Resend.",
        );
      })());

const FROM_NAME = process.env.EMAIL_FROM_NAME || "Velro";

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Send an email using Resend
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
}: SendEmailParams): Promise<{ success: boolean; error?: string }> {
  // Check if Resend is configured
  if (!resend) {
    console.error("[Email] Resend not configured - missing RESEND_API_KEY");
    return {
      success: false,
      error: "Email service not configured",
    };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ""), // Strip HTML for text version
    });

    if (error) {
      console.error("[Email] Failed to send:", error);
      return { success: false, error: error.message };
    }

    console.log("[Email] Sent successfully:", data?.id);
    return { success: true };
  } catch (error) {
    console.error("[Email] Exception:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send email",
    };
  }
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string,
): Promise<{ success: boolean; error?: string }> {
  const subject = "Reset your Velro password";

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${subject}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f9fafb;
          }
          .container {
            background: #ffffff;
            border-radius: 8px;
            padding: 32px;
            border: 1px solid #e5e7eb;
          }
          .header {
            text-align: center;
            margin-bottom: 32px;
          }
          .logo {
            font-size: 32px;
            font-weight: bold;
            color: #111827;
            letter-spacing: -0.5px;
          }
          .content {
            margin-bottom: 32px;
          }
          .content h2 {
            color: #111827;
            font-size: 24px;
            margin-bottom: 16px;
          }
          .content p {
            color: #4b5563;
            margin-bottom: 12px;
          }
          .button {
            display: inline-block;
            background: #6366f1;
            color: white !important;
            padding: 14px 28px;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            font-size: 16px;
          }
          .button:hover {
            background: #4f46e5;
          }
          .button-container {
            text-align: center;
            margin: 32px 0;
          }
          .footer {
            text-align: center;
            color: #6b7280;
            font-size: 14px;
            margin-top: 32px;
            padding-top: 24px;
            border-top: 1px solid #e5e7eb;
          }
          .warning {
            background: #fef3c7;
            border-left: 4px solid #f59e0b;
            padding: 16px;
            margin: 24px 0;
            border-radius: 4px;
          }
          .warning strong {
            color: #92400e;
            display: block;
            margin-bottom: 4px;
          }
          .link-fallback {
            color: #6366f1;
            word-break: break-all;
            font-size: 13px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">🎬 Velro</div>
          </div>
          
          <div class="content">
            <h2>Reset Your Password</h2>
            <p>We received a request to reset your password for your Velro account.</p>
            <p>Click the button below to choose a new password:</p>
            
            <div class="button-container">
              <a href="${resetUrl}" class="button">Reset Password</a>
            </div>
            
            <div class="warning">
              <strong>⚠️ Security Notice</strong>
              This link will expire in 1 hour for security reasons.
            </div>
            
            <p>If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
          </div>
          
          <div class="footer">
            <p>
              If the button doesn't work, copy and paste this link into your browser:<br>
              <a href="${resetUrl}" class="link-fallback">${resetUrl}</a>
            </p>
            <p>© ${new Date().getFullYear()} Velro. All rights reserved.</p>
          </div>
        </div>
      </body>
    </html>
  `;

  const text = `
Reset Your Velro Password

We received a request to reset your password for your Velro account.

Click this link to reset your password:
${resetUrl}

⚠️ Security Notice: This link will expire in 1 hour.

If you didn't request a password reset, you can safely ignore this email.

---
© ${new Date().getFullYear()} Velro
  `;

  return sendEmail({
    to: email,
    subject,
    html,
    text,
  });
}
