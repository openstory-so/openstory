import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { routeParams } from '@/components/layout/breadcrumbs';
import { PageContainer } from '@/components/layout/page-container';
import { EditLocationDialog } from '@/components/location-library/edit-location-dialog';
import { LocationMediaUpload } from '@/components/location-library/location-media-upload';
import { PageDescription } from '@/components/typography/page-description';
import { PageHeader } from '@/components/typography/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useAddLocationSheets,
  useDeleteLibraryLocation,
  useDeleteLocationSheet,
  useLibraryLocationById,
} from '@/hooks/use-location-library';
import { useLocationSheetRealtime } from '@/hooks/use-location-realtime';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';

function LibraryLocationCrumbLabel({ id }: { id: string }) {
  const { data } = useLibraryLocationById(id);
  return <>{data?.name ?? '…'}</>;
}

export const Route = createFileRoute('/_app/locations/$locationId')({
  component: LocationDetailPage,
  staticData: {
    breadcrumb: (match) => {
      const { locationId } = routeParams<{ locationId: string }>(match);
      return [
        { label: 'Locations', to: '/locations' },
        { label: <LibraryLocationCrumbLabel id={locationId} /> },
      ];
    },
  },
});

function LocationDetailPage() {
  const { locationId } = Route.useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthGate();
  const {
    data: location,
    isLoading,
    error,
  } = useLibraryLocationById(locationId);
  const deleteLocation = useDeleteLibraryLocation();
  const addSheets = useAddLocationSheets();
  const deleteSheet = useDeleteLocationSheet();
  // Anonymous visitors view locations read-only; don't open a realtime channel.
  const { isGenerating: isGeneratingSheet, error: sheetError } =
    useLocationSheetRealtime(isAuthenticated ? locationId : undefined);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadedUrls, setUploadedUrls] = useState<string[]>([]);
  const [isAddingImages, setIsAddingImages] = useState(false);

  const handleDelete = async () => {
    if (!location) return;
    if (!confirm(`Delete "${location.name}"? This cannot be undone.`)) return;

    await deleteLocation.mutateAsync(location.id);
    void navigate({ to: '/locations' });
  };

  const handleAddImages = async () => {
    if (uploadedUrls.length === 0) return;

    await addSheets.mutateAsync({
      locationId,
      imageUrls: uploadedUrls,
    });

    setUploadFiles([]);
    setUploadedUrls([]);
    setIsAddingImages(false);
  };

  const handleDeleteSheet = async (sheetId: string) => {
    if (!confirm('Delete this reference image?')) return;
    await deleteSheet.mutateAsync({ sheetId, locationId });
  };

  const handleCancelAdd = () => {
    setUploadFiles([]);
    setUploadedUrls([]);
    setIsAddingImages(false);
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
            <Skeleton className="aspect-video rounded-lg" />
            <Skeleton className="aspect-video rounded-lg" />
            <Skeleton className="aspect-video rounded-lg" />
          </div>
          <div className="mt-6 space-y-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </PageContainer>
      </div>
    );
  }

  if (error || !location) {
    return (
      <div className="h-full overflow-auto">
        <PageContainer>
          <Card className="p-8 text-center">
            <p className="text-destructive mb-4">
              {error?.message || 'Location not found'}
            </p>
            <Button variant="outline" asChild>
              <Link to="/locations">Back to Locations</Link>
            </Button>
          </Card>
        </PageContainer>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <PageContainer>
        {/* Back link */}
        <Button variant="ghost" size="sm" className="mb-4 -ml-2" asChild>
          <Link to="/locations">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Locations
          </Link>
        </Button>

        <PageHeader
          actions={
            isAuthenticated ? (
              <div className="flex items-center gap-2">
                <EditLocationDialog
                  location={location}
                  trigger={
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="Edit location"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  }
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void handleDelete()}
                  disabled={deleteLocation.isPending}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ) : undefined
          }
        >
          <h1 className="sr-only">{location.name}</h1>
          {location.description && (
            <PageDescription>{location.description}</PageDescription>
          )}
        </PageHeader>

        {/* Location Sheet Section */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Location Sheet
          </h2>

          {(() => {
            const defaultSheet = location.sheets.find((s) => s.isDefault);
            const sheetImageUrl =
              defaultSheet?.imageUrl ?? location.referenceImageUrl;

            return sheetImageUrl ? (
              <Card className="overflow-hidden relative">
                <img
                  src={sheetImageUrl}
                  alt={`${location.name} location sheet`}
                  className="w-full h-auto"
                />
                {isGeneratingSheet && (
                  <div className="absolute inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center">
                    <div className="flex flex-col items-center gap-2">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                      <span className="text-sm font-medium">
                        Generating location sheet…
                      </span>
                    </div>
                  </div>
                )}
              </Card>
            ) : (
              <Card className="p-8 text-center">
                <MapPin className="h-12 w-12 mx-auto mb-4 text-muted-foreground/30" />
                <p className="text-muted-foreground">
                  {isGeneratingSheet
                    ? 'Generating location sheet…'
                    : 'Upload reference images to generate a location sheet.'}
                </p>
                {isGeneratingSheet && (
                  <Loader2 className="h-6 w-6 animate-spin text-primary mx-auto mt-3" />
                )}
                {sheetError && (
                  <p className="text-destructive text-sm mt-3">{sheetError}</p>
                )}
              </Card>
            );
          })()}
        </section>

        {/* Reference Images Section */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Reference Images</h2>
            {isAuthenticated && !isAddingImages && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsAddingImages(true)}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Images
              </Button>
            )}
          </div>

          {isAddingImages && (
            <Card className="p-4 mb-4 max-w-2xl">
              <div className="flex flex-col gap-4">
                <LocationMediaUpload
                  files={uploadFiles}
                  onFilesChange={setUploadFiles}
                  onUploadedUrlsChange={setUploadedUrls}
                  disabled={addSheets.isPending}
                  maxFiles={5}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancelAdd}
                    disabled={addSheets.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void handleAddImages()}
                    disabled={
                      uploadedUrls.length === 0 ||
                      uploadFiles.length > uploadedUrls.length ||
                      addSheets.isPending
                    }
                  >
                    {addSheets.isPending ? 'Adding…' : 'Add Images'}
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {/* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard */}
          {location.sheets &&
          location.sheets.some((s) => s.imageUrl && !s.isDefault) ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {location.sheets
                .filter((sheet) => !!sheet.imageUrl && !sheet.isDefault)
                .map((sheet) => (
                  <Card key={sheet.id} className="overflow-hidden group">
                    <div className="aspect-video bg-muted relative">
                      <img
                        src={sheet.imageUrl ?? ''}
                        alt={sheet.name}
                        className="w-full h-full object-cover"
                      />
                      {isAuthenticated && (
                        <button
                          className="absolute top-2 right-2 p-1.5 bg-destructive text-destructive-foreground rounded opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => void handleDeleteSheet(sheet.id)}
                          disabled={deleteSheet.isPending}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </Card>
                ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No reference images uploaded yet.
            </p>
          )}
        </section>

        {/* Location Details */}
        <section>
          <h2 className="text-lg font-semibold mb-4">Details</h2>

          <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {location.sequenceTitle && location.sequenceTitle !== 'Library' && (
              <div className="space-y-1">
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Source
                </dt>
                <dd className="text-sm">{location.sequenceTitle}</dd>
              </div>
            )}

            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Created
              </dt>
              <dd className="text-sm">
                {/* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard */}
                {location.createdAt
                  ? new Date(location.createdAt).toLocaleDateString()
                  : 'Unknown'}
              </dd>
            </div>
          </dl>
        </section>
      </PageContainer>
    </div>
  );
}
