import { useState } from 'react';
import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/ui/shadcn/dialog';
import { statementFor } from '@/platform/compliance/attestations';
import { PortraitAttestationFields } from './portrait-attestation-fields';
import { TalentMediaUpload } from './talent-media-upload';

type AddTalentMediaDialogProps = {
  talentId: string;
  isHuman: boolean;
  trigger?: React.ReactNode;
};

export const AddTalentMediaDialog: React.FC<AddTalentMediaDialogProps> = ({
  talentId,
  isHuman,
  trigger,
}) => {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadCount, setUploadCount] = useState(0);
  const [attested, setAttested] = useState(false);
  const [authorizationBasis, setAuthorizationBasis] = useState('');

  const handleClose = () => {
    setFiles([]);
    setUploadCount(0);
    setAttested(false);
    setAuthorizationBasis('');
    setOpen(false);
  };

  // Only a real person's likeness is signed for (#1581).
  const statement = statementFor({
    subjectType: 'talent',
    depictsRealPerson: true,
  });
  const canUpload =
    !isHuman || (attested && authorizationBasis.trim().length > 0);

  const isUploading = files.length > uploadCount;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => (isOpen ? setOpen(true) : handleClose())}
    >
      <DialogTrigger asChild>
        {trigger ?? <Button variant="outline">Add Media</Button>}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Reference Media</DialogTitle>
          <DialogDescription>
            Drop a character sheet or reference photos. Confirm authorization
            before the files upload.
          </DialogDescription>
        </DialogHeader>

        {isHuman ? (
          <PortraitAttestationFields
            statement={statement}
            attested={attested}
            onAttestedChange={setAttested}
            authorizationBasis={authorizationBasis}
            onAuthorizationBasisChange={setAuthorizationBasis}
          />
        ) : null}

        <TalentMediaUpload
          files={files}
          onFilesChange={setFiles}
          talentId={talentId}
          requiresAttestation={isHuman}
          portraitAttestation={
            isHuman && canUpload
              ? {
                  statementVersion: statement.version,
                  authorizationBasis: authorizationBasis.trim(),
                }
              : undefined
          }
          onComplete={() => setUploadCount((c) => c + 1)}
        />

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            onClick={handleClose}
            disabled={isUploading || (files.length > 0 && !canUpload)}
          >
            {isUploading
              ? 'Uploading…'
              : files.length > 0 && !canUpload
                ? 'Confirm authorization to upload'
                : 'Done'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
