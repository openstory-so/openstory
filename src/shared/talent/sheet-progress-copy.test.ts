import { describe, expect, it } from 'vitest';
import {
  activityFromProgress,
  isSheetProgressStale,
  parseSheetProgressActivity,
  sheetProgressCopy,
  SHEET_PROGRESS_STALE_MS,
} from './sheet-progress-copy';

describe('sheetProgressCopy', () => {
  it('says creating portrait when the sheet was uploaded', () => {
    expect(sheetProgressCopy('portrait')).toBe('Creating portrait…');
    expect(sheetProgressCopy('portrait', 'long')).toBe(
      'Creating portrait from the uploaded sheet…'
    );
  });

  it('says generating sheet when a 4-panel is being made', () => {
    expect(sheetProgressCopy('sheet')).toBe('Generating sheet…');
  });
});

describe('activityFromProgress', () => {
  it('uses portrait for an uploaded-sheet generating event', () => {
    expect(
      activityFromProgress({ status: 'generating', activity: 'portrait' })
    ).toBe('portrait');
  });

  it('defaults generating without activity to sheet', () => {
    expect(activityFromProgress({ status: 'generating' })).toBe('sheet');
  });

  it('treats sheet_ready as portrait', () => {
    expect(activityFromProgress({ status: 'sheet_ready' })).toBe('portrait');
  });
});

describe('parseSheetProgressActivity', () => {
  it('accepts sheet and portrait only', () => {
    expect(parseSheetProgressActivity('portrait')).toBe('portrait');
    expect(parseSheetProgressActivity('sheet')).toBe('sheet');
    expect(parseSheetProgressActivity(true)).toBeUndefined();
    expect(parseSheetProgressActivity('generating')).toBeUndefined();
  });
});

describe('isSheetProgressStale', () => {
  it('keeps a fresh generating event', () => {
    expect(isSheetProgressStale(1_000, 1_000 + 60_000)).toBe(false);
  });

  it('expires an event older than the stale window', () => {
    expect(
      isSheetProgressStale(1_000, 1_000 + SHEET_PROGRESS_STALE_MS + 1)
    ).toBe(true);
  });
});
