import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: {
  VIDEO_EXPORT_CONTAINER?: unknown;
  VIDEO_EXPORT_DEV_URL?: string;
} = {};

vi.doMock('#env', () => ({ getEnv: () => env }));

const { isServerExportAvailable } = await import('./server-export-available');

describe('isServerExportAvailable', () => {
  beforeEach(() => {
    delete env.VIDEO_EXPORT_CONTAINER;
    delete env.VIDEO_EXPORT_DEV_URL;
  });

  it('is false when neither the container nor the local bunny URL is set', () => {
    expect(isServerExportAvailable()).toBe(false);
  });

  it('is true when the production container binding exists', () => {
    env.VIDEO_EXPORT_CONTAINER = { idFromName: () => {} };
    expect(isServerExportAvailable()).toBe(true);
  });

  it('is true when VIDEO_EXPORT_DEV_URL points at bun dev:bunny', () => {
    env.VIDEO_EXPORT_DEV_URL = 'http://localhost:8080';
    expect(isServerExportAvailable()).toBe(true);
  });

  it('treats an empty DEV_URL as absent', () => {
    env.VIDEO_EXPORT_DEV_URL = '';
    expect(isServerExportAvailable()).toBe(false);
  });
});
