/**
 * BetterAuth configuration for OpenStory
 * Anonymous users + email OTP, passkeys, and Google social login (no passwords)
 */

import { generateId } from '@/lib/db/id';
import {
  account,
  apikey,
  deviceCode,
  passkey,
  session,
  user,
  verification,
} from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP, lastLoginMethod } from 'better-auth/plugins';
import { tanstackStartCookies } from 'better-auth/tanstack-start';

import { getDb } from '#db-client';
import { getEnv } from '#env';
import { teamMembers, teams } from '@/lib/db/schema';
import { SIGNUP_GRANT_MICROS } from '@/lib/billing/constants';
import { microsToDisplayUsd } from '@/lib/billing/money';
import { createBillingMethods } from '@/lib/db/scoped/billing';
import { sendOtpEmail } from '@/lib/services/email-service';
import {
  currentAuthCookiePrefix,
  lastUsedLoginMethodCookieName,
} from '@/lib/auth/cookie-prefix';
import { DEV_OTP_CODE } from '@/lib/auth/dev-otp';
import {
  isGoogleAuthConfigured,
  isLocalRequestHost,
} from '@/lib/utils/environment';
import { DEVICE_VERIFICATION_PATH } from '@/lib/api-v1/device-auth';
import { apiKey } from '@better-auth/api-key';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';
import { passkey as passkeyPlugin } from '@better-auth/passkey';

import { captureProductEvent } from '@/lib/observability/product-events';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'auth', 'config']);
const betterAuthLogger = getLogger(['openstory', 'auth', 'better-auth']);

/**
 * Fixed sign-in OTP for local development, so signing in doesn't require
 * copying the code out of the simulated-email console log (the login form
 * also auto-completes with it — see src/components/auth/auth-form.tsx).
 *
 * Gated belt-and-braces, same posture as `testOnlyGuard` on the /api/test
 * routes — both gates must pass or the default random generator is used:
 *
 *  1. `import.meta.env.DEV` — build-time gate. Only `vite dev` (`bun dev`,
 *     e2e webServer) sets it; every deployed artifact is a build, where Vite
 *     define-replaces it with `false` and eliminates the branch entirely, so
 *     the bypass cannot leak into a deployed Worker. (The runtime
 *     `NODE_ENV` isn't declared in the worker env blocks, so it can't serve
 *     as this gate.)
 *  2. `isLocalRequestHost()` — runtime backstop that cannot be flipped by
 *     env: the request must arrive on localhost or a bare IP. Fails closed
 *     when there is no request context.
 *
 * Opt out by setting `EMAIL_FROM` in `.env.local` — that var exists solely to
 * address OTP emails, so setting it means "I want the real email-OTP flow":
 * a random code per sign-in, delivered via the SEND_EMAIL binding (simulated
 * locally — the code lands in the dev console — unless the binding is flipped
 * to `"remote": true` in wrangler.jsonc). The login form asks the server
 * which mode is active (getAuthOptionsFn) to show a dev note and skip
 * the auto-sign-in when the real flow is on.
 */
export function isDevFixedOtpActive(request: Request | undefined): boolean {
  if (!import.meta.env.DEV) return false;
  if (getEnv().EMAIL_FROM) return false;
  if (!request || !isLocalRequestHost(request)) return false;
  return true;
}

function devFixedOtp(request: Request | undefined): string | undefined {
  if (!isDevFixedOtpActive(request)) return undefined;
  logger.info(`[dev] Sign-in OTP is fixed to ${DEV_OTP_CODE}`);
  return DEV_OTP_CODE;
}

// Singleton auth instance cache
let _authInstance: ReturnType<typeof createAuth> | undefined;

/**
 * Create Better Auth instance
 * Separated for type inference - the return type is used for the singleton cache
 */
/** `db` is injectable only for `bun auth:generate` (schema generation never queries). */
export function createAuth(db: ReturnType<typeof getDb> = getDb()) {
  const runtimeEnv = getEnv();
  const cookiePrefix = currentAuthCookiePrefix();

  return betterAuth({
    // Route Better Auth's own logs through LogTape so they land in the same
    // sink as the rest of the app (PostHog via Cloudflare destination, with
    // category `openstory.auth.better-auth`).
    logger: {
      level: 'warn',
      log: (level, message, ...args) => {
        const props = args.length > 0 ? { args } : {};
        switch (level) {
          case 'error':
            betterAuthLogger.error(message, props);
            break;
          case 'warn':
            betterAuthLogger.warn(message, props);
            break;
          case 'info':
            betterAuthLogger.info(message, props);
            break;
          default:
            betterAuthLogger.debug(message, props);
        }
      },
    },
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: user,
        session: session,
        account: account,
        verification: verification,
        passkey: passkey,
        apikey: apikey,
        deviceCode: deviceCode,
      },
    }),
    secret: runtimeEnv.BETTER_AUTH_SECRET,
    trustedOrigins: [
      'http://localhost:*',
      'http://192.168.*:*',
      'http://100.*:*',
    ],

    // Session configuration
    // SECURITY: 90-day expiration mitigates:
    // - Session fixation attacks
    // - Database bloat from long-lived sessions
    // - GDPR compliance concerns
    session: {
      expiresIn: 60 * 60 * 24 * 90, // 90 days
      updateAge: 60 * 60 * 24, // Update session daily
    },

    // Account linking configuration
    // Allows users to link multiple authentication methods to one account
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'email-otp'],
        allowDifferentEmails: false, // Only link accounts with matching emails
      },
    },

    // Social providers — Google only when its secrets are configured
    // (isGoogleAuthConfigured is also what hides the login form's Google
    // button, via getAuthOptionsFn). Unconfigured environments (local
    // dev by default, PR previews) don't register the provider at all.
    socialProviders: isGoogleAuthConfigured()
      ? {
          google: {
            clientId: runtimeEnv.GOOGLE_CLIENT_ID,
            clientSecret: runtimeEnv.GOOGLE_CLIENT_SECRET,
            enabled: true,
            overrideUserInfoOnSignIn: true,
          },
        }
      : {},

    // Configure plugins
    plugins: [
      // Email OTP authentication (passwordless)
      emailOTP({
        otpLength: 6,
        expiresIn: 300, // 5 minutes
        // Dev-only fixed code (see devFixedOtp above). Returning undefined
        // falls back to better-auth's default random generator.
        generateOTP: (_data, ctx) => devFixedOtp(ctx?.request),
        async sendVerificationOTP({ email, otp, type }) {
          if (type === 'sign-in') {
            logger.info('Sending sign-in OTP', { email });
            const result = await sendOtpEmail(email, otp);
            if (!result.success) {
              logger.error('Failed to send OTP:', { data: result.error });
              throw new Error('Failed to send verification code');
            }
            logger.info('OTP sent successfully');
          }
        },
      }),
      lastLoginMethod({
        cookieName: lastUsedLoginMethodCookieName(cookiePrefix),
      }),
      passkeyPlugin(),
      // Device-code login for the public API (#1219, RFC 8628). The plugin
      // owns the code lifecycle; `src/lib/api-v1/device-auth.ts` wraps it to
      // hand back an API key instead of a session.
      deviceAuthorization({
        expiresIn: '10m',
        interval: '5s',
        // Must be absolute: the plugin resolves a relative URI against
        // `baseURL`, which we leave request-derived (unset) — and server-side
        // `auth.api.*` calls have no request. The /api/v1 wrapper re-derives
        // the URL from the live request origin anyway (previews, local ports).
        verificationUri: new URL(
          DEVICE_VERIFICATION_PATH,
          runtimeEnv.VITE_APP_URL || 'http://localhost:3000'
        ).toString(),
      }),
      // Public-API authentication. `enableSessionForAPIKeys` makes the plugin
      // resolve a full session for the key's owner whenever a request carries a
      // key header — so the existing `getSession`/`requireUser` path works
      // transparently for `/api/v1/*` without any bespoke key-hashing. Keys are
      // prefixed `osk_` (OpenStory Key) and resolve to the creating user via
      // `referenceId`; the team is derived downstream via `resolveUserTeam`.
      apiKey({
        enableSessionForAPIKeys: true,
        defaultKeyLength: 64,
        // Per-key rate limit: 10 requests/second. Enforced on every `/api/v1`
        // request (via the session-from-key validation), stored per key. This
        // is the abuse throttle, sized to comfortably allow normal create +
        // status-poll traffic (incl. parallel per-sequence polls); per-team
        // *cost* is separately bounded by the credit pre-flight in
        // `createSequences`.
        rateLimit: {
          enabled: true,
          maxRequests: 10,
          timeWindow: 1000,
        },
        // Accept either `x-api-key: <key>` or the conventional
        // `Authorization: Bearer <key>` header.
        customAPIKeyGetter: (ctx) => {
          const authHeader = ctx.headers?.get('authorization');
          if (authHeader?.startsWith('Bearer ')) {
            return authHeader.slice('Bearer '.length).trim();
          }
          return ctx.headers?.get('x-api-key') ?? null;
        },
      }),
      // TanStack Start cookie integration - must be after all plugins that set cookies
      // (emailOTP, passkey, lastLoginMethod)
      tanstackStartCookies(),
    ],

    // Custom user fields to match existing schema, This is BetterAuth user table.
    user: {
      additionalFields: {
        status: {
          type: 'string',
          required: false,
          defaultValue: 'active' as const,
        },
      },
    },

    // Create a default team when a new user signs up
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const db = getDb();
            const teamName = user.name
              ? `${user.name}'s Team`
              : `Team ${user.id.slice(0, 8)}`;
            const teamSlug = `team-${user.id.slice(0, 8)}`;

            const [team] = await db
              .insert(teams)
              .values({ name: teamName, slug: teamSlug })
              .returning();

            if (!team) {
              throw new Error(
                `Failed to create default team for user ${user.id}`
              );
            }

            await db.insert(teamMembers).values({
              teamId: team.id,
              userId: user.id,
              role: 'owner',
            });

            // Grant every new team a one-time welcome credit (#1047; preflight fixed in #1062).
            await createBillingMethods(db, team.id, user.id).addCredits(
              SIGNUP_GRANT_MICROS,
              {
                type: 'credit_adjustment',
                description: `Welcome credit: ${microsToDisplayUsd(SIGNUP_GRANT_MICROS)}`,
                metadata: { signupGrant: true },
              }
            );

            // First-time account only — drives #product-alerts via PostHog (#1088).
            // personProperties set email/name on the PostHog person so Slack
            // templates (`person.properties.email ?? distinct_id`) show email,
            // not only the ULID (#1110).
            captureProductEvent({
              distinctId: user.id,
              event: 'user_signed_up',
              properties: {
                email: user.email,
                name: user.name,
                team_id: team.id,
              },
              personProperties: {
                email: user.email,
                name: user.name,
              },
            });
          },
        },
      },
      // Real session rows only (API-key auth uses an in-memory session and
      // does not hit this hook). Covers email OTP, Google, and passkeys.
      session: {
        create: {
          after: async (session, context) => {
            // Identify by email so checkout attempters are not anonymous
            // in PostHog (#1466). Lookup is best-effort — a miss must not
            // fail session create.
            let personProperties: Record<string, unknown> | undefined;
            try {
              const db = getDb();
              const [signedInUser] = await db
                .select({ email: user.email, name: user.name })
                .from(user)
                .where(eq(user.id, session.userId))
                .limit(1);
              if (signedInUser) {
                personProperties = {
                  email: signedInUser.email,
                  name: signedInUser.name,
                };
              }
            } catch (err) {
              logger.error('Failed to load user for user_signed_in identify', {
                err,
                userId: session.userId,
              });
            }
            captureProductEvent({
              distinctId: session.userId,
              event: 'user_signed_in',
              properties: {
                path: context?.path,
                ...personProperties,
              },
              personProperties,
            });
          },
        },
      },
    },

    // Advanced configuration
    advanced: {
      // Local worktrees share the localhost cookie jar across ports (#1288).
      // Vite injects a per-cwd prefix in `vite serve`; production keeps
      // Better Auth's default so existing sessions survive deploys.
      cookiePrefix,
      database: {
        // Generate ULID for user IDs (time-ordered, better performance)
        generateId: () => generateId(),
      },
    },
  });
}

/**
 * Get or create Better Auth instance (singleton)
 * Compatible with Cloudflare Workers where env is request-scoped
 */
export function getAuth() {
  return (_authInstance ??= createAuth());
}
// Type inference for the auth instance with custom fields
export type Auth = ReturnType<typeof getAuth>;
export type Session = ReturnType<typeof getAuth>['$Infer']['Session'];
export type User = ReturnType<typeof getAuth>['$Infer']['Session']['user'];
