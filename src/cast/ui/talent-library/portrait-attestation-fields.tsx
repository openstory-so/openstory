import { Checkbox } from '@/ui/shadcn/checkbox';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import {
  PORTRAIT_RIGHTS_V1,
  type AttestationStatement,
} from '@/platform/compliance/attestations';

type PortraitAttestationFieldsProps = {
  /** Element id prefix; set when two blocks render on one page. */
  id?: string;
  statement?: AttestationStatement;
  attested: boolean;
  onAttestedChange: (attested: boolean) => void;
  authorizationBasis: string;
  onAuthorizationBasisChange: (value: string) => void;
  /** Rendered above the statement, e.g. which tiles it covers. */
  children?: React.ReactNode;
};

export function PortraitAttestationFields({
  id = 'portrait-attestation',
  statement = PORTRAIT_RIGHTS_V1,
  attested,
  onAttestedChange,
  authorizationBasis,
  onAuthorizationBasisChange,
  children,
}: PortraitAttestationFieldsProps) {
  return (
    <div
      className={
        statement.requiresBasis
          ? 'flex flex-col gap-3 rounded-lg border border-destructive/40 p-4'
          : 'flex flex-col gap-3 rounded-lg border border-border p-4'
      }
    >
      {children}
      <div className="flex items-start gap-3">
        <Checkbox
          id={id}
          checked={attested}
          onCheckedChange={(checked) => onAttestedChange(checked === true)}
          aria-describedby={`${id}-text`}
        />
        <div className="flex flex-col gap-2">
          <Label htmlFor={id} className="leading-snug">
            {statement.label}
          </Label>
          <p
            id={`${id}-text`}
            className="text-xs leading-relaxed text-muted-foreground"
          >
            {statement.text}
          </p>
        </div>
      </div>
      {statement.requiresBasis ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-basis`}>Basis for authorization</Label>
          <Input
            id={`${id}-basis`}
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
