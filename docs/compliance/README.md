# Platform compliance capabilities

What OpenStory can demonstrate when a model provider asks whether we are fit to
serve their models to external users, and where each capability lives in the
code. Operational procedure is in
[`incident-response.md`](./incident-response.md).

This exists because provider activation questionnaires (BytePlus/ModelArk being
the immediate case) ask four things, and each answer needs to point at something
real.

---

## 1. Traceability and deepfake prevention

> _Do you have security mechanisms and emergency response plans for tracing
> AI-generated content and preventing deepfakes?_

**Tracing.** Every instrumented generation writes a `content_provenance` row at
the moment its asset lands in R2: team, user, provider, model, provider request
id, prompt hash, reference-image count, workflow run id, and storage key. The
row's ULID is the public trace id (`OS-…`) quoted in takedown correspondence.
A `contentSha256` column exists for byte-level matching but is **not populated
yet** — see "What provenance deliberately does not store" in the response plan.

Lookup is **Admin → Moderation → Trace content**, which resolves a trace id, an
asset URL or R2 key, a content hash (once populated), or the provider's request
id back to the account that produced it.

- Schema: `src/lib/db/schema/compliance.ts`
- Recording: `src/lib/compliance/provenance.ts`, called from every workflow
  that writes a generated object to R2 (stills, grids, upscales, motion,
  sheets, music, direct model access, sequence export)
- Lookup: `src/functions/moderation.ts` → `traceContentFn`

User-uploaded reference photos are not provenance — they are warrants in
`upload_attestations`. Assets generated before this shipped have no
provenance row and must be traced through the sequence graph. See
"Coverage limits" in the incident-response plan.

**Deepfake prevention** is layered, because no single control is sufficient:

1. Terms prohibit generating or uploading a real person's likeness without
   written authorization covering AI generation.
2. A portrait-rights attestation is required at the upload surface where a
   likeness can enter (`upload_attestations`), recording the exact wording
   agreed to, the declared basis for authorization, and request context.
3. Provider content filters reject prohibited output; rejections are logged and
   queryable (`src/lib/ai/content-rejection.ts`).
4. Reported content is traced and the responsible account restricted.

**Emergency response plan:** [`incident-response.md`](./incident-response.md),
with a P0/P1/P2 severity ladder and CSAM-specific escalation including evidence
preservation and authority referral. Operational first-response targets are
available to model providers and authorities on request.

---

## 2. Portrait authorization and liability

> _Are you aware that uploading any personal portrait requires legal
> authorization from the subject, and that you bear full liability without it?_

Yes, and the obligation is passed through to the uploader in a recorded form
rather than only asserted in a policy document:

- **Terms** (`/terms` § Acceptable Use) prohibit uploading or generating from any
  image, video, or voice of a real identifiable person without their written
  authorization covering AI generation, and place responsibility for holding that
  authorization on the user.
- **At the point of upload**, attaching reference media to a talent record
  requires ticking the portrait-rights statement and naming the basis for the
  authorization. Stored in `upload_attestations` with a SHA-256 of the exact
  statement text shown, so a 2026 attestation cannot be misread against wording
  shipped later.
- **Statement text** is versioned and single-sourced in
  `src/lib/compliance/attestations.ts`. Editing a statement in place is
  prohibited (it would invalidate every stored hash); a test pins this.

---

## 3. Use model: internal vs tool platform

> _Is your use for internal production, or for integration into a tool
> platform?_

**Tool platform.** OpenStory serves external users, which is what makes items 1
and 4 obligations rather than good practice. The capabilities in this document
are built on that basis.

---

## 4. Real-name authentication and violation handling

> _Have you established a real-name authentication mechanism and a
> violation-handling capability for end users?_

**Real-name authentication** (overseas tool platform, confirmed with BytePlus
GTM 2026-08-13): users are email-authenticated; paying teams have a card on
file via Stripe (cardholder name + last 4). We do **not** collect government
IDs or run liveness checks.

**Violation handling.** End-to-end, not just a policy:

1. **Intake** — public `/report` form (no account needed) plus email; `csam`
   reports are forced to top priority at intake regardless of reporter input.
2. **Triage** — Admin → Moderation → Reports, worst-first then oldest-first,
   with per-account grouping and resolution notes.
3. **Trace** — resolve reported content to the responsible account.
4. **Act** — five graduated enforcement actions from `warning` through
   `account_terminated`, recorded in `enforcement_actions` with actor, reason,
   optional expiry, and revocation.
5. **Enforce** — the gate in `triggerWorkflow` blocks restricted accounts from
   starting durable work. Talent uploads require a server-recorded warrant
   (`requireUploadAttestation`) — portrait + basis for humans, asset statement
   for animated/other — not only the dialog checkbox.
6. **Notify and appeal** — `ComplianceRestrictionBanner` shows the restriction
   notice and links to `/report`. If `ABUSE_REPORT_NOTIFY_EMAIL` is set, intake
   emails the operator (and fails the request if the send fails). A successful
   appeal revokes without erasing.

---

## Configuration

All optional; resolved in one place (`src/lib/compliance/config.ts`) and
documented in `.env.example`.

| Variable                    | Purpose                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| `ABUSE_REPORT_NOTIFY_EMAIL` | Where report notifications go. Unset ⇒ queue-only. Set ⇒ send on intake. |

---

## Before answering a questionnaire "yes"

Honest status of each claim, so nobody over-promises on the strength of this
document:

- ✅ Traceability infrastructure, lookup console, and response plan — built and
  tested. Uploads and assets generated before provenance shipped are the
  remaining coverage limits, documented above.
- ✅ Portrait attestation, terms, and liability pass-through — built.
- ✅ Real-name authentication as accepted by BytePlus: email login + card on
  file. No government-ID flow.
- ✅ Report intake, triage, enforcement, and the generation gate — built.
- ⚠️ **Operational, not code:** someone must actually watch the queue;
  `ABUSE_REPORT_NOTIFY_EMAIL` should be set and routed to a monitored inbox; an
  `abuse@` alias should exist. First-response targets are not published here.
- ⚠️ **Not legal advice.** These representations are binding and carry
  liability. Have counsel review before signing, particularly the ownership and
  indemnity declarations for custom avatar assets.
