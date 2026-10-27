/**
 * Asset page (#2209). Groups the manifest, downloads one file, and in
 * Chromium saves the folder. Other browsers keep the per-row download.
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={scope === 'selected' ? 'default' : 'outline'}
          onClick={() => onScope('selected')}
        >
          Current cut
        </Button>
        <Button
          type="button"
          variant={scope === 'history' ? 'default' : 'outline'}
          onClick={() => onScope('history')}
        >
          All versions
        </Button>
        <Button
          type="button"
          variant={includeExports ? 'default' : 'outline'}
          onClick={() => onExports(!includeExports)}
        >
          {includeExports ? 'Hide renders' : 'Include renders'}
        </Button>
        <Button
          type="button"
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
                  return;
                }
                setNote(error instanceof Error ? error.message : 'Save failed');
              })
              .finally(() => setSaving(false));
          }}
        >
          {saving ? 'Saving…' : 'Save folder'}
        </Button>
      </div>
      {note ? (
        <output className="text-sm text-muted-foreground">{note}</output>
      ) : null}
      {!folderSave ? (
        <p>
          This browser saves one file at a time. Use Download on each row, or{' '}
          <code>npx @openstory/stitch assets {sequenceId}</code>.
        </p>
      ) : null}
      {body.assets.length === 0 ? (
        <p>This sequence has no stored files yet.</p>
      ) : (
        groups.map(([group, assets]) => (
          <section key={group} className="flex flex-col gap-2">
            <h2>{group}</h2>
            <ul className="flex flex-col gap-2">
              {assets.map((asset) => (
                <li
                  key={asset.id}
                  className="flex flex-wrap items-center justify-between gap-3"
                >
                  <span>
                    {`${asset.label}${asset.discarded ? ' (discarded)' : ''}${asset.shared ? ' (shared)' : ''}`}
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
        ))
      )}
    </div>
  );
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
      }) => Promise<DirHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) {
    return 'This browser saves one file at a time. Use Download on each row.';
  }
  const root = await picker({ mode: 'readwrite' });
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
  return `Saved ${pending.length} files. Skipped ${skipped} already there.`;
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
