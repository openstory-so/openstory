import type { Metadata } from "next";
import { AppLayout } from "@/components/layout";
import { Providers } from "@/components/providers";
import "./global.css";

export const metadata: Metadata = {
  title: "Velro - AI-Powered Video Sequence Creation",
  description:
    "Transform scripts into consistent, styled video productions using multiple AI models.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppLayout>{children}</AppLayout>
        </Providers>
      </body>
    </html>
  );
}
