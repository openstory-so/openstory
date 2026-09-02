import { describe, expect, it } from 'vitest';
import { buildAuthorizationUrl } from './openrouter-oauth';

const CALLBACK_URL = 'https://app.example.com/api/openrouter/callback';
const TEAM_ID = '01JTEAM00000000000000000000';
const USER_ID = '01JUSER00000000000000000000';

describe('buildAuthorizationUrl', () => {
  it('builds an S256 PKCE authorize URL', async () => {
    const { url } = await buildAuthorizationUrl(CALLBACK_URL, TEAM_ID, USER_ID);
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe('https://openrouter.ai/auth');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('threads the CSRF state through the callback_url query', async () => {
    const { url, state } = await buildAuthorizationUrl(
      CALLBACK_URL,
      TEAM_ID,
      USER_ID
    );
    const callbackUrl = new URL(url).searchParams.get('callback_url');
    expect(callbackUrl).toBeTruthy();
    if (!callbackUrl) return;

    const callback = new URL(callbackUrl);
    expect(callback.origin + callback.pathname).toBe(CALLBACK_URL);
    expect(callback.searchParams.get('state')).toBe(state.csrfState);
    expect(state.csrfState.length).toBeGreaterThanOrEqual(43);
  });

  it('returns the full state for the cookie', async () => {
    const { state } = await buildAuthorizationUrl(
      CALLBACK_URL,
      TEAM_ID,
      USER_ID
    );

    expect(state.teamId).toBe(TEAM_ID);
    expect(state.userId).toBe(USER_ID);
    expect(state.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(state.codeVerifier).not.toBe(state.csrfState);
  });
});
