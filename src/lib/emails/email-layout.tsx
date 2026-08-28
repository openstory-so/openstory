/**
 * Shared layout for transactional emails.
 *
 * Server-only: these components are rendered to static HTML by
 * email-service.tsx via @react-email/render — they must never be imported
 * from client code. Styling uses react-email's <Tailwind> wrapper, which
 * compiles the utility classes to inline styles at render time (email
 * clients — Gmail in particular — strip <style> blocks).
 */

import {
  Body,
  Container,
  Head,
  Html,
  Img,
  pixelBasedPreset,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';

/**
 * App dark-mode palette, transcribed from `src/styles/global.css` `:root`
 * oklch tokens into hex. React-email inlines these at render time — Gmail
 * strips `<style>`, so every Text/Body/Container must set colour explicitly
 * (no inheritance, no `prefers-color-scheme`).
 */
const emailColors = {
  background: '#171717',
  foreground: '#fafafa',
  card: '#171717',
  muted: '#2e2e2e',
  mutedForeground: '#a3a3a3',
  border: '#2e2e2e',
  primary: '#fafafa',
  primaryForeground: '#262626',
  canvas: '#0a0a0a',
} as const;

/** Shared text styles for template content. */
export const headingClass = 'mt-0 mb-4 text-2xl font-bold text-foreground';
export const paragraphClass =
  'mt-0 mb-3 text-base leading-6 text-muted-foreground';
export const detailRowClass = 'm-0 text-sm leading-6 text-foreground';

// Emails can't bundle assets and outlive any single deployment, so the logo
// is served from the stable public-assets domain (same fallback pattern as
// src/lib/marketing/constants.ts). Source image is 1146x250. Dark-ground
// wordmark (light type) — the app defaults to dark (#1188, #1276).
const ASSETS_DOMAIN =
  import.meta.env.VITE_R2_PUBLIC_ASSETS_DOMAIN || 'assets.openstory.so';
const LOGO_URL = `https://${ASSETS_DOMAIN}/brand/openstory-logo-dark.png`;

interface EmailLayoutProps {
  appName: string;
  /** Inbox preview snippet shown next to the subject line. */
  preview: string;
  children: React.ReactNode;
  /** Extra footer line (e.g. "Reply to this email"). */
  footerNote?: string;
}

const tailwindConfig = {
  presets: [pixelBasedPreset],
  theme: {
    extend: {
      colors: {
        background: emailColors.background,
        foreground: emailColors.foreground,
        card: emailColors.card,
        muted: emailColors.muted,
        'muted-foreground': emailColors.mutedForeground,
        border: emailColors.border,
        primary: emailColors.primary,
        'primary-foreground': emailColors.primaryForeground,
        canvas: emailColors.canvas,
      },
    },
  },
};

export const EmailLayout: React.FC<EmailLayoutProps> = ({
  appName,
  preview,
  children,
  footerNote,
}) => (
  <Html>
    <Head />
    <Preview>{preview}</Preview>
    <Tailwind config={tailwindConfig}>
      <Body className="mx-auto bg-canvas p-5 font-sans text-foreground">
        <Container className="max-w-[600px] rounded-lg border border-solid border-border bg-card p-8">
          <Section className="mb-8 text-center">
            {/* Inline SVG is stripped by most email clients, so the wordmark
                ships as a hosted PNG. alt covers blocked-image clients. */}
            <Img
              src={LOGO_URL}
              width="183"
              height="40"
              alt={appName}
              className="mx-auto"
            />
          </Section>
          {children}
          <Section className="mt-8 border-0 border-t border-solid border-border pt-6 text-center">
            {footerNote ? (
              <Text className="m-0 mb-2 text-sm leading-6 text-muted-foreground">
                {footerNote}
              </Text>
            ) : null}
            <Text className="m-0 text-sm leading-6 text-muted-foreground">
              © {new Date().getFullYear()} {appName}. All rights reserved.
            </Text>
          </Section>
        </Container>
      </Body>
    </Tailwind>
  </Html>
);

interface WarningBoxProps {
  title: string;
  children: React.ReactNode;
}

export const WarningBox: React.FC<WarningBoxProps> = ({ title, children }) => (
  // border-0 first: emails get no CSS reset, so `border-solid` alone would
  // surface default-width borders on all sides.
  <Section className="my-6 rounded border-0 border-l-4 border-solid border-amber-500 bg-amber-950 p-4">
    <Text className="m-0 mb-1 text-sm font-bold leading-6 text-amber-200">
      {title}
    </Text>
    <Text className="m-0 text-sm leading-6 text-amber-200">{children}</Text>
  </Section>
);
