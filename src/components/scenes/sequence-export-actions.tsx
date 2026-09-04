/**
 * Canvas-view trailing control: an Export dropdown in the same slot as
 * Copy script. Download / Copy stay as icon overlay on the theatre player;
 * this menu is the place later formats will land.
 */

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SequenceExportState } from '@/components/theatre/use-sequence-export';
import type { ExportProgress } from '@/shared/sequence-player/export';
import { ChevronDown, Download, FileDown, Link, Loader2 } from 'lucide-react';

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
  const pending =
    !running && !sequenceExport.canExport && !sequenceExport.freshExportUrl;
  const label = running
    ? formatExportProgress(sequenceExport.progress)
    : pending
      ? `${sequenceExport.clipsReady} of ${sequenceExport.clipsTotal} clips ready`
      : 'Export';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 px-2 md:h-8 md:px-2.5"
          aria-label={label}
          aria-busy={running}
          disabled={pending}
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin md:mr-1.5 md:h-3.5 md:w-3.5" />
          ) : (
            <FileDown className="h-4 w-4 md:mr-1.5 md:h-3.5 md:w-3.5" />
          )}
          <span className="hidden md:inline">
            {running ? 'Creating…' : 'Export'}
          </span>
          <ChevronDown className="hidden size-3 md:inline" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={pending || running}
          onClick={sequenceExport.download}
        >
          <Download />
          Download MP4
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={pending || running}
          onClick={sequenceExport.copyLink}
        >
          <Link />
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
