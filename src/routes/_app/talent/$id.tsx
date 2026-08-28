import { useState } from 'react';
import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { routeParams } from '@/components/layout/breadcrumbs';
import { EditTalentDialog } from '@/components/talent-library/edit-talent-dialog';
import { PortraitAttestationFields } from '@/components/talent-library/portrait-attestation-fields';
import { TalentMediaUpload } from '@/components/talent-library/talent-media-upload';
import { statementFor } from '@/lib/compliance/attestations';
import { PageContainer } from '@/components/layout/page-container';
import { getCurrentUserProfileFn } from '@/functions/user';
import { PageDescription } from '@/components/typography/page-description';
import { PageHeader } from '@/components/typography/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTalentSheetRealtime } from '@/hooks/use-talent-realtime';
import {
  useTalentById,
  useDeleteTalent,
  useGenerateTalentSheet,
  useSetDefaultSheet,
  useToggleTalentFavorite,
} from '@/hooks/use-talent';
import { sheetProgressCopy } from '@/lib/talent/sheet-progress-copy';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft,
  ImageIcon,
  Loader2,
  Pencil,
  Sparkles,
  Star,
  Trash2,
  Upload,
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
        { label: 'Talent', to: '/talent' },
        { label: <TalentCrumbLabel id={id} /> },
      ];
    },
  },
});

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
  const setDefaultSheet = useSetDefaultSheet();
  const [dropFiles, setDropFiles] = useState<File[]>([]);
  const [attested, setAttested] = useState(false);
  const [authorizationBasis, setAuthorizationBasis] = useState('');

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
      onSuccess: () => void navigate({ to: '/talent' }),
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
              <Link to="/talent">Back to Talent</Link>
            </Button>
          </Card>
        </PageContainer>
      </div>
    );
  }

  const uploadStatement = statementFor({
    subjectType: 'talent',
    depictsRealPerson: talent.isHuman === true,
  });
  const canUpload =
    attested &&
    (!uploadStatement.requiresBasis || authorizationBasis.trim().length > 0);

  return (
    <div className="h-full overflow-auto">
      <PageContainer>
        {/* Back link */}
        <Button variant="ghost" size="sm" className="mb-4 -ml-2" asChild>
          <Link to="/talent">
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
          <div className="flex items-center gap-3">
            {talent.isHuman ? (
              <span className="px-2 py-1 bg-muted rounded text-xs font-medium">
                Human
              </span>
            ) : (
              <span className="px-2 py-1 bg-muted rounded text-xs font-medium flex items-center gap-1">
                <Sparkles className="h-3 w-3" />
                AI
              </span>
            )}
          </div>
          {talent.description && (
            <PageDescription>{talent.description}</PageDescription>
          )}
        </PageHeader>

        {/* Media Section */}
        {talent.media.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-4">
              Reference Media ({talent.media.length})
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
        {/* Talent Sheets Section */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <ImageIcon className="h-5 w-5" />
              Talent Sheets ({talent.sheets.length})
            </h2>
            {canManageTalent && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerateSheet}
                disabled={isGeneratingSheet}
              >
                <Sparkles className="h-4 w-4 mr-2" />
                {isGeneratingSheet
                  ? sheetProgressCopy(generatingPhase)
                  : 'Generate Sheet'}
              </Button>
            )}
          </div>

          {/* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard */}
          {sheetError ? (
            <p className="text-destructive text-sm mb-3" role="alert">
              {sheetError}
            </p>
          ) : null}
          {isGeneratingSheet && talent.sheets.length === 0 ? (
            <Card className="p-8 text-center">
              <Loader2 className="h-12 w-12 mx-auto mb-4 animate-spin text-muted-foreground" />
              <p className="text-muted-foreground">
                {sheetProgressCopy(generatingPhase, 'long')}
              </p>
            </Card>
          ) : talent.sheets.length === 0 ? (
            <Card className="p-8 text-center">
              <User className="h-12 w-12 mx-auto mb-4 text-muted-foreground/30" />
              <p className="text-muted-foreground mb-3">
                No talent sheets yet. Drop a character sheet or generate one
                from the name and description.
              </p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {isGeneratingSheet ? (
                <Card className="overflow-hidden">
                  <div className="aspect-video bg-muted flex flex-col items-center justify-center gap-3">
                    <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {sheetProgressCopy(generatingPhase)}
                    </p>
                  </div>
                </Card>
              ) : null}
              {talent.sheets.map((sheet) => (
                <Card
                  key={sheet.id}
                  className={cn(
                    'overflow-hidden',
                    sheet.isDefault && 'ring-2 ring-primary'
                  )}
                >
                  <div className="aspect-video bg-muted relative">
                    {sheet.imageUrl ? (
                      <img
                        src={sheet.imageUrl}
                        alt={sheet.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <User className="h-12 w-12 text-muted-foreground/30" />
                      </div>
                    )}

                    {/* Source badge */}
                    <div className="absolute top-2 left-2 px-2 py-1 bg-background/80 backdrop-blur-sm rounded text-xs">
                      {sheet.source === 'ai_generated' && (
                        <span className="flex items-center gap-1">
                          <Sparkles className="h-3 w-3" />
                          AI
                        </span>
                      )}
                      {sheet.source === 'manual_upload' && (
                        <span className="flex items-center gap-1">
                          <Upload className="h-3 w-3" />
                          Upload
                        </span>
                      )}
                    </div>

                    {/* Default badge */}
                    {sheet.isDefault && (
                      <div className="absolute top-2 right-2 px-2 py-1 bg-primary text-primary-foreground rounded text-xs font-medium">
                        Default
                      </div>
                    )}
                  </div>

                  <div className="p-3 flex items-center justify-between gap-2">
                    <p className="font-medium text-sm line-clamp-1">
                      {sheet.name}
                    </p>
                    {canManageTalent &&
                      talent.sheets.length > 1 &&
                      !sheet.isDefault && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setDefaultSheet.mutate({
                              sheetId: sheet.id,
                              talentId: talent.id,
                            })
                          }
                          disabled={setDefaultSheet.isPending}
                        >
                          Set as Default
                        </Button>
                      )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>

        {canManageTalent ? (
          <section className="mb-8 flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Drop a sheet or photos</h2>
            <p className="text-sm text-muted-foreground">
              Drop a character sheet to use it as-is, or drop photos to generate
              a sheet.
            </p>
            {dropFiles.length > 0 ? (
              <PortraitAttestationFields
                statement={uploadStatement}
                attested={attested}
                onAttestedChange={setAttested}
                authorizationBasis={authorizationBasis}
                onAuthorizationBasisChange={setAuthorizationBasis}
              />
            ) : null}
            <TalentMediaUpload
              files={dropFiles}
              onFilesChange={(next) => {
                setDropFiles(next);
                if (next.length === 0) {
                  setAttested(false);
                  setAuthorizationBasis('');
                }
              }}
              talentId={talent.id}
              portraitAttestation={
                canUpload
                  ? {
                      statementVersion: uploadStatement.version,
                      authorizationBasis: uploadStatement.requiresBasis
                        ? authorizationBasis.trim()
                        : undefined,
                    }
                  : undefined
              }
              onComplete={() => {
                setDropFiles([]);
                setAttested(false);
                setAuthorizationBasis('');
              }}
            />
          </section>
        ) : null}
      </PageContainer>
    </div>
  );
}
