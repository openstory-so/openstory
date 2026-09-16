import { getRequestHeader } from '@tanstack/react-start/server';

/** Country from the current Cloudflare request; absent for unknown/Tor traffic. */
export function getRequestCountry(): string | undefined {
  const country = getRequestHeader('cf-ipcountry')?.trim().toUpperCase();
  // Cloudflare reports XX for unknown and T1 for Tor, neither a country.
  return country && /^[A-Z]{2}$/.test(country) && country !== 'XX'
    ? country
    : undefined;
}
