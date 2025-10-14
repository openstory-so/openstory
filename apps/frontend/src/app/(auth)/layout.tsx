/**
 * Auth Layout
 * Layout for authentication pages (login, signup)
 */

import type { ReactNode } from "react";

interface AuthLayoutProps {
  children: ReactNode;
}

export default function AuthLayout({ children }: AuthLayoutProps) {
  return <div className="min-h-screen bg-background">{children}</div>;
}
