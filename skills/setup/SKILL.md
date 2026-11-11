---
name: setup
description: >
  Sign in to OpenStory, confirm the team, and start a first sequence.
  Use when the user just installed OpenStory, asks to sign in, pick a
  team, or run setup. Not for editing an existing sequence
  (create-sequence) or minting a style (create-style).
---

# Setup

Confirm which OpenStory team this install is signed in as, then hand off.

## Sign in

When this session has OpenStory MCP tools, call `whoami`.

Done when the reply names the user and team from that result.

When `whoami` is absent, follow the Auth section of `create-sequence`. Do not start a second login flow from this skill.

## Team

The team on `whoami` is the team later calls use. A different team is switched in OpenStory, then `whoami` again. Do not invent a team id.

Done when the user accepts that team, or a later `whoami` shows the team they named.

## Next

A video follows `create-sequence`. A library style follows `create-style`. Stop after the team is confirmed when they did not ask for either.
