const STORAGE_KEY = 'docs-return-url';

const isDocsPath = (pathname: string): boolean =>
  pathname === '/docs' || pathname.startsWith('/docs/');

export function rememberDocsReturnUrl(href: string): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(STORAGE_KEY, href);
}

export function getDocsReturnUrl(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  return sessionStorage.getItem(STORAGE_KEY);
}

export { isDocsPath };
