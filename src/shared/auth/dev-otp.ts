/**
 * Fixed sign-in OTP for local development.
 *
 * In `vite dev` (`bun dev`) the server's emailOTP `generateOTP` hook emits
 * this constant instead of a random code (gated on `import.meta.env.DEV` +
 * `isLocalRequestHost` — see src/lib/auth/config.ts), and the login form
 * auto-completes sign-in with it so no code is typed at all. Both the server
 * gate and the client auto-submit are eliminated from production builds, where
 * `import.meta.env.DEV` is define-replaced with `false`.
 *
 * Same value the e2e backdoor forges (/api/test/verify), so the manual code
 * path keeps working too.
 */
export const DEV_OTP_CODE = '123456';
