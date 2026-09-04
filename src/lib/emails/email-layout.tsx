/**
 * Shared layout for transactional emails.
 *
 * Server-only: these components are rendered to static HTML by
 * email-service.tsx — they must never be imported from client code.
 *
 * Styles are inline `style={{}}` objects, not `<Tailwind>`. Gmail strips
 * `<style>` blocks, and the Tailwind compiler is the bulk of
 * `@react-email/components` at Worker startup (#1414).
 */

import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from '@react-email/components';

/**
 * App dark-mode palette, transcribed from `src/styles/global.css` `:root`
 * oklch tokens into hex. Every Text/Body/Container sets colour explicitly —
 * Gmail does not inherit, and there is no `prefers-color-scheme`.
 */
const emailColors = {
  foreground: '#fafafa',
  card: '#171717',
  muted: '#2e2e2e',
  mutedForeground: '#a3a3a3',
  border: '#2e2e2e',
  canvas: '#0a0a0a',
} as const;

const fontSans = 'Arial, Helvetica, sans-serif';

/** Shared text styles for template content. */
export const headingStyle: React.CSSProperties = {
  marginTop: 0,
  marginBottom: 16,
  fontSize: 24,
  fontWeight: 700,
  lineHeight: '32px',
  color: emailColors.foreground,
};

export const paragraphStyle: React.CSSProperties = {
  marginTop: 0,
  marginBottom: 12,
  fontSize: 16,
  lineHeight: '24px',
  color: emailColors.mutedForeground,
};

export const detailRowStyle: React.CSSProperties = {
  marginTop: 0,
  marginBottom: 0,
  fontSize: 14,
  lineHeight: '24px',
  color: emailColors.foreground,
};

/** Grey info panel used for OTP, details, and quoted messages. */
export const mutedBoxStyle: React.CSSProperties = {
  marginTop: 24,
  marginBottom: 24,
  borderRadius: 8,
  backgroundColor: emailColors.muted,
  padding: 24,
};

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

const bodyStyle: React.CSSProperties = {
  marginLeft: 'auto',
  marginRight: 'auto',
  backgroundColor: emailColors.canvas,
  padding: 20,
  fontFamily: fontSans,
  color: emailColors.foreground,
};

const containerStyle: React.CSSProperties = {
  maxWidth: 600,
  borderRadius: 8,
  border: `1px solid ${emailColors.border}`,
  backgroundColor: emailColors.card,
  padding: 32,
};

const logoSectionStyle: React.CSSProperties = {
  marginBottom: 32,
  textAlign: 'center',
};

const logoStyle: React.CSSProperties = {
  marginLeft: 'auto',
  marginRight: 'auto',
};

const footerSectionStyle: React.CSSProperties = {
  marginTop: 32,
  borderWidth: 0,
  borderTopWidth: 1,
  borderStyle: 'solid',
  borderColor: emailColors.border,
  paddingTop: 24,
  textAlign: 'center',
};

const footerTextStyle: React.CSSProperties = {
  marginTop: 0,
  marginBottom: 0,
  fontSize: 14,
  lineHeight: '24px',
  color: emailColors.mutedForeground,
};

const footerNoteStyle: React.CSSProperties = {
  ...footerTextStyle,
  marginBottom: 8,
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
    <Body style={bodyStyle}>
      <Container style={containerStyle}>
        <Section style={logoSectionStyle}>
          {/* Inline SVG is stripped by most email clients, so the wordmark
              ships as a hosted PNG. alt covers blocked-image clients. */}
          <Img
            src={LOGO_URL}
            width="183"
            height="40"
            alt={appName}
            style={logoStyle}
          />
        </Section>
        {children}
        <Section style={footerSectionStyle}>
          {footerNote ? (
            <Text style={footerNoteStyle}>{footerNote}</Text>
          ) : null}
          <Text style={footerTextStyle}>
            © {new Date().getFullYear()} {appName}. All rights reserved.
          </Text>
        </Section>
      </Container>
    </Body>
  </Html>
);

interface WarningBoxProps {
  title: string;
  children: React.ReactNode;
}

const warningBoxStyle: React.CSSProperties = {
  marginTop: 24,
  marginBottom: 24,
  borderRadius: 4,
  // Emails get no CSS reset, so a lone `borderLeft` would still show
  // default-width borders on the other sides.
  borderWidth: 0,
  borderLeftWidth: 4,
  borderStyle: 'solid',
  borderColor: '#f59e0b',
  backgroundColor: '#451a03',
  padding: 16,
};

const warningTitleStyle: React.CSSProperties = {
  marginTop: 0,
  marginBottom: 4,
  fontSize: 14,
  fontWeight: 700,
  lineHeight: '24px',
  color: '#fde68a',
};

const warningBodyStyle: React.CSSProperties = {
  marginTop: 0,
  marginBottom: 0,
  fontSize: 14,
  lineHeight: '24px',
  color: '#fde68a',
};

export const WarningBox: React.FC<WarningBoxProps> = ({ title, children }) => (
  <Section style={warningBoxStyle}>
    <Text style={warningTitleStyle}>{title}</Text>
    <Text style={warningBodyStyle}>{children}</Text>
  </Section>
);
