import { useState } from 'react';
import { useAuthGate } from '@/platform/ui/auth/auth-gate-provider';
import { routeParams } from '@/ui/layout/breadcrumbs';
import {
  EditTalentDialog,
  isParkedSheet,
} from '@/cast/ui/talent-library/edit-talent-dialog';
import { TalentMediaUpload } from '@/cast/ui/talent-library/talent-media-upload';
import { PageContainer } from '@/ui/layout/page-container';
import { getCurrentUserProfileFn } from '@/platform/user.fn';
import { PageDescription } from '@/ui/typography/page-description';
import { PageHeader } from '@/ui/typography/page-header';
import { Button } from '@/ui/shadcn/button';
import { Card } from '@/ui/shadcn/card';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { useTalentSheetRealtime } from '@/cast/ui/use-talent-realtime';
import {
  useTalentById,
  useDeleteTalent,
  useDiscardTalentSheet,
  useGenerateTalentSheet,
  useSelectTalentSheet,
  useToggleTalentFavorite,
  useUndiscardTalentSheet,
} from '@/cast/ui/use-talent';
import { sheetProgressCopy } from '@/cast/sheet-progress-copy';
import type { TalentSheet } from '@/platform/server/db/schema';
import { cn } from '@/ui/utils';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft,
  Loader2,
  Pencil,
  Sparkles,
  Star,
  Trash2,
  User,
} from 'lucide-react';

function TalentCrumbLabel({ id }: { id: string }) {
  const { data } = useTalentById(id);
  return <>{data?.name ?? '…'}</>;
}

export const Route = createFileRoute('/_app/talent/$id')({
  component: TalentDetailPage,
  staticData: {
    breadcrumb: (match) => {
      const { id } = routeParams<{ id: string }>(match);
      return [
        { label: 'Characters', to: '/characters' },
        { label: 'Talent', to: '/talent' },
        { label: <TalentCrumbLabel id={id} /> },
      ];
    },
  },
});

const SHEET_SOURCE_LABEL: Record<TalentSheet['source'], string> = {
  ai_generated: 'Generated',
  manual_upload: 'Uploaded',
  script_analysis: 'From a character',
};

/** What a history row is, in one word, beside its source. */
function sheetState(sheet: TalentSheet): string | null {
  if (sheet.discardedAt) return 'Discarded';
  if (isParkedSheet(sheet)) return 'Made after an edit, not in use';
  return null;
}

/** Names the generators and uploads wrote; a sheet named by hand shows its name. */
const GENERIC_SHEET_NAMES = new Set([
  'Default',
  'Default Sheet',
  'Uploaded Sheet',
  'Generated Sheet',
  'Reference sheet',
]);

/**
 * "Casual · Uploaded · Discarded": the name an old named sheet carried
 * (`legacyName`, written until the column is dropped; the name is the only
 * thing that told two uploads apart), then its source and state.
 */
function sheetLabel(sheet: TalentSheet, state: string | null): string {
  const name = GENERIC_SHEET_NAMES.has(sheet.legacyName)
    ? null
    : sheet.legacyName;
  return [name, SHEET_SOURCE_LABEL[sheet.source], state]
    .filter((part) => part !== null)
    .join(' · ');
}

/** The busy label belongs to the row whose action is running, not every row. */
function busyOn(
  mutation: { isPending: boolean; variables?: { sheetId: string } },
  sheet: TalentSheet
): boolean {
  return mutation.isPending && mutation.variables?.sheetId === sheet.id;
}

function TalentDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthGate();
  const { data: talent, isLoading, error } = useTalentById(id);
  const { data: profile } = useQuery({
    queryKey: ['currentUserProfile'],
    queryFn: () => getCurrentUserProfileFn(),
    staleTime: 5 * 60 * 1000,
    enabled: isAuthenticated,
  });
  const toggleFavorite = useToggleTalentFavorite();
  const deleteTalent = useDeleteTalent();
  const generateSheet = useGenerateTalentSheet();
  const selectSheet = useSelectTalentSheet();
  const discardSheet = useDiscardTalentSheet();
  const undiscardSheet = useUndiscardTalentSheet();
  const [dropFiles, setDropFiles] = useState<File[]>([]);

  const canManageTalent = Boolean(
    isAuthenticated &&
    profile?.teamId &&
    talent &&
    talent.teamId === profile.teamId &&
    !talent.isPublic
  );

  const {
    isGenerating: isGeneratingSheet,
    phase: generatingPhase,
    error: sheetError,
    startGenerating,
    stopGenerating,
  } = useTalentSheetRealtime(canManageTalent ? id : undefined);

  const handleGenerateSheet = () => {
    if (!talent) return;
    startGenerating();
    generateSheet.mutate(
      { talentId: talent.id },
      {
        onError: (error) => {
          stopGenerating(
            error instanceof Error ? error.message : 'Sheet generation failed'
          );
        },
      }
    );
  };

  const handleDelete = () => {
    if (!talent) return;
    if (!confirm(`Delete "${talent.name}"? This cannot be undone.`)) return;

    deleteTalent.mutate(talent.id, {
      onSuccess: () =>
        void navigate({ to: '/characters', search: { tab: 'talent' } }),
    });
  };

  if (isLoading) {
    return (
      <div className="h-full overflow-auto">
        <PageContainer>
          <div className="mb-6">
            <Skeleton className="h-8 w-48 mb-2" />
            <Skeleton className="h-4 w-96" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((n) => (
              <Skeleton
                key={`skeleton-${n}`}
                className="aspect-square rounded-lg"
              />
            ))}
          </div>
        </PageContainer>
      </div>
    );
  }

  if (error || !talent) {
    return (
      <div className="h-full overflow-auto">
        <PageContainer>
          <Card className="p-8 text-center">
            <p className="text-destructive mb-4">
              {error?.message || 'Talent not found'}
            </p>
            <Button variant="outline" asChild>
              <Link to="/characters" search={{ tab: 'talent' }}>
                Back to Talent
              </Link>
            </Button>
          </Card>
        </PageContainer>
      </div>
    );
  }

  const referenceSheet =
    talent.sheets.find((s) => s.id === talent.selectedSheetId) ?? null;
  const history = talent.sheets.filter((s) => s.id !== talent.selectedSheetId);
  const sheetAction = (sheet: TalentSheet) => ({
    sheetId: sheet.id,
    talentId: talent.id,
  });

  return (
    <div className="h-full overflow-auto">
      <PageContainer>
        {/* Back link */}
        <Button variant="ghost" size="sm" className="mb-4 -ml-2" asChild>
          <Link to="/characters" search={{ tab: 'talent' }}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Talent
          </Link>
        </Button>

        <PageHeader
          actions={
            canManageTalent ? (
              <div className="flex items-center gap-2">
                <EditTalentDialog
                  talent={talent}
                  trigger={
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="Edit talent"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  }
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={
                    talent.isFavorite ? 'Remove favourite' : 'Favourite'
                  }
                  onClick={() => toggleFavorite.mutate(talent.id)}
                  disabled={toggleFavorite.isPending}
                >
                  <Star
                    className={cn(
                      'h-4 w-4',
                      talent.isFavorite
                        ? 'fill-yellow-400 text-yellow-400'
                        : 'text-muted-foreground'
                    )}
                  />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Delete talent"
                  onClick={handleDelete}
                  disabled={deleteTalent.isPending}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ) : undefined
          }
        >
          <h1 className="sr-only">{talent.name}</h1>
          {/* Rights: a signed real-person likeness, or an AI face. */}
          <div className="flex items-center gap-3">
            {talent.isHuman ? (
              <span className="px-2 py-1 bg-muted rounded text-xs font-medium">
                Real person, rights signed
              </span>
            ) : (
              <span className="px-2 py-1 bg-muted rounded text-xs font-medium flex items-center gap-1">
                <Sparkles className="h-3 w-3" />
                AI face
              </span>
            )}
          </div>
          {talent.description && (
            <PageDescription>{talent.description}</PageDescription>
          )}
        </PageHeader>

        <div className="flex flex-col gap-8">
          {/* Reference sheet: the face every cast character draws from. */}
          <section className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Reference sheet</h2>
              {canManageTalent && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateSheet}
                  disabled={isGeneratingSheet}
                >
                  {isGeneratingSheet
                    ? sheetProgressCopy(generatingPhase)
                    : referenceSheet
                      ? 'Generate a new sheet'
                      : 'Generate sheet'}
                </Button>
              )}
            </div>
            {sheetError ? (
              <p className="text-destructive text-sm" role="alert">
                {sheetError}
              </p>
            ) : null}
            {referenceSheet?.imageUrl ? (
              <Card className="overflow-hidden">
                <img
                  src={referenceSheet.imageUrl}
                  alt={`${talent.name} reference sheet`}
                  className="h-auto w-full"
                />
                <p className="p-3 text-xs text-muted-foreground">
                  {SHEET_SOURCE_LABEL[referenceSheet.source]}. Characters cast
                  with this talent draw their face from this sheet.
                </p>
              </Card>
            ) : isGeneratingSheet ? (
              <Card className="p-8 text-center">
                <Loader2 className="h-12 w-12 mx-auto mb-4 animate-spin text-muted-foreground" />
                <p className="text-muted-foreground">
                  {sheetProgressCopy(generatingPhase, 'long')}
                </p>
              </Card>
            ) : (
              <Card className="p-8 text-center">
                <User className="h-12 w-12 mx-auto mb-4 text-muted-foreground/30" />
                <p className="text-muted-foreground">
                  No reference sheet yet. Drop a character sheet or generate one
                  from the photos and description.
                </p>
              </Card>
            )}
          </section>

          {/* Reference media */}
          {talent.media.length > 0 && (
            <section className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold">
                Reference media ({talent.media.length})
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                {talent.media.map((media) => (
                  <Card key={media.id} className="overflow-hidden">
                    <div className="aspect-square bg-muted">
                      {media.type === 'image' && (
                        <img
                          src={media.url}
                          alt="Reference"
                          className="w-full h-full object-cover"
                        />
                      )}
                      {media.type === 'video' && (
                        <video
                          src={media.url}
                          className="w-full h-full object-cover"
                          muted
                        />
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {/* Sheet history: older, parked and discarded sheets. */}
          {history.length > 0 && (
            <section className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold">
                Other sheets ({history.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {history.map((sheet) => {
                  const state = sheetState(sheet);
                  return (
                    <Card
                      key={sheet.id}
                      className={cn(
                        'overflow-hidden',
                        sheet.discardedAt && 'opacity-60'
                      )}
                    >
                      <div className="bg-muted">
                        {sheet.imageUrl ? (
                          <img
                            src={sheet.imageUrl}
                            alt={`${talent.name} sheet`}
                            className="h-auto w-full"
                          />
                        ) : (
                          <div className="flex aspect-video w-full items-center justify-center">
                            <User className="h-12 w-12 text-muted-foreground/30" />
                          </div>
                        )}
                      </div>
                      <div className="p-3 flex items-center justify-between gap-2">
                        <p className="text-xs text-muted-foreground">
                          {sheetLabel(sheet, state)}
                        </p>
                        {canManageTalent && (
                          <div className="flex items-center gap-2">
                            {sheet.discardedAt ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  undiscardSheet.mutate(sheetAction(sheet))
                                }
                                disabled={undiscardSheet.isPending}
                              >
                                {busyOn(undiscardSheet, sheet)
                                  ? 'Restoring…'
                                  : 'Restore'}
                              </Button>
                            ) : (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    selectSheet.mutate(sheetAction(sheet))
                                  }
                                  disabled={selectSheet.isPending}
                                >
                                  {busyOn(selectSheet, sheet)
                                    ? 'Selecting…'
                                    : 'Use as reference'}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    discardSheet.mutate(sheetAction(sheet))
                                  }
                                  disabled={discardSheet.isPending}
                                >
                                  {busyOn(discardSheet, sheet)
                                    ? 'Discarding…'
                                    : 'Discard'}
                                </Button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </section>
          )}

          {canManageTalent ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">Drop a sheet or photos</h2>
              <p className="text-sm text-muted-foreground">
                Drop a character sheet to use it as the reference sheet, or drop
                photos to generate one. A photo of a real person asks for your
                rights sign-off first.
              </p>
              <TalentMediaUpload
                files={dropFiles}
                onFilesChange={setDropFiles}
                talentId={talent.id}
                onComplete={() => setDropFiles([])}
              />
            </section>
          ) : null}
        </div>
      </PageContainer>
    </div>
  );
}
