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

## Adding to the Library

Click **Add to Library** to put the character in your team's character library. Nothing is copied: it is the same character, with its looks, sheets and voice. **Remove from Library** takes it out again.

Click **Save as talent** to copy the character into your Talent Library instead. A talent can be cast as a character in any sequence.

**Characters** in the main navigation lists every character your team has, most recently used first. Pick **Library** to see only the ones in the library. Open a character to see which sequences cast it and how many shots it is in.

## Real-Time Updates

Character sheet regeneration happens asynchronously. The UI subscribes to real-time events (`generation.character-sheet:progress`) and automatically updates when:

- Generation starts (shows loading state)
- Generation completes (refreshes the character data)
- Generation fails (restores previous state)
