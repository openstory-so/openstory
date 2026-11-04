import { clsx, type ClassValue } from 'clsx';
import type React from 'react';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Up to two letters for an avatar fallback. */
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return '';
  if (parts.length === 1) return first.substring(0, 2).toUpperCase();
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

/** A stable background for an initials avatar, hashed from the id or name. */
export function avatarStyle(seed: string): React.CSSProperties {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0;
  return {
    backgroundColor: `oklch(0.5 0.14 ${Math.abs(hash) % 360})`,
    color: 'white',
  };
}
