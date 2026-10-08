---
title: Cast & Characters
description: Manage characters extracted from your script and maintain visual consistency
section: User Guide
order: 3
---

The **Cast** tab shows all characters identified during script analysis. OpenStory automatically extracts character details from your screenplay and generates visual reference sheets for each one.

## Character Grid

Characters appear as a grid of cards, each showing:

- **Character sheet image** — A generated reference image showing the character
- **Name** — The character's name as identified in the script
- **Role information** — Basic details extracted from the script

Click any character card to view their full detail page.

## Character Detail Page

The detail page provides comprehensive information about a character:

### Character Sheet Image

A 16:9 reference image generated from the script's character description. This image is used as a visual anchor for consistency across all scenes featuring this character.

During regeneration, a loading spinner replaces the image with "Regenerating character sheet..." text.

### Character Properties

All properties are automatically extracted from your script:

| Property                    | Description                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| **Name**                    | Character's name                                                                                 |
| **Age**                     | Approximate age                                                                                  |
| **Gender**                  | Character's gender                                                                               |
| **Ethnicity**               | Ethnic background                                                                                |
| **Physical Description**    | Detailed physical appearance                                                                     |
| **Standard Clothing**       | Default wardrobe                                                                                 |
| **Distinguishing Features** | Unique visual identifiers                                                                        |
| **First Appears**           | Scene number and line where the character first appears, with the quoted text                    |
| **Consistency Tag**         | Internal tag used to maintain visual consistency across scenes (shown as a monospace code badge) |

### Casting Status

Each character shows one of two states:

- **Auto-generated from script** — The character's appearance was generated purely from script descriptions
- **Cast as [Talent Name]** — The character has been recast using a talent from your library

## Recasting a Character

You can replace a character's auto-generated appearance with a talent from your library:

1. Click **Recast** on the character detail page
2. A **Talent Picker** dialog opens showing all talent in your library
3. Select a talent
4. A **confirmation dialog** appears showing:
   - The character name and talent name
   - How many frames will be affected
5. Confirm to recast

Recasting regenerates the character's reference sheet using the talent's reference images and updates all frames where the character appears.

## Your team's characters

Every character belongs to your team. **Characters** in the main navigation lists all of them, most recently used first. Open a character to see which sequences cast it and how many shots it is in.

A character stays in the team when a sequence removes it. To take one off the list, open it from **Characters** and click **Delete**. Delete is offered only when no sequence casts it, and the message that follows has **Undo**. A saved voice is released when no sequence casts the character.

Click **Save as talent** to copy the character into your Talent Library. A talent can be cast as a character in any sequence.

## Using a character in another sequence

A character is reused only when you say so. Two ways:

- **In the script**, type `@` and pick the character. Its name goes into the script in capitals and it joins the sequence's cast at its current version, with every look. Nothing else is stored in the text. On the new-sequence screen the character is added when you press Generate, as long as its name is still in the script.
- **On the cast panel**, click **Add existing character** and pick the character. No script change.

Analysis then reads the cast you attached: it keeps the character's bible and looks, links the outfits the script uses and adds a look only for an outfit it does not have. A plain name that is not in the cast is a new character; analysis never reaches into your team's other characters on its own.

Two characters in one sequence cannot have the same name when one is added from the team: rename one first. If analysis itself makes two characters of one name, rename one before recording dialogue.

## When a Character Changes in Another Sequence

A character is one character in every sequence that casts it, but each sequence keeps the version it has. Editing the character in one sequence does not change the others.

- **Not the current version** — When another sequence has changed the character (its bible, voice or an outfit), the cast card shows this badge and the character page shows a notice. Nothing in your sequence changed; it still uses the version it had.
- **Update this sequence** — Moves your sequence to the current version. Nothing is generated yet: the sheets and shots that used the old version show as out of date, and **Update all** redraws them, with the exact price.
- **Move sequences** — Lists every sequence that casts the character, with what would change, how many shots are affected and the most it could cost. Tick the sequences to move and confirm. Each moved sequence then shows what to update; none of them re-renders on its own.
- **Make a one-off copy** — Gives this sequence its own copy of the character at the version it has now. Edits here stop reaching the other sequences, and theirs stop reaching here. Sheets and shots stay as they are, so nothing re-renders. Not available while a sheet is generating.
- **Recasting across sequences** — The recast confirmation lists the other sequences that cast the character. Tick the ones that should use the new talent too; they move to the new version and redraw from their own Update. Unticked sequences keep the previous version and show **Not the current version**.

## Real-Time Updates

Character sheet regeneration happens asynchronously. The UI subscribes to real-time events (`generation.character-sheet:progress`) and automatically updates when:

- Generation starts (shows loading state)
- Generation completes (refreshes the character data)
- Generation fails (restores previous state)
