/**
 * Labeled Download / Copy for the sequence cut. Lives in the Canvas/Script
 * toggle's trailing slot — always on screen, never on the video overlay
 * (that row is already music + mixed-res + player chrome).
 *
 * Same content-addressed cache as theatre play: a matching MP4 is reused;
 * otherwise the click creates one first.
 */

import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { SequenceExportState } from '@/components/theatre/use-sequence-export';
import type { ExportProgress } from '@/shared/sequence-player/export';
import { Download, Link, Loader2 } from 'lucide-react';

export function formatExportProgress(progress: ExportProgress | null): string {
  if (!progress) return 'Creating MP4…';
  const phaseLabel: Record<ExportProgress['phase'], string> = {
    prepare: 'Preparing',
    video: 'Stitching video',
    music: 'Downloading music',
    dialogue: 'Decoding dialogue',
    mix: 'Mixing audio',
    encode: 'Encoding audio',
    finalize: 'Finalizing',
    upload: 'Uploading',
    commit: 'Saving',
    server: 'Rendering on server',
  };
  const label = phaseLabel[progress.phase];
  if (progress.total > 0) {
    const pct = Math.min(
      100,
      Math.round((progress.completed / progress.total) * 100)
    );
    return `${label}… ${pct}%`;
  }
  return `${label}…`;
}

export const SequenceExportActions: React.FC<{
  sequenceExport: SequenceExportState;
}> = ({ sequenceExport }) => {
  const running = sequenceExport.isRunning;
  const progressLabel = formatExportProgress(sequenceExport.progress);
  const pending =
    !running && !sequenceExport.canExport && !sequenceExport.freshExportUrl;
  const pendingHint = pending
    ? `${sequenceExport.clipsReady} of ${sequenceExport.clipsTotal} clips ready`
    : null;
  const downloadHint = running
    ? progressLabel
    : (pendingHint ?? 'Download MP4');
  const copyHint = running ? progressLabel : (pendingHint ?? 'Copy link');
  const downloadLabel = running ? 'Creating…' : 'Download MP4';
  const copyLabel = running ? 'Creating…' : 'Copy link';

  return (
    <div className="flex items-center justify-end">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-11 px-2 md:h-8 md:px-2.5"
              aria-label={downloadHint}
              aria-busy={running}
              disabled={pending}
              onClick={sequenceExport.download}
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin md:mr-1.5 md:h-3.5 md:w-3.5" />
              ) : (
                <Download className="h-4 w-4 md:mr-1.5 md:h-3.5 md:w-3.5" />
              )}
              <span className="hidden md:inline">{downloadLabel}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{downloadHint}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-11 px-2 md:h-8 md:px-2.5"
              aria-label={copyHint}
              aria-busy={running}
              disabled={pending}
              onClick={sequenceExport.copyLink}
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin md:mr-1.5 md:h-3.5 md:w-3.5" />
              ) : (
                <Link className="h-4 w-4 md:mr-1.5 md:h-3.5 md:w-3.5" />
              )}
              <span className="hidden md:inline">{copyLabel}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{copyHint}</TooltipContent>
      </Tooltip>
    </div>
  );
};
