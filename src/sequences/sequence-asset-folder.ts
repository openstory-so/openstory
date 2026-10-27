/**
 * Which manifest rows still need writing. A row is skipped when the previous
 * manifest recorded the same versionId for that path and the file is still
 * there. The browser folder save uses this. The stitch command keeps its own
 * copy: the package cannot import the app.
 */
import type { SequenceAsset } from './sequence-assets';

export type FolderAsset = Pick<
  SequenceAsset,
  'relativePath' | 'versionId' | 'url' | 'text'
>;

export function versionsByPath(manifest: unknown): Map<string, string> {
  const assets =
    manifest &&
    typeof manifest === 'object' &&
    'assets' in manifest &&
    Array.isArray(manifest.assets)
      ? manifest.assets
      : [];
  const versions = new Map<string, string>();
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue;
    const path = 'relativePath' in asset ? asset.relativePath : null;
    const versionId = 'versionId' in asset ? asset.versionId : null;
    if (typeof path === 'string' && typeof versionId === 'string') {
      versions.set(path, versionId);
    }
  }
  return versions;
}

export function pendingAssets(
  assets: readonly FolderAsset[],
  previous: ReadonlyMap<string, string>,
  exists: (relativePath: string) => boolean
): FolderAsset[] {
  return assets.filter((asset) => {
    if (!safeRelativePath(asset.relativePath)) return false;
    if (asset.url == null && asset.text == null) return false;
    return !(
      previous.get(asset.relativePath) === asset.versionId &&
      exists(asset.relativePath)
    );
  });
}

function safeRelativePath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\')) return false;
  return path
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..');
}
