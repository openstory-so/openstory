---
title: Settings
description: Configure API keys, passkeys, and account settings
section: User Guide
order: 11
---

Access settings from the user menu in the header. Settings are organized into sections:

## API Keys

Manage your BYOK (Bring Your Own Key) credentials. See [Credits & Billing](/docs/user-guide/credits-and-billing) for details on:

- Fal.ai API key for media generation
- OpenRouter API key or OAuth for LLM access

After connecting via OpenRouter OAuth, the settings page shows a success message. If there's an error, the error details are displayed.

## Developer

Keys and grants for programmatic access to your account.

- **API access** — Create `osk_` keys for the [public API](/docs/developer-guide/public-api). The secret is shown once, on creation. Keys minted by a device-code login (an agent or CLI showing you a short code) appear here too and can be revoked the same way.
- **Authorized apps** — Apps and agents you have signed in to with your OpenStory account: hosted MCP clients such as Claude or Cursor, or a fork of OpenStory that offers "Connect OpenStory". Each entry shows the app, where it sends you back, and what you approved. **Revoke** stops new tokens immediately; an access token already issued can keep working for up to an hour. The app has to ask you to sign in again.

When an app asks for access you land on the **Authorize app** page. It names the app, where it will send you back to, and what it is asking for. Only approve requests you started yourself — `localhost` is normal for a fork or a CLI running on your own machine, but an unfamiliar name or address is a reason to deny.

## Passkeys

Manage passwordless authentication via passkeys (WebAuthn). You can:

- **Register new passkeys** — Add hardware keys or biometric authentication
- **View registered passkeys** — See all your registered devices
- **Remove passkeys** — Deregister devices you no longer use

Passkeys provide a secure, passwordless login experience.

## Generation Settings Persistence

While not in the settings page itself, your generation preferences (aspect ratio, selected models, auto-generation toggles) are automatically saved to localStorage. When you create a new sequence, your last-used settings are pre-filled.
