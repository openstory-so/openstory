# Spike #1551 — does Seedance 2.5 lip-sync to reference audio on Ark?

**Answer: yes.** Run 2026-09-09 against the production BytePlus Ark account,
model `dreamina-seedance-2-5-260628`, region `ap-southeast`. Raw
`POST /api/v3/contents/generations/tasks` — no app code was written or changed
for this spike, so nothing here is load-bearing on OpenStory's own request
builder.

Everything the Voice Consistency milestone assumed holds, with three
qualifications that change the shape of #1555 and are called out below.

## What was run

Dialogue was generated with ElevenLabs (through fal's
`fal-ai/elevenlabs/tts/eleven-v3`, voices Charlotte / George); stills with
`fal-ai/flux/schnell`; both handed to Ark as plain public `fal.media` URLs.
Output audio was transcribed back with `fal-ai/whisper` to compare against the
supplied lines.

| #   | Test                                                           | Result                                                                    |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | One line, `@Image1` + `@Audio1`, prompt `@Image1 says @Audio1` | Succeeded — lip-synced, dialogue verbatim                                 |
| 2   | 6 lines, 2 characters, 21 s, 2 images + 6 audio files          | Succeeded — all 6 lines in order, shot/reverse-shot cut to whoever speaks |
| 3   | Audio as the only reference, no image                          | Succeeded — invented a speaker and lip-synced them                        |
| 4   | Is 2.5 activated on the production account?                    | Yes — no `ModelNotOpen`; all four tasks ran                               |

Samples (fal storage, durable):

- Test 1 — https://v3b.fal.media/files/b/0aa9b39f/mog31s8DyAnaRFt3jRcn1_1551-test1.mp4
- Test 2 — https://v3b.fal.media/files/b/0aa9b3a1/IW56vte6HqummOh3DQGWg_1551-test2_scene.mp4
- Test 3 — https://v3b.fal.media/files/b/0aa9b3a9/YnIawIjRf-U4uk1j1ZS6R_1551-test3_audioonly.mp4

## 1. One line, image + audio

Reference audio, 5.72 s: _"I told you already, the shipment never made it past
the harbour. Somebody moved it."_ — one phrase to 3.47 s, a 1.06 s pause, then
the second phrase.

Whisper on the returned MP4's audio track gives the line back **verbatim**,
with phrase boundaries at 0.03–3.59 s and 4.63–5.95 s — within 0.1–0.3 s of the
reference, stretched to fill the 6 s clip.

The mouth follows it. Sampled at 8 fps: articulating from 0.0–3.4 s, **closed
through 3.5–4.5 s** — the pause — reopening at 4.6 s exactly as the second
phrase starts, articulating to the end. That gap is what separates real
lip-sync from a generic talking loop, and it is where the mouth actually
closes. Character identity from `@Image1` held throughout.

## 2. Full scene — 6 lines, two characters, 21 s

Six clips totalling 21.0 s (each 2.9–3.9 s), two reference images, one prompt
naming who says what (`@Image1 says @Audio1. @Image2 answers @Audio2. …`).
`duration: 21` was accepted and honoured.

All six lines come back verbatim and in order. More than that, **Seedance cut
the scene to the speaker**: over-the-shoulder on the woman for lines 1, 3, 5
and on the man for 2, 4, 6, with cuts landing within a few frames of each line
boundary (the one exception cuts back ~0.4 s early on line 4, which reads as a
J-cut). Both characters hold identity across their cuts and both articulate
their own lines.

This is the finding that most changes #1555: 2.5 is not only lip-syncing, it is
**editing** — one request produced a coherent multi-shot dialogue scene, not a
single sustained take. Whether that is wanted or has to be suppressed is a
design question the milestone has not asked yet.

## 3. Audio-only reference

Accepted, no image. Ark invented a speaker from the prompt and lip-synced her
to the supplied line; whisper returns it verbatim. Note it ignored the
"stylized 3D animated" instruction and rendered a photorealistic woman — a
_generated_ photoreal face is fine as **output**; the privacy filter only
applies to **input** images.

## Constraints that scope #1555

**Audio needs a public URL, and that is all it needs.** Plain `fal.media` URLs
were fetched server-side without complaint. Reference audio is not subject to
the portrait filter, so it does **not** need ACR asset registration — the sheet
path via `external-url.ts` already covers it, and `arkStillsForMotion` does not
grow an audio arm.

**`first_frame` cannot be mixed with `reference_audio`.** Verified:

```
InvalidParameter: first/last frame content cannot be mixed with reference
media content
```

Audio is reference media, so **any shot with dialogue is an r2v shot**. This is
the same mix-ban `build-byteplus-video-request.ts` already navigates for
reference images — the start frame is demoted to the first `reference_image`
and the prompt names it as the opening frame. Dialogue therefore forces that
demotion for every shot that has it, including shots that would otherwise have
sent a clean `first_frame`. It is not a new mechanism, but it is a new reason
to take the r2v branch.

**The output is a re-render, not a passthrough.** The supplied performance is
what you hear — same words, same phrasing, same pauses — but it is not the
supplied file muxed in. Measured against the reference: the output carries a
generated ambience bed (−51 dBFS through the pause, where the reference is
digital silence at −85 dBFS), the pause and the second phrase are stretched by
different amounts rather than uniformly, and mean f0 over voiced frames sits
~5 % above the reference (182 → 191 Hz). If the milestone needs the exact
ElevenLabs bytes on the timeline, that is a mux over the rendered clip, not
something Seedance hands back.

`generate_audio` defaults to **true** whenever reference audio is present —
Ark set it on every task here without being asked.

## Not covered

- **Photoreal stills + audio.** A photoreal `reference_image` is rejected
  before generation with the familiar
  `InputImageSensitiveContentDetected.PrivacyInformation`, so every test above
  used a stylized character. This is the existing ACR path (#1361) and is
  unchanged by audio, but the combination (registered `asset://` still +
  `reference_audio`) was not run — it needs `BYTEPLUS_ACCESS_KEY` /
  `BYTEPLUS_SECRET_KEY`, which this session could not reach. Both roles are
  reference media, so the mix-ban does not apply; worth one confirming run
  before #1555 lands.
- Whether `generate_audio: false` suppresses the ambience bed and leaves a
  cleaner dialogue track.
- Per-line speaker binding when a character is named in more than one line, and
  what happens when combined audio exceeds 30.2 s or 10 files.
