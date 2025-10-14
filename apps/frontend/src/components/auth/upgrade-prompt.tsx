/**
 * User Upgrade Prompt
 * Encourages anonymous users to save their work by creating an account
 */

"use client";

import { usePathname } from "next/navigation";
import type React from "react";
import { useState } from "react";
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
import { useUser } from "@/hooks/use-user";
import { authClient } from "@/lib/auth/client";

interface UpgradePromptProps {
  title?: string;
  description?: string;
  onUpgradeStart?: () => void;
  onUpgradeComplete?: () => void;
}

export function UpgradePrompt({
  title = "Save Your Work",
  description = "Create an account to save your sequences and continue working on them later.",
  onUpgradeStart,
  onUpgradeComplete,
}: UpgradePromptProps) {
  const { data: userData } = useUser();
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<"google" | "email">("google");
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Don't show for authenticated users
  if (!userData?.isAnonymous) {
    return null;
  }

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    setError(null);
    onUpgradeStart?.();

    try {
      // Stay on current page after upgrade
      await authClient.signIn.social({
        provider: "google",
        callbackURL: pathname,
      });
      onUpgradeComplete?.();
    } catch (err) {
      console.error("Google sign-in error:", err);
      setError(
        err instanceof Error ? err.message : "Failed to sign in with Google",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmailSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    onUpgradeStart?.();

    try {
      const fullName = (userData?.user as { full_name?: string })?.full_name;
      await authClient.signUp.email({
        email,
        password,
        name: fullName || "User",
      });
      onUpgradeComplete?.();
    } catch (err) {
      console.error("Email sign-up error:", err);
      setError(err instanceof Error ? err.message : "Failed to create account");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Simple tab switcher */}
        <div className="flex gap-2 mb-4">
          <Button
            variant={activeTab === "google" ? "default" : "outline"}
            onClick={() => setActiveTab("google")}
            className="flex-1"
          >
            Google
          </Button>
          <Button
            variant={activeTab === "email" ? "default" : "outline"}
            onClick={() => setActiveTab("email")}
            className="flex-1"
          >
            Email
          </Button>
        </div>

        {/* Google sign-in */}
        {activeTab === "google" && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Use your Google account to save your work instantly.
            </p>
            <Button
              onClick={handleGoogleSignIn}
              disabled={isLoading}
              className="w-full"
              variant="outline"
            >
              {isLoading ? "Signing in..." : "Continue with Google"}
            </Button>
          </div>
        )}

        {/* Email sign-up */}
        {activeTab === "email" && (
          <form onSubmit={handleEmailSignUp} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Create a password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
                required
                minLength={8}
              />
            </div>

            <Button
              type="submit"
              disabled={isLoading || !email || !password}
              className="w-full"
            >
              {isLoading ? "Creating Account..." : "Create Account"}
            </Button>
          </form>
        )}

        {error && (
          <div className="text-sm text-red-600 text-center p-2 bg-red-50 rounded">
            <p>{error}</p>
          </div>
        )}

        <div className="text-xs text-gray-500 text-center">
          <p>
            Your anonymous work will be automatically saved to your new account.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Inline upgrade banner for anonymous users
 */
export function UpgradeBanner() {
  const { data: userData } = useUser();
  const [showPrompt, setShowPrompt] = useState(false);

  if (!userData?.isAnonymous) {
    return null;
  }

  if (showPrompt) {
    return (
      <div className="mb-6">
        <UpgradePrompt onUpgradeComplete={() => setShowPrompt(false)} />
      </div>
    );
  }

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <h3 className="text-sm font-medium text-blue-900">
            You're working anonymously
          </h3>
          <p className="text-sm text-blue-700 mt-1">
            Create an account to save your sequences and access them from any
            device.
          </p>
        </div>
        <div className="ml-4">
          <Button
            size="sm"
            variant="default"
            onClick={() => setShowPrompt(true)}
          >
            Save Work
          </Button>
        </div>
      </div>
    </div>
  );
}
