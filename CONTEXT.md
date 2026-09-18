# Domain glossary

## Voice configuration

The complete, selectable voice identity for one sequence character: provider
voice, audible description, audition previews, and whether the voice is enabled.

## Voice version

An immutable historical voice configuration. Exactly one voice version is
selected for a character (`characters.selectedVoiceVersionId`); the character's
voice columns mirror it. Selecting an older version restores that configuration
without changing or deleting newer versions. A version whose provider voice has
been released (`releasedAt`) can no longer be selected.

## Scene dialogue

The authored lines of a scene, in speaking order, each naming the shot it is
spoken in by id. The one place the lines live: the shot-list pass seeds it from
the script, the prompt editor edits it, and References, render and staleness
all read it. A shot's dialogue is a view over it.

## Dialogue version

An immutable revision of a scene's dialogue. Exactly one is selected per scene.

## Dialogue take

One recorded conversation for a scene: the whole scene's voiced lines in one
ElevenLabs Text to Dialogue call, with the provider's per-turn segments, so
every line is acted in the context of the others. A shot's audio clip is a
slice of the selected take. Exactly one take is selected per scene; the take a
clip was cut from is stamped on the render manifest.

## Dependency key

A canonical value identifying the upstream inputs used to generate an artifact.
For a take: the ordered voiced lines with their shot ids, the voice speaking
each, the tone, and the synthesis model and stability. When any of them change,
the key changes and the take is stale.
