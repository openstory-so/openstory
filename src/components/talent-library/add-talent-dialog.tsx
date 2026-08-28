import { useRef, useState } from 'react';
import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useHydrated } from '@/hooks/use-hydrated';
import { useAnalyzeTalentMedia, useCreateTalent } from '@/hooks/use-talent';
import { getFileKey } from '@/lib/utils/upload';
import { statementFor } from '@/lib/compliance/attestations';
import type { Talent } from '@/lib/db/schema';
import { sheetProgressCopy } from '@/lib/talent/sheet-progress-copy';
import {
  strongestSubjectKind,
  type TalentSubjectKind,
} from '@/lib/talent/subject-kind';
import { Loader2, Plus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { PortraitAttestationFields } from './portrait-attestation-fields';
import { TalentMediaUpload } from './talent-media-upload';

type CreatePhase = 'idle' | 'analyzing' | 'creating';
type SheetDetectResult = {
  url: string;
  isSheet: boolean;
  subjectKind: TalentSubjectKind;
  classified: boolean;
};

type AddTalentDialogProps = {
  trigger?: React.ReactNode;
  /** Called with the newly created talent so callers can auto-select it. */
  onCreated?: (talent: Talent) => void;
};

export const AddTalentDialog: React.FC<AddTalentDialogProps> = ({
  trigger,
  onCreated,
}) => {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadedUrls, setUploadedUrls] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sheetFileKeys, setSheetFileKeys] = useState<Set<string>>(new Set());
  const [checkingFileKeys, setCheckingFileKeys] = useState<Set<string>>(
    new Set()
  );
  const [createPhase, setCreatePhase] = useState<CreatePhase>('idle');
  const [subjectKind, setSubjectKind] = useState<TalentSubjectKind | null>(
    null
  );
  // Attestation is required whenever reference media is attached. Human →
  // portrait statement + basis; animated/other → asset statement. `isHuman`
  // is `subjectKind === 'human'`, not “has uploads”.
  const [attested, setAttested] = useState(false);
  const [authorizationBasis, setAuthorizationBasis] = useState('');

  const isHydrated = useHydrated();
  const { requireAuth } = useAuthGate();
  const createTalent = useCreateTalent();
  const detectSheet = useAnalyzeTalentMedia();
  const generateDescription = useAnalyzeTalentMedia();
  const detectJobsRef = useRef(new Map<string, Promise<SheetDetectResult>>());
  const submitGenRef = useRef(0);
  const subjectKindLockedRef = useRef(false);

  const closeAndReset = () => {
    submitGenRef.current += 1;
    detectJobsRef.current.clear();
    subjectKindLockedRef.current = false;
    setFiles([]);
    setUploadedUrls([]);
    setName('');
    setDescription('');
    setSheetFileKeys(new Set());
    setCheckingFileKeys(new Set());
    setCreatePhase('idle');
    setSubjectKind(null);
    // Cleared with the rest of the form: an attestation must be made afresh for
    // each upload, never inherited from the previous one.
    setAttested(false);
    setAuthorizationBasis('');
    setOpen(false);
  };

  const handleClose = () => {
    if (
      files.length > 0 &&
      !window.confirm(
        'Discard uploaded reference media? Your uploads will be lost.'
      )
    ) {
      return;
    }
    closeAndReset();
  };

  const queueSheetDetect = (file: File, url: string) => {
    const key = getFileKey(file);
    setCheckingFileKeys((prev) => new Set(prev).add(key));
    let job!: Promise<SheetDetectResult>;
    job = detectSheet
      .mutateAsync({ imageUrls: [url], filenames: [file.name] })
      .then((result) => {
        if (detectJobsRef.current.get(key) !== job) {
          return {
            url,
            isSheet: false,
            subjectKind: 'human' as const,
            classified: false,
          };
        }
        const kind = result.subjectKind;
        if (!subjectKindLockedRef.current) {
          setSubjectKind((prev) =>
            prev ? strongestSubjectKind([prev, kind]) : kind
          );
        }
        if (result.isCharacterSheet) {
          setSheetFileKeys((prev) => new Set(prev).add(key));
          toast.success('Character sheet detected');
        }
        return {
          url,
          isSheet: result.isCharacterSheet,
          subjectKind: kind,
          classified: true,
        };
      })
      .catch(() => {
        if (detectJobsRef.current.get(key) !== job) {
          return {
            url,
            isSheet: false,
            subjectKind: 'human' as const,
            classified: false,
          };
        }
        toast.warning(
          'Could not tell if this is a character sheet. We’ll generate one.'
        );
        if (!subjectKindLockedRef.current) {
          setSubjectKind('human');
        }
        return {
          url,
          isSheet: false,
          subjectKind: 'human' as const,
          classified: false,
        };
      })
      .finally(() => {
        if (detectJobsRef.current.get(key) !== job) return;
        setCheckingFileKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      });
    detectJobsRef.current.set(key, job);
  };

  const handleFilesChange = (newFiles: File[]) => {
    setFiles(newFiles);
    const keys = new Set(newFiles.map(getFileKey));
    for (const key of detectJobsRef.current.keys()) {
      if (!keys.has(key)) detectJobsRef.current.delete(key);
    }
    setCheckingFileKeys((prev) => {
      const next = new Set([...prev].filter((key) => keys.has(key)));
      return next.size === prev.size ? prev : next;
    });
    setSheetFileKeys((prev) => {
      const next = new Set([...prev].filter((key) => keys.has(key)));
      return next.size === prev.size ? prev : next;
    });
    if (newFiles.length === 0) {
      subjectKindLockedRef.current = false;
      setSubjectKind(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();

    // Anonymous visitors can open the dialog and fill the form; the actual
    // add prompts a login.
    if (!requireAuth()) return;

    if (!name.trim()) return;

    const gen = ++submitGenRef.current;
    const detectJobs = [...detectJobsRef.current.values()];
    let detected: SheetDetectResult[] = [];
    if (detectJobs.length > 0) {
      if (checkingFileKeys.size > 0) setCreatePhase('analyzing');
      detected = await Promise.all(detectJobs);
      if (gen !== submitGenRef.current) return;
    }
    const sheetUrlList = detected
      .filter((result) => result.isSheet)
      .map((result) => result.url)
      .filter((url) => uploadedUrls.includes(url));
    const classifiedAll = detected.every((result) => result.classified);

    const kind =
      subjectKind ??
      (detected.length > 0
        ? strongestSubjectKind(detected.map((result) => result.subjectKind))
        : 'other');
    if (uploadedUrls.length > 0 && subjectKind === null) {
      setSubjectKind(kind);
    }

    const depictsRealPerson = kind === 'human';
    const statement = statementFor({
      subjectType: 'talent',
      depictsRealPerson,
    });

    if (uploadedUrls.length > 0) {
      if (!attested) {
        setCreatePhase('idle');
        toast.error(
          depictsRealPerson
            ? 'Confirm you have authorization for this person’s likeness'
            : 'Confirm you hold the rights to this asset'
        );
        return;
      }
      if (statement.requiresBasis && !authorizationBasis.trim()) {
        setCreatePhase('idle');
        toast.error('Add a basis for authorization');
        return;
      }
    }

    setCreatePhase('creating');
    try {
      const { talent, sheetWorkflowRunId } = await createTalent.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        isHuman: depictsRealPerson,
        referenceImageUrls: uploadedUrls,
        // Send an array after a successful client classify so create does not
        // re-classify every photo. Omit when classify failed so the server
        // runs vision. If a sheet URL is present, create still runs vision
        // once for sheet metadata.
        characterSheetImageUrls: classifiedAll ? sheetUrlList : undefined,
        portraitAttestation:
          uploadedUrls.length > 0
            ? {
                statementVersion: statement.version,
                authorizationBasis: statement.requiresBasis
                  ? authorizationBasis.trim()
                  : undefined,
              }
            : undefined,
      });
      if (gen !== submitGenRef.current) return;
      onCreated?.(talent);
      if (sheetWorkflowRunId) {
        toast.success(
          sheetUrlList.length > 0
            ? `Talent added. ${sheetProgressCopy('portrait', 'long')}`
            : `Talent added. ${sheetProgressCopy('sheet', 'long')}`
        );
      } else {
        toast.success('Talent added');
        toast.error('Could not start talent sheet generation');
      }
      closeAndReset();
    } catch (error) {
      if (gen !== submitGenRef.current) return;
      setCreatePhase('idle');
      toast.error('Could not add talent', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const isBusy = createPhase !== 'idle' || createTalent.isPending;
  const isUploading = files.length > uploadedUrls.length;
  const statusMessage =
    createPhase === 'analyzing' ||
    (checkingFileKeys.size > 0 && createPhase === 'idle')
      ? 'Looking at the upload (human, animated, or a sheet). Usually about 20 seconds.'
      : createPhase === 'creating'
        ? 'Saving talent…'
        : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => (isOpen ? setOpen(true) : handleClose())}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button disabled={!isHydrated}>
            <Plus className="mr-2 h-4 w-4" />
            Add Talent
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="max-w-2xl max-h-[90vh] overflow-y-auto"
        onPointerDownOutside={(e) => {
          if (files.length > 0) {
            e.preventDefault();
            handleClose();
          }
        }}
        onEscapeKeyDown={(e) => {
          if (files.length > 0) {
            e.preventDefault();
            handleClose();
          }
        }}
      >
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Add Talent</DialogTitle>
            <DialogDescription>
              Add a new talent to your library.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Talent name…"
                autoComplete="off"
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="description">Description</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={
                    uploadedUrls.length === 0 || generateDescription.isPending
                  }
                  onClick={() => {
                    const count = Math.min(
                      uploadedUrls.length,
                      files.length,
                      8
                    );
                    generateDescription.mutate(
                      {
                        imageUrls: uploadedUrls.slice(0, count),
                        filenames: files
                          .slice(0, count)
                          .map((file) => file.name),
                      },
                      {
                        onSuccess: (result) => {
                          setDescription(result.description);
                          if (!name.trim() && result.suggestedName.trim()) {
                            setName(result.suggestedName.trim());
                          }
                          if (!subjectKindLockedRef.current) {
                            setSubjectKind((prev) =>
                              prev
                                ? strongestSubjectKind([
                                    prev,
                                    result.subjectKind,
                                  ])
                                : result.subjectKind
                            );
                          }
                          toast.success('Description generated from photos');
                        },
                        onError: (error) => {
                          toast.error('Could not generate description', {
                            description:
                              error instanceof Error
                                ? error.message
                                : 'Unknown error',
                          });
                        },
                      }
                    );
                  }}
                >
                  <Sparkles className="h-4 w-4" />
                  {generateDescription.isPending
                    ? 'Generating…'
                    : 'Generate from photos'}
                </Button>
              </div>
              <Textarea
                id="description"
                name="description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Describe the talent's appearance, style…"
                rows={3}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>Reference Media</Label>
              <TalentMediaUpload
                files={files}
                onFilesChange={handleFilesChange}
                onUploadedUrlsChange={setUploadedUrls}
                sheetFileKeys={sheetFileKeys}
                checkingFileKeys={checkingFileKeys}
                onFileUploaded={(file, url) => {
                  if (!file.type.startsWith('image/')) return;
                  queueSheetDetect(file, url);
                }}
                disabled={isBusy}
              />
            </div>

            {uploadedUrls.length > 0 && subjectKind ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <Label id="subject-kind-label">Subject</Label>
                  <ToggleGroup
                    type="single"
                    value={subjectKind}
                    onValueChange={(next) => {
                      if (
                        next !== 'human' &&
                        next !== 'animated' &&
                        next !== 'other'
                      ) {
                        return;
                      }
                      subjectKindLockedRef.current = true;
                      setSubjectKind(next);
                      setAttested(false);
                      setAuthorizationBasis('');
                    }}
                    variant="outline"
                    size="sm"
                    spacing={0}
                    aria-labelledby="subject-kind-label"
                  >
                    <ToggleGroupItem value="human">Human</ToggleGroupItem>
                    <ToggleGroupItem value="animated">Animated</ToggleGroupItem>
                    <ToggleGroupItem value="other">Other</ToggleGroupItem>
                  </ToggleGroup>
                </div>
                <PortraitAttestationFields
                  statement={statementFor({
                    subjectType: 'talent',
                    depictsRealPerson: subjectKind === 'human',
                  })}
                  attested={attested}
                  onAttestedChange={setAttested}
                  authorizationBasis={authorizationBasis}
                  onAuthorizationBasisChange={setAuthorizationBasis}
                />
              </div>
            ) : null}
          </div>

          {statusMessage ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {statusMessage}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isBusy || isUploading}>
              {(createPhase === 'analyzing' ||
                createPhase === 'creating' ||
                createTalent.isPending) && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              <span>
                {createPhase === 'analyzing'
                  ? 'Analyzing photos…'
                  : createPhase === 'creating' || createTalent.isPending
                    ? 'Creating…'
                    : isUploading
                      ? 'Uploading…'
                      : 'Add Talent'}
              </span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
