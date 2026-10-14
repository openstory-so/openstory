import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const bin = join(dirname(fileURLToPath(import.meta.url)), '../bin/stitch.mjs');

async function tempDir(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('stitch bin', () => {
  it('installs the skill into .agents/skills/stitch', async () => {
    const cwd = await tempDir('stitch-bin-');
    try {
      const first = await exec(process.execPath, [bin], { cwd });
      const dest = join(await realpath(cwd), '.agents', 'skills', 'stitch');
      expect(first.stdout).toBe(`${dest}\n`);
      const skill = await readFile(join(dest, 'SKILL.md'), 'utf8');
      expect(skill).toContain('name: stitch');

      const second = await exec(process.execPath, [bin], { cwd });
      expect(second.stdout).toBe(`${dest}\n`);
      expect(await readFile(join(dest, 'SKILL.md'), 'utf8')).toContain(
        'name: stitch'
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('installs under the home directory with --global', async () => {
    const home = await tempDir('stitch-home-');
    const cwd = await tempDir('stitch-cwd-');
    try {
      const { stdout } = await exec(process.execPath, [bin, '-g'], {
        cwd,
        env: { ...process.env, HOME: home },
      });
      const dest = join(home, '.agents', 'skills', 'stitch');
      expect(stdout).toBe(`${dest}\n`);
      const skill = await readFile(join(dest, 'SKILL.md'), 'utf8');
      expect(skill).toContain('name: stitch');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects an unknown argument', async () => {
    await expect(
      exec(process.execPath, [bin, '--nope'], { cwd: tmpdir() })
    ).rejects.toThrow(/Unknown argument: --nope/);
  });
});
