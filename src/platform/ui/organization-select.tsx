import { Label } from '@/ui/shadcn/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
import type { OrganizationOption } from '@/platform/server/db/scoped';

/** Which organization a login acts for. A single organization is shown, not offered. */
export function OrganizationSelect({
  organizations,
  value,
  onValueChange,
}: {
  organizations: OrganizationOption[];
  value: string;
  onValueChange: (organizationId: string) => void;
}) {
  if (organizations.length < 2) {
    return (
      <p className="text-sm">
        Organization: <strong>{organizations[0]?.name}</strong>
      </p>
    );
  }
  const items = organizations.map((org) => ({
    value: org.id,
    label: org.name,
  }));
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="login-organization">Organization</Label>
      <Select
        value={value}
        items={items}
        onValueChange={(next) => {
          if (typeof next === 'string') onValueChange(next);
        }}
      >
        <SelectTrigger id="login-organization" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
