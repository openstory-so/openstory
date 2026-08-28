import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  PORTRAIT_RIGHTS_V1,
  type AttestationStatement,
} from '@/lib/compliance/attestations';

type PortraitAttestationFieldsProps = {
  statement?: AttestationStatement;
  attested: boolean;
  onAttestedChange: (attested: boolean) => void;
  authorizationBasis: string;
  onAuthorizationBasisChange: (value: string) => void;
};

export function PortraitAttestationFields({
  statement = PORTRAIT_RIGHTS_V1,
  attested,
  onAttestedChange,
  authorizationBasis,
  onAuthorizationBasisChange,
}: PortraitAttestationFieldsProps) {
  return (
    <div
      className={
        statement.requiresBasis
          ? 'flex flex-col gap-3 rounded-lg border border-destructive/40 p-4'
          : 'flex flex-col gap-3 rounded-lg border border-border p-4'
      }
    >
      <div className="flex items-start gap-3">
        <Checkbox
          id="portrait-attestation"
          checked={attested}
          onCheckedChange={(checked) => onAttestedChange(checked === true)}
          aria-describedby="portrait-attestation-text"
        />
        <div className="flex flex-col gap-2">
          <Label htmlFor="portrait-attestation" className="leading-snug">
            {statement.label}
          </Label>
          <p
            id="portrait-attestation-text"
            className="text-xs leading-relaxed text-muted-foreground"
          >
            {statement.text}
          </p>
        </div>
      </div>
      {statement.requiresBasis ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="authorization-basis">Basis for authorization</Label>
          <Input
            id="authorization-basis"
            value={authorizationBasis}
            onChange={(event) => onAuthorizationBasisChange(event.target.value)}
            placeholder="e.g. signed release on file, this is me, contract #123"
            autoComplete="off"
          />
        </div>
      ) : null}
    </div>
  );
}
