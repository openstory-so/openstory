# Seed voices (#1765)

ElevenLabs Voice Design could not reliably make an Australian voice. Blind
listening tests (issue #1765) picked **Seed Audio 1.0**, called on BytePlus
Seed Speech directly, with a locked reference voice per character and a
transcription check on every take.

## Provider

- `POST {SEED_SPEECH_BASE_URL}/api/v3/tts/create`, header `X-Api-Key`
  (`seed-audio.ts`). **Platform key only** (`SEED_SPEECH_API_KEY`), spent
  through `scopedDb.credentials.resolveKey('seed-speech')`. Under `E2E_TEST`
  it stays off unless `SEED_SPEECH_BASE_URL` is set, so e2e and replay stay on
  ElevenLabs.
- Output is WAV at 44.1 kHz, so everything after the call is the same PCM
  byte arithmetic the ElevenLabs path uses (`cutAudioSection`,
  `trimmedEndSeconds`).
- Limits: 3 reference clips (each ≤ 30 s, ≤ 10 MB), 2 speakers, 120 s of
  audio, a 3,000-character prompt. The QPS cap is per **account**: calls are
  paced on the BytePlus governor DO (`acquireSeedSpeechToken`,
  `SEED_SPEECH_QPM`, default 30/min, burst 2) and a 429 is retried.
- Pricing (`seed-speech-pricing.ts`): $0.0025 per second of
  `original_duration` (BytePlus pay-as-you-go $0.15/min, read off the docs
  2026-09-23, not yet bill-verified). Trailing silence is billed. Scribe
  ($0.22/h) and isolation ($0.12/min) are on the ElevenLabs card. Unaudited
  like every native via. Pre-flight (`estimateTtsCost`) prices the dearer of
  ElevenLabs and Seed at 8 characters per billed second, because a pre-flight
  cannot tell which provider speaks a line.

## What a Seed voice is

A `voiceId` of `seed:<ulid>` (`@/cast/seed-voice`). It rides in the same
column as an ElevenLabs id, so matching, hashing, staleness and history do
not change. It is **not** an account slot: `releaseVoiceIfUnreferenced`
returns at once for it, and its history rows are never stamped released.

It is three reference clips cut from one range read, in R2 under
`AUDIO/seed-voices/<ulid>/`: `normal.mp3`, `quiet.mp3`, `loud.mp3` (isolated),
`read.wav` (the whole read, for audition) and `voice.json`
(`{ description, clips }`, written once). The recorder reads the bundle from
R2 — immutable, so no mid-run D1 read.

**A voice keeps its provider for life.** Existing ElevenLabs voices keep
recording on ElevenLabs; there is no hop between the two.

## Making one (`CharacterVoiceWorkflow`, `voiceProvider: 'seed'`)

`voiceProvider` is fixed at trigger (`isSeedVoiceConfigured()`: Seed AND
ElevenLabs configured) and snapshotted on the payload.

1. The voice description (drafted by `phase/voice-design-chat` when empty).
2. `phase/voice-range-script-chat` writes three 20–30-word sections from the
   bible: normal / quiet (whispered) / loud (raised, annoyed). **Normal
   spelling only** — "nah-oo" and "to-die" were read literally and set off
   invented words.
3. `takes` takes (1–3, default 2), run side by side, each its own step (`seed-range-read-N`); the three clips of a take are isolated side by side too. One Seed call reads
   all three sections (one voice throughout, booth wording, "natural
   conversational pace" — pace cues like "slow" get over-applied), Scribe
   transcribes it, `checkTake` + `locateParts` find each section, the WAV is
   cut by the word timings, each section is isolated, and the bundle is
   written. A take that says anything but its script throws and the step
   retry re-records it; a take that still fails is dropped.
   Each take is a different person reading the same description, paid for
   separately, so the user picks the count: the character card's Generate
   has a 1 / 2 / 3 picker (`SEED_VOICE_DEFAULT_TAKES` = 2), priced at
   `SEED_VOICE_TAKE_ESTIMATE` per take. Story generation uses the default.
4. The first surviving take is the voice. "Use this take" on another costs
   nothing — a Seed take is its voice, there is nothing to save.

## Recording (`recordSeedDialogueCall`)

Same claim → record → cut → promote lifecycle as ElevenLabs; only the call
differs. `recordDialogue` sends a call to Seed when its lines are Seed
voices; `chunkTakeLines` never mixes providers in one call, breaks a Seed
call before a third speaker joins (a 3+ speaker scene is a series of
two-person exchanges) and keeps it under 1,000 line characters.

- **Mood-matched references.** Seed copies the reference's delivery as well
  as its voice. Each speaker's normal clip is always sent; a whispered line
  (`moodForTone`) adds that speaker's quiet clip and a shouted/annoyed/excited
  line the loud clip, while a slot is free. Sad, tender and tired stay on the
  normal clip with the mood in words — mapping sad to quiet made sad lines
  whisper.
- **The prompt**: booth, each speaker as "the exact voice and accent of
  @AudioN" (plus the mood clips) and their description, then `Name (tone):
line` in order.
- **The check.** Seed speaks invented words — before the script, or where a
  reference changes. Every take is transcribed with Scribe. Nonsense before
  the script is cut off (the first shot's range starts at the script);
  anything else is a retake, up to 3 per call, then the recording fails.
  Seed's own subtitles are an alignment of the script and can never show an
  invented word, so they are not requested; turn timings come from Scribe.
- Failed takes are not billed to the team.

## Open

- Seed Speech ASR is not granted on the account (`45000030`); Scribe does
  the check.
- Whether a cloned `speaker` id holds delivery better than clips, and whether
  it counts toward the three references.
- Whether the quiet clip whispers convincingly inside a scene.
