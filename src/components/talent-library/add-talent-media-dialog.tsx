import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { statementFor } from '@/lib/compliance/attestations';
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

  const statement = statementFor({
    subjectType: 'talent',
    depictsRealPerson: isHuman,
  });
  const canUpload =
    attested &&
    (!statement.requiresBasis || authorizationBasis.trim().length > 0);

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

        <PortraitAttestationFields
          statement={statement}
          attested={attested}
          onAttestedChange={setAttested}
          authorizationBasis={authorizationBasis}
          onAuthorizationBasisChange={setAuthorizationBasis}
        />

        <TalentMediaUpload
          files={files}
          onFilesChange={setFiles}
          talentId={talentId}
          portraitAttestation={
            canUpload
              ? {
                  statementVersion: statement.version,
                  authorizationBasis: statement.requiresBasis
                    ? authorizationBasis.trim()
                    : undefined,
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
