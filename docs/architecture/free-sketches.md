# Free sketches (#2390)

An organization with no funds gets three sequences free, as far as the
stitched dialogue cut. The aim: a newcomer watches a sketch of their film with
voices before they are asked for money.

## Who is free

`isUnfunded` (`src/billing/server/free-sketch.ts`): no available credit, no
usable fal key, no working auto top-up. It is the same test as the client's
`needsBillingSetup`. A funded organization has no free sketches left
(`freeSequencesLeft` answers 0), so topping up or adding a key ends free mode
for new sequences.

The count lives on `organization_billing_settings.free_sequences_used`, not on
the sequences, so a hard delete does not give a slot back. `claimFreeSequence`
is one guarded `UPDATE … WHERE free_sequences_used < 3`, so two racing creates
cannot both take the last slot. A create that throws before its trigger gives
the slot back (`releaseFreeSequence`). A failed run does not.

## What a free sketch runs

Decided in `createSequences`, the one create path behind the composer, the
public API, MCP and the assistant:

- stop at dialogue at most, no start frames, script up to 3,000 characters
  (`freeSketchRefusal` in `src/billing/free-sketch.ts`; a run outside these is
  refused with the reason, not trimmed);
- our models: `FREE_ANALYSIS_MODEL` and `FREE_IMAGE_MODEL` (the Turbo
  defaults), one analysis model only;
- reference-only, so the stills stage is skipped and the shot image is the
  storyboard sketch (`SHOT_PREVIEW_IMAGE_MODEL`);
- voices as the request asks, under the usual voice rules;
- no credit hold. Each charge finds no balance, skips, and is reported as
  `billing_skipped_deduction`. Those events are the measure of what a free
  sketch costs us.

`sequences.free_sketch` marks the sequence. Retrying a failed free sketch is
free up to dialogue. Continue, regenerate and anything past dialogue go
through the usual credit gate: that is where the account is asked to pay.

## Downloads

`listSequenceAssets` refuses a free sketch with a 402 while the organization
is unfunded. The asset page, `GET /api/v1/sequences/$id/assets`, MCP
`list_sequence_assets` and `openstory pull` all read through it.

## Not done

No farming defence (no card, device or platform cap). Revisit if free
accounts are made in bulk.
