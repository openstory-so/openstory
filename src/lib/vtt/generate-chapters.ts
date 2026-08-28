import type { SceneRow } from '@/lib/db/schema';
import { plainSceneTitle } from '@/lib/utils/markdown-plain';
import type { Shot } from '@/types/database';

/** A shot paired with the scene it belongs to (null when it has none). */
export type ShotChapter = {
  shot: Pick<Shot, 'durationMs'>;
  scene: Pick<SceneRow, 'title' | 'orderIndex'> | null;
};

/**
 * Formats a time in seconds to WebVTT timestamp format (HH:MM:SS.mmm)
 */
function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const h = hours.toString().padStart(2, '0');
  const m = minutes.toString().padStart(2, '0');
  const s = secs.toFixed(3).padStart(6, '0');

  return `${h}:${m}:${s}`;
}

function escapeVTTText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/-->/g, '—>')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, ' ')
    .trim();
}

/**
 * Generates a WebVTT chapters file from an array of shots.
 * Each shot becomes a chapter with its scene number and title.
 */
export function generateChaptersVTT(
  chapters: ReadonlyArray<ShotChapter>
): string {
  // Start with WebVTT header
  const lines: string[] = [
    'WEBVTT',
    '',
    'NOTE Generated chapters from shots',
    '',
  ];

  let cumulativeTime = 0;

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    if (!chapter) throw new Error(`expected shot at index ${i}`);
    const { shot, scene } = chapter;
    const duration = (shot.durationMs || 3000) / 1000; // Convert to seconds
    const startTime = cumulativeTime;
    const endTime = cumulativeTime + duration;

    const sceneNumber = scene ? scene.orderIndex + 1 : i + 1;
    const sceneTitle = plainSceneTitle(scene?.title) || `Scene ${i + 1}`;

    // Format: "Scene {number}: {title}"
    const chapterTitle = `Scene ${sceneNumber}: ${escapeVTTText(sceneTitle)}`;

    // Add cue block
    lines.push(`${formatTimestamp(startTime)} --> ${formatTimestamp(endTime)}`);
    lines.push(chapterTitle);
    lines.push(''); // Empty line between cues

    cumulativeTime = endTime;
  }

  return lines.join('\n');
}
