import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export const BibleField: React.FC<{
  idPrefix: string;
  label: string;
  name: string;
  defaultValue: string | null;
  textarea?: boolean;
  required?: boolean;
}> = ({ idPrefix, label, name, defaultValue, textarea, required }) => {
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
          rows={3}
        />
      ) : (
        <Input
          id={id}
          name={name}
          defaultValue={defaultValue ?? ''}
          required={required}
        />
      )}
    </div>
  );
};
