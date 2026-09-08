import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { Input } from '@/components/ui/input';
import {
  defaultPhoneCountry,
  phoneCountries,
  splitDialCode,
  type PhoneCountry,
} from '@/shared/phone-countries';
import { cn } from '@/shared/utils';

/**
 * Flag picker + one field holding the full international number
 * ("+44 7700 900123"). The picker rewrites the field's prefix; typing or
 * pasting a different "+code" moves the picker. Submits as `phoneNumber`.
 *
 * Native `<select>` on purpose: type-to-search on desktop, the wheel picker
 * on phones, and keyboard support for free — no popover/command stack.
 * Options are "Name +code" (name first so type-to-search matches).
 */
function PhoneInput({
  className,
  disabled,
  countries = phoneCountries(),
  defaultCountry,
  ...props
}: Omit<
  React.ComponentProps<'input'>,
  'type' | 'name' | 'value' | 'defaultValue' | 'onChange'
> & {
  countries?: PhoneCountry[];
  /** ISO code to start on (e.g. the visitor's geo-IP country). */
  defaultCountry?: string | null;
}) {
  const byIso = (iso: string) => countries.find((c) => c.iso === iso);
  const [value, setValue] = React.useState(() => {
    const start = byIso(defaultPhoneCountry(defaultCountry));
    return start ? `+${start.dialCode} ` : '+';
  });
  const [country, setCountry] = React.useState(
    () => splitDialCode(value)?.iso ?? ''
  );
  const selected = byIso(country);

  const onSelect = (iso: string) => {
    const next = byIso(iso);
    if (!next) return;
    const national = splitDialCode(value, country)?.national ?? '';
    setCountry(iso);
    setValue(`+${next.dialCode} ${national}`);
  };

  const onType = (typed: string) => {
    const withPlus = typed.startsWith('+') ? typed : `+${typed}`;
    setValue(withPlus);
    const split = splitDialCode(withPlus, country);
    if (split && split.iso !== country) setCountry(split.iso);
    else if (!split && country) setCountry('');
  };

  return (
    <div className={cn('flex gap-2', className)}>
      <div className="relative shrink-0">
        <select
          aria-label="Country"
          value={country}
          onChange={(e) => onSelect(e.target.value)}
          disabled={disabled}
          className="peer absolute inset-0 w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        >
          <option value="" disabled hidden>
            Country
          </option>
          {countries.map((c) => (
            <option key={c.iso} value={c.iso}>
              {c.name} +{c.dialCode}
            </option>
          ))}
        </select>
        {/* Visible face. The select above takes focus and clicks, so a11y
            and the native picker stay intact. */}
        <div
          aria-hidden
          className="pointer-events-none flex h-8 items-center gap-1 rounded-lg border border-input px-2.5 text-base transition-colors peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 peer-disabled:opacity-50 md:text-sm dark:bg-input/30"
        >
          <span className="w-[1.25em] text-center">
            {selected?.flag ?? '🌐'}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </div>
      </div>
      <Input
        name="phoneNumber"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={value}
        onChange={(e) => onType(e.target.value)}
        disabled={disabled}
        {...props}
      />
    </div>
  );
}

export { PhoneInput };
