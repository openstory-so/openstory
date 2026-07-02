/**
 * Keyboard grammar for the unified Scenes editor (#986).
 *
 * ↑/↓ step shots · ←/→ step scenes · ⇧↑/⇧↓ grow/shrink the scene range ·
 * Esc zooms out one scope · Space plays/pauses the current scope ·
 * Enter drills into the selection · ⌘K opens the command palette.
 *
 * Keys are ignored while typing (inputs, textareas, contenteditable) or when
 * a dialog is open — except ⌘K, which always opens the palette.
 */

import {
  extendSceneRange,
  scopeOf,
  stepScene,
  stepShot,
  zoomOut,
  type SceneSelection,
  type SelectableShot,
} from '@/lib/scenes/selection';
import { useEffect } from 'react';

type UseScenesKeyboardArgs = {
  shots: SelectableShot[] | undefined;
  selection: SceneSelection;
  onSelectionChange: (next: SceneSelection) => void;
  onTogglePlay: () => void;
  onOpenPalette: () => void;
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]'
    ) !== null
  );
}

export function useScenesKeyboard({
  shots,
  selection,
  onSelectionChange,
  onTogglePlay,
  onOpenPalette,
}: UseScenesKeyboardArgs): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // ⌘K works from anywhere, including inputs.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenPalette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (!shots || shots.length === 0) return;

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          e.preventDefault();
          const direction = e.key === 'ArrowDown' ? 1 : -1;
          if (e.shiftKey && scopeOf(selection) === 'scene') {
            onSelectionChange(extendSceneRange(selection, shots, direction));
          } else {
            onSelectionChange(stepShot(selection, shots, direction));
          }
          break;
        }
        case 'ArrowRight':
        case 'ArrowLeft': {
          e.preventDefault();
          onSelectionChange(
            stepScene(selection, shots, e.key === 'ArrowRight' ? 1 : -1)
          );
          break;
        }
        case 'Escape': {
          if (scopeOf(selection) === 'sequence') return;
          e.preventDefault();
          onSelectionChange(zoomOut(selection, shots));
          break;
        }
        case ' ': {
          e.preventDefault();
          onTogglePlay();
          break;
        }
        case 'Enter': {
          if (scopeOf(selection) === 'shot') return;
          e.preventDefault();
          onSelectionChange(stepShot(selection, shots, 1));
          break;
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shots, selection, onSelectionChange, onTogglePlay, onOpenPalette]);
}
