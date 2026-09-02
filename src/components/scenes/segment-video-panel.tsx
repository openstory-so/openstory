import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { videoModelDisplayName } from '@/lib/ai/models';
import type {
  SegmentVideoVersion,
  SequenceSegment,
} from '@/lib/scenes/scene-segments';
import { AlertTriangle, Check, Film, Loader2 } from 'lucide-react';

type SegmentVideoPanelProps = {
  segment: SequenceSegment;
  /** Precomputed 1-based span label ("Shot 1" / "Shots 1–3"). */
  spanLabel: string;
  onSelectVersion: (versionId: string) => void;
  selecting: boolean;
};

/**
 * Versions the Video tab chips surface: active model only, no failed rows
 * (#1076 — failed re-rolls stay in history, not as permanent chips).
 */
function visibleSegmentVersions(
  segment: SequenceSegment
): SegmentVideoVersion[] {
  return segment.versions.filter(
    (v) =>
      (segment.model === null || v.model === segment.model) &&
      v.status !== 'failed'
  );
}

/**
 * Whether the segment panel adds anything the plain (per-shot) Video tab
 * doesn't: a multi-shot span, a re-roll history to switch between, or a stale
 * render. In the all-ones / single-version / fresh case it stays hidden so
 * today's Video tab is unchanged (forward-compat, #986 design Q5).
 */
export function segmentPanelIsInformative(
  segment: SequenceSegment | undefined
): segment is SequenceSegment {
  if (!segment) return false;
  return (
    segment.shotIds.length > 1 ||
    visibleSegmentVersions(segment).length > 1 ||
    segment.stale
  );
}

const VersionDot: React.FC<{ status: SegmentVideoVersion['status'] }> = ({
  status,
}) => {
  if (status === 'completed')
    return <Check className="h-3 w-3 text-muted-foreground" />;
  if (status === 'failed')
    return <AlertTriangle className="h-3 w-3 text-destructive" />;
  return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />;
};

/**
 * The segment context at the top of the Video tab (#986): this shot's render
 * segment — its shot span, model, staleness, and the re-roll history you can
 * switch the selected version between. Video renders per segment, not per shot,
 * so when a segment spans multiple shots this makes the shared video legible.
 */
export const SegmentVideoPanel: React.FC<SegmentVideoPanelProps> = ({
  segment,
  spanLabel,
  onSelectVersion,
  selecting,
}) => {
  const label = segment.model ? videoModelDisplayName(segment.model) : null;
  // Re-roll history for the segment's active model (a "variant" is per
  // (segment, model)); each is one render you can point the selection at.
  const versions = visibleSegmentVersions(segment);

  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3">
      <div className="flex items-center gap-2 text-sm">
        <Film className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{label ?? 'Video'}</span>
        <span className="text-muted-foreground">{spanLabel}</span>
        {segment.stale && (
          <Badge variant="outline" className="ml-auto shrink-0">
            Stale
          </Badge>
        )}
      </div>

      {segment.shotIds.length > 1 && (
        <p className="text-xs text-muted-foreground">
          One video renders across these {segment.shotIds.length} shots.
        </p>
      )}

      {versions.length > 1 && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            Versions
          </span>
          <div className="flex flex-wrap gap-1.5">
            {versions.map((version, i) => {
              const isSelected = version.id === segment.selectedVersionId;
              const selectable = version.status === 'completed' && !isSelected;
              return (
                <Button
                  key={version.id}
                  type="button"
                  size="sm"
                  variant={isSelected ? 'default' : 'outline'}
                  disabled={!selectable || selecting}
                  onClick={() => onSelectVersion(version.id)}
                  aria-label={`Select version ${i + 1}${
                    version.resolution ? ` (${version.resolution})` : ''
                  }`}
                  aria-pressed={isSelected}
                  className="h-7 gap-1.5 px-2 text-xs"
                >
                  <VersionDot status={version.status} />v{i + 1}
                  {/* A 4K re-roll sits next to its 720p draft; say which is
                      which rather than leaving the chips identical (#1449). */}
                  {version.resolution && (
                    <span className="font-mono text-[10px] opacity-70">
                      {version.resolution === '4k' ? '4K' : version.resolution}
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
