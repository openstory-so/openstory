# Domain glossary

## Voice configuration

The complete, selectable voice identity for one sequence character: provider
voice, audible description, audition previews, and whether the voice is enabled.

## Voice version

An immutable historical voice configuration. Exactly one voice version may be
selected for a character. Selecting an older version restores that configuration
without changing or deleting newer versions.

## Dialogue take

One generated conversation audio result for a shot. A take may contain multiple
speakers and audio clips, but it is selected as a single shot-level unit.

## Dialogue version

An immutable historical dialogue take plus the dependency key for the authored
lines, voice identities, delivery directions, and synthesis model that produced
it. Exactly one dialogue version may be selected for a shot.

## Dependency key

A canonical value identifying the upstream inputs used to generate an artifact.
When a dialogue line, selected voice, delivery direction, or synthesis model
changes, the dialogue dependency key changes.
