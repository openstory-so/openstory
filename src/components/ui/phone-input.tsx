import * as React from 'react';

import { Input } from '@/components/ui/input';
import {
  defaultPhoneCountry,
  phoneCountries,
  type PhoneCountry,
} from '@/shared/phone-countries';
import { cn } from '@/shared/utils';

/**
 * Country picker + national number, both uncontrolled so a plain FormData
 * read works: `country` is the ISO code, `national` the digits typed.
 * Compose with `composePhoneNumber(dialCodeFor(country), national)`.
 *
 * Native `<select>` on purpose: type-to-search on desktop, the wheel picker
 * on phones, and keyboard support for free — no popover/command stack.
 */
function PhoneInput({
  className,
  disabled,
  countries = phoneCountries(),
  ...props
}: Omit<React.ComponentProps<'input'>, 'type' | 'name'> & {
  countries?: PhoneCountry[];
}) {
  const [country, setCountry] = React.useState(defaultPhoneCountry);
  const selected = countries.find((c) => c.iso === country);
  return (
    <div className={cn('flex gap-2', className)}>
      <div className="relative shrink-0">
        <select
          name="country"
          aria-label="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          disabled={disabled}
          className="peer absolute inset-0 w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        >
          {countries.map((c) => (
            <option key={c.iso} value={c.iso}>
              {c.name} (+{c.dialCode})
            </option>
          ))}
        </select>
        {/* Visible face: flag + dial code. The select above takes focus and
            clicks, so a11y and the native picker stay intact. */}
        <div
          aria-hidden
          className="pointer-events-none flex h-8 items-center gap-1.5 rounded-lg border border-input px-2.5 text-base tabular-nums transition-colors peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 peer-disabled:opacity-50 md:text-sm dark:bg-input/30"
        >
          <span>{selected?.flag}</span>
          <span>+{selected?.dialCode}</span>
        </div>
      </div>
      <Input
        name="national"
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        disabled={disabled}
        {...props}
      />
    </div>
  );
}

export { PhoneInput };
