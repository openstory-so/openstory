import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import { Textarea } from '@/ui/shadcn/textarea';

export const BibleField: React.FC<{
  idPrefix: string;
  label: string;
  name: string;
  defaultValue: string | null;
  textarea?: boolean;
  required?: boolean;
  placeholder?: string;
  hint?: string;
}> = ({
  idPrefix,
  label,
  name,
  defaultValue,
  textarea,
  required,
  placeholder,
  hint,
}) => {
  const id = `${idPrefix}-${name}`;
  return (
    <div className="flex flex-col gap-1">
      <Label
        htmlFor={id}
        className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </Label>
      {textarea ? (
        <Textarea
          id={id}
          name={name}
          defaultValue={defaultValue ?? ''}
          placeholder={placeholder}
          rows={3}
        />
      ) : (
        <Input
          id={id}
          name={name}
          defaultValue={defaultValue ?? ''}
          placeholder={placeholder}
          required={required}
        />
      )}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
};
