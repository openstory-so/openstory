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

| Property                 | Description                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| **Name**                 | Character's name                                                                                 |
| **Age**                  | Approximate age                                                                                  |
| **Gender**               | Character's gender                                                                               |
| **Ethnicity**            | Ethnic background                                                                                |
| **Physical Description** | Detailed physical appearance, including permanent marks (a scar, a birthmark, a tattoo)          |
| **First Appears**        | Scene number and line where the character first appears, with the quoted text                    |
| **Consistency Tag**      | Internal tag used to maintain visual consistency across scenes (shown as a monospace code badge) |

### Looks

**Person** says whether the character is a person (a robot or an animal is not). It stays **Person**, and cannot be changed, while the character is cast with a talent who is a real person or its sheet is an uploaded photo of a real person; the form says which. A sheet in any sequence that uses the character counts.

What a character wears is a look: a name, **Clothing**, and **Hair, makeup, injuries**. Every character has a default look, and you can add more for other outfits. Each look has its own sheet.

The character form has no clothing or distinguishing-features field: both belong to the default look. Text that was in Distinguishing Features shows in the default look's Hair, makeup, injuries. Other looks have only what you write for them. A permanent mark, such as a scar or a tattoo, belongs in Physical Description.

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

Click **New character** to make one before there is a script: give it a name and, if you like, a physical description. Its page is the same page a sequence shows for it: fill in the rest of its bible, add, rename, edit or remove looks, generate or upload a sheet for each look, and design or pick a voice. Only what belongs to a sequence (its shots, **Remove**) waits for one. Use it in a script with `@`, or with **Add existing character** on a cast panel. Analysis in that sequence keeps the character as you wrote it.

A character stays in the team when a sequence removes it. To take one off the list, open it from **Characters** and click **Delete**. Delete is offered only when no sequence casts it, and the message that follows has **Undo**. A saved voice stays with the character until it is deleted.

Click **Save as talent** to copy the character into your Talent Library. A talent can be cast as a character in any sequence.

## Using a character in another sequence

A character is reused only when you say so. Two ways:

- **In the script**, type `@` and pick the character. Its name goes into the script in capitals and it joins the sequence's cast at its current version, with every look. Nothing else is stored in the text. On the new-sequence screen the character is added when you press Generate, as long as its name is still in the script.
- **On the cast panel**, click **Add existing character** and pick the character. No script change.

Analysis then reads the cast you attached: it keeps the character's bible and looks, links the outfits the script uses and adds a look only for an outfit it does not have. A plain name that is not in the cast is a new character; analysis never reaches into your team's other characters on its own.

Two characters in one sequence cannot have the same name when one is added from the team: rename one first. If analysis itself makes two characters of one name, rename one before recording dialogue.

## Rendered As

Every character that is seen says what it is rendered as: photoreal live action, 3D animation, cel animation. Analysis fills it from the sequence's style; the Characters page asks for it. It is the only thing a character sheet takes from a style, so a character looks the same in every sequence that casts it. A sequence in another medium needs its own character: make one.

## When a Character Changes in Another Sequence

A character is one character in every sequence that casts it. Editing it anywhere — its bible, its voice, an outfit, a sheet — changes it everywhere. Nothing is generated by the edit itself: in each sequence the sheets and shots that used the old version show as out of date, and **Update all** there redraws them, with the exact price. A recast works the same way: every sequence that casts the character gets the new talent, and each redraws from its own Update.

## Real-Time Updates

Character sheet regeneration happens asynchronously. The UI subscribes to real-time events (`generation.character-sheet:progress`) and automatically updates when:

- Generation starts (shows loading state)
- Generation completes (refreshes the character data)
- Generation fails (restores previous state)
