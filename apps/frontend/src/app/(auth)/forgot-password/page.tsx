/**
 * Forgot Password Page
 * Allows users to request a password reset email
 */

"use client";

import Link from "next/link";
import { useState } from "react";
import { PageContainer } from "@/components/layout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const result = await authClient.forgetPassword({
        email,
        redirectTo: "/reset-password",
      });

      if (result.error) {
        setError(result.error.message || "Failed to send reset email");
        setIsLoading(false);
        return;
      }

      setSuccess(true);
    } catch (err) {
      console.error("[ForgotPassword] Error:", err);
      setError(
        err instanceof Error ? err.message : "Failed to send reset email",
      );
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <PageContainer>
        <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
          <div className="w-full max-w-md">
            <Card>
              <CardHeader>
                <CardTitle>Check Your Email</CardTitle>
                <CardDescription>
                  We've sent password reset instructions to your email
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Alert>
                  <AlertDescription>
                    If an account exists with <strong>{email}</strong>, you'll
                    receive an email with instructions to reset your password.
                  </AlertDescription>
                </Alert>

                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Didn't receive the email? Check your spam folder or{" "}
                    <button
                      type="button"
                      onClick={() => setSuccess(false)}
                      className="text-primary hover:underline font-medium"
                    >
                      try again
                    </button>
                    .
                  </p>
                </div>

                <div className="pt-4">
                  <Link
                    href="/login"
                    className="text-sm text-primary hover:underline"
                  >
                    ← Back to sign in
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center">
            <h1 className="text-3xl font-bold">Forgot Password</h1>
            <p className="mt-2 text-muted-foreground">
              Enter your email to receive password reset instructions
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Reset Password</CardTitle>
              <CardDescription>
                We'll send you an email with a link to reset your password
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <form onSubmit={handleSubmit}>
                <div className="space-y-2 mb-4">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isLoading}
                    required
                  />
                </div>

                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? "Sending..." : "Send Reset Link"}
                </Button>
              </form>

              <div className="text-center text-sm pt-4 border-t">
                <Link href="/login" className="text-primary hover:underline">
                  ← Back to sign in
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
