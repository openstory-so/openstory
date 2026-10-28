/**
 * Asset page (#2209). Groups the manifest, downloads one file, and in
 * Chromium downloads the folder. Other browsers keep the per-row download.
 */
import {
  pendingAssets,
  versionsByPath,
} from '@/sequences/sequence-asset-folder';
import type {
  SequenceAsset,
  SequenceAssetsBody,
} from '@/sequences/sequence-assets';
import { Button } from '@/ui/shadcn/button';
import { ToggleGroup, ToggleGroupItem } from '@/ui/shadcn/toggle-group';
import { Terminal } from '@/ui/terminal-command';
import { useState } from 'react';

type DirHandle = {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<DirHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<{
    getFile(): Promise<File>;
    createWritable(): Promise<
      WritableStream<Uint8Array> & {
        write(data: string | BufferSource): Promise<void>;
        close(): Promise<void>;
      }
    >;
  }>;
};

export function SequenceAssetsView({
  sequenceId,
  body,
  scope,
  includeExports,
  onScope,
  onExports,
}: {
  sequenceId: string;
  body: SequenceAssetsBody;
  scope: 'selected' | 'history';
  includeExports: boolean;
  onScope: (scope: 'selected' | 'history') => void;
  onExports: (include: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const groups = groupAssets(body.assets);
  const folderSave =
    typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  const command = sequencePullCommand(sequenceId, {
    history: scope === 'history',
    exports: includeExports,
    origin: typeof window === 'undefined' ? undefined : window.location.origin,
  });

  const fileCount = `${body.assets.length} ${body.assets.length === 1 ? 'file' : 'files'}`;
  const folderName = sequenceAssetFolderName(body);
  const hint = folderSave
    ? `${fileCount}. Download folder opens in Movies and writes a folder named ${folderName}. Chrome blocks your home folder, Desktop, Documents, and Downloads.`
    : `${fileCount}. This browser saves one file at a time. Use Download on a row, or the command below.`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 pt-4 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            value={scope}
            variant="outline"
            size="sm"
            spacing={0}
            onValueChange={(next) => {
              if (next === 'selected' || next === 'history') onScope(next);
            }}
          >
            <ToggleGroupItem value="selected">Current cut</ToggleGroupItem>
            <ToggleGroupItem value="history">All versions</ToggleGroupItem>
          </ToggleGroup>
          <Button
            type="button"
            size="sm"
            variant={includeExports ? 'default' : 'outline'}
            aria-pressed={includeExports}
            onClick={() => onExports(!includeExports)}
          >
            Include renders
          </Button>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={saving || body.assets.length === 0}
          onClick={() => {
            setSaving(true);
            setNote(null);
            saveFolder(body)
              .then((result) => setNote(result))
              .catch((error: unknown) => {
                if (
                  error instanceof DOMException &&
                  error.name === 'AbortError'
                ) {
                  setNote(
                    'Chrome blocked that folder. In the picker, open Movies, or open a folder you made inside Downloads. Do not choose Downloads, Documents, Desktop, or your home folder.'
                  );
                  return;
                }
                setNote(
                  error instanceof Error ? error.message : 'Download failed'
                );
              })
              .finally(() => setSaving(false));
          }}
        >
          {saving ? 'Downloading…' : 'Download folder'}
        </Button>
      </div>
      <output className="block shrink-0 px-4 pt-3 text-sm text-muted-foreground md:px-6">
        {note ?? hint}
      </output>
      <div className="shrink-0 px-4 pt-3 md:px-6">
        <Terminal
          label="Pull command"
          comment="Run this to download these files."
          lines={[command]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6 md:px-6">
        {body.assets.length === 0 ? (
          <p>This sequence has no stored files yet.</p>
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map(([group, assets]) => (
              <section key={group} className="flex flex-col gap-1">
                <h2 className="text-sm text-muted-foreground">{group}</h2>
                <ul className="flex flex-col">
                  {assets.map((asset) => (
                    <li
                      key={asset.id}
                      className="flex items-center justify-between gap-3 border-b py-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm">
                          {`${asset.label}${asset.discarded ? ' (discarded)' : ''}${asset.shared ? ' (shared)' : ''}`}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {asset.relativePath}
                        </span>
                      </span>
                      {asset.url ? (
                        <Button variant="outline" size="sm" asChild>
                          <a href={asset.url} download>
                            Download
                          </a>
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Directory name inside the folder the user picks. */
export function sequenceAssetFolderName(body: SequenceAssetsBody): string {
  const cleaned = body.title
    .replace(/[\\/:\0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return body.sequenceId;
  return cleaned;
}

/** The pull line for the list on screen. Production omits `--origin`. */
export function sequencePullCommand(
  sequenceId: string,
  options: { history: boolean; exports: boolean; origin?: string }
): string {
  const parts = ['npx @openstory/stitch pull', sequenceId];
  if (options.history) parts.push('--history');
  if (options.exports) parts.push('--exports');
  if (options.origin && options.origin !== 'https://openstory.so') {
    parts.push('--origin', options.origin);
  }
  return parts.join(' ');
}

function groupAssets(assets: SequenceAsset[]): [string, SequenceAsset[]][] {
  const groups = new Map<string, SequenceAsset[]>();
  for (const asset of assets) {
    const list = groups.get(asset.group) ?? [];
    list.push(asset);
    groups.set(asset.group, list);
  }
  return [...groups];
}

async function saveFolder(body: SequenceAssetsBody): Promise<string> {
  const picker = (
    window as Window & {
      showDirectoryPicker?: (options: {
        mode: 'readwrite';
        id: string;
        startIn: 'videos';
      }) => Promise<DirHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) {
    return 'This browser saves one file at a time. Use Download on each row.';
  }
  // A fresh id so a previously rejected home, Desktop, Documents, or
  // Downloads folder is not offered again. Movies is not on Chrome's block
  // list, so Select works there. Files go in a child named for the sequence.
  const parent = await picker({
    mode: 'readwrite',
    id: 'openstory-sequence-assets',
    startIn: 'videos',
  });
  const root = await parent.getDirectoryHandle(sequenceAssetFolderName(body), {
    create: true,
  });
  const previous = versionsByPath(await readManifest(root));
  const present = new Set<string>();
  for (const asset of body.assets) {
    if (
      previous.get(asset.relativePath) === asset.versionId &&
      (await fileExists(root, asset.relativePath))
    ) {
      present.add(asset.relativePath);
    }
  }
  const pending = pendingAssets(body.assets, previous, (path) =>
    present.has(path)
  );
  for (const asset of pending) {
    if (asset.text != null) {
      await writeText(root, asset.relativePath, asset.text);
      continue;
    }
    if (!asset.url) continue;
    const response = await fetch(asset.url, { credentials: 'same-origin' });
    if (!response.ok || !response.body) {
      throw new Error(
        `Could not download ${asset.relativePath} (${response.status})`
      );
    }
    await writeStream(root, asset.relativePath, response.body);
  }
  await writeText(
    root,
    'manifest.json',
    `${JSON.stringify({ ...body, assets: body.assets }, null, 2)}\n`
  );
  const skipped = body.assets.length - pending.length;
  return `Downloaded ${pending.length} files. Skipped ${skipped} already there.`;
}

async function readManifest(root: DirHandle): Promise<unknown> {
  try {
    const handle = await root.getFileHandle('manifest.json');
    return JSON.parse(await (await handle.getFile()).text());
  } catch {
    return null;
  }
}

async function fileExists(
  root: DirHandle,
  relativePath: string
): Promise<boolean> {
  try {
    await fileHandle(root, relativePath, false);
    return true;
  } catch {
    return false;
  }
}

async function writeText(root: DirHandle, relativePath: string, text: string) {
  const handle = await fileHandle(root, relativePath, true);
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function writeStream(
  root: DirHandle,
  relativePath: string,
  body: ReadableStream<Uint8Array>
) {
  const handle = await fileHandle(root, relativePath, true);
  const writable = await handle.createWritable();
  await body.pipeTo(writable);
}

async function fileHandle(
  root: DirHandle,
  relativePath: string,
  create: boolean
) {
  const parts = relativePath.split('/');
  const name = parts.pop();
  if (!name) throw new Error('Missing file name');
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir.getFileHandle(name, { create });
}
