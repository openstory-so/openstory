// @ts-nocheck — test sentinels are intentionally partial objects
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { NewLocationSheet } from '@/lib/db/schema';

// ============================================================================
// Sub-module mocks — we test that scoped.ts composes them correctly
// ============================================================================

const mockSequencesList = vi.fn();
const mockSequencesCreate = vi.fn();
const mockSequencesGetById = vi.fn();
const mockSequencesUpdate = vi.fn();
const mockSequencesDelete = vi.fn();
const mockSequencesGetForUser = vi.fn();
const mockSequencesUpdateTitle = vi.fn();
const mockSequencesUpdateAnalysisDurationMs = vi.fn();
const mockSequencesUpdateMusicPrompt = vi.fn();
const mockSequencesUpdateWorkflow = vi.fn();
const mockUpdateStatus = vi.fn();
const mockUpdateMusicFields = vi.fn();
const mockGetMusicStatus = vi.fn();

vi.doMock('@/lib/db/scoped/sequences', () => ({
  createSequencesReadMethods: vi.fn(() => ({
    list: mockSequencesList,
    getById: mockSequencesGetById,
    getForUser: mockSequencesGetForUser,
  })),
  createSequencesMethods: vi.fn(() => ({
    list: mockSequencesList,
    create: mockSequencesCreate,
    getById: mockSequencesGetById,
    update: mockSequencesUpdate,
    delete: mockSequencesDelete,
    getForUser: mockSequencesGetForUser,
    updateTitle: mockSequencesUpdateTitle,
    updateAnalysisDurationMs: mockSequencesUpdateAnalysisDurationMs,
    updateMusicPrompt: mockSequencesUpdateMusicPrompt,
    updateWorkflow: mockSequencesUpdateWorkflow,
  })),
  createSequenceReadMethods: vi.fn((_db: unknown, sequenceId: string) => ({
    sequenceId,
    getMusicStatus: mockGetMusicStatus,
  })),
  createSequenceMethods: vi.fn((_db: unknown, sequenceId: string) => ({
    sequenceId,
    updateStatus: mockUpdateStatus,
    updateMusicFields: mockUpdateMusicFields,
    getMusicStatus: mockGetMusicStatus,
  })),
}));

const mockTalentList = vi.fn();
const mockTalentGetByIds = vi.fn();
const mockTalentCreate = vi.fn();
const mockTalentUpdate = vi.fn();
const mockTalentDelete = vi.fn();
const mockTalentToggleFavorite = vi.fn();
const mockTalentGetById = vi.fn();
const mockTalentGetWithRelations = vi.fn();
const mockTalentSheetsGetById = vi.fn();
const mockTalentSheetsCreate = vi.fn();
const mockTalentSheetsUpdate = vi.fn();
const mockTalentSheetsDelete = vi.fn();
const mockTalentMediaGetById = vi.fn();
const mockTalentMediaCreate = vi.fn();
const mockTalentMediaDelete = vi.fn();

vi.doMock('@/lib/db/scoped/talent', () => ({
  createTalentReadMethods: vi.fn(() => ({
    list: mockTalentList,
    getByIds: mockTalentGetByIds,
    getById: mockTalentGetById,
    getWithRelations: mockTalentGetWithRelations,
    sheets: { getById: mockTalentSheetsGetById },
    media: { getById: mockTalentMediaGetById },
  })),
  createPublicTalentReadMethods: vi.fn(() => ({
    list: mockTalentList,
    getWithRelations: mockTalentGetWithRelations,
  })),
  createTalentMethods: vi.fn(() => ({
    list: mockTalentList,
    getByIds: mockTalentGetByIds,
    create: mockTalentCreate,
    update: mockTalentUpdate,
    delete: mockTalentDelete,
    toggleFavorite: mockTalentToggleFavorite,
    getById: mockTalentGetById,
    getWithRelations: mockTalentGetWithRelations,
    sheets: {
      getById: mockTalentSheetsGetById,
      create: mockTalentSheetsCreate,
      update: mockTalentSheetsUpdate,
      delete: mockTalentSheetsDelete,
    },
    media: {
      getById: mockTalentMediaGetById,
      create: mockTalentMediaCreate,
      delete: mockTalentMediaDelete,
    },
  })),
}));

const mockStylesList = vi.fn();
const mockStylesCreate = vi.fn();
const mockStylesUpdate = vi.fn();
const mockStylesDelete = vi.fn();
const mockStylesGetById = vi.fn();
const mockStylesPublicList = vi.fn();
const mockStylesIncrementUsage = vi.fn();

vi.doMock('@/lib/db/scoped/styles', () => ({
  createStylesReadMethods: vi.fn(() => ({
    list: mockStylesList,
    getById: mockStylesGetById,
  })),
  createPublicStylesReadMethods: vi.fn(() => ({
    list: mockStylesPublicList,
  })),
  createStylesMethods: vi.fn(() => ({
    list: mockStylesList,
    create: mockStylesCreate,
    update: mockStylesUpdate,
    delete: mockStylesDelete,
    getById: mockStylesGetById,
    incrementUsage: mockStylesIncrementUsage,
  })),
}));

const mockLocationsList = vi.fn();
const mockLocationsSearch = vi.fn();
const mockLocationsCreate = vi.fn();
const mockLocationsWithReferences = vi.fn();
const mockLocationsGetById = vi.fn();
const mockLocationsGetByIds = vi.fn();
const mockLocationsCreateBulk = vi.fn();
const mockLocationsDelete = vi.fn();
const mockLocationsDeleteAll = vi.fn();
const mockLocationsUpdate = vi.fn();
const mockLocationsUpdateReference = vi.fn();
const mockLocationSheetsList = vi.fn();
const mockLocationSheetsInsert = vi.fn();
const mockLocationSheetsDelete = vi.fn();
const mockLocationSheetsGetWithLocation = vi.fn();
const mockLocationSheetsPromoteDefault = vi.fn();

vi.doMock('@/lib/db/scoped/location-library', () => ({
  createLocationsReadMethods: vi.fn(() => ({
    list: mockLocationsList,
    search: mockLocationsSearch,
    withReferences: mockLocationsWithReferences,
    getById: mockLocationsGetById,
    getByIds: mockLocationsGetByIds,
  })),
  createPublicLocationsReadMethods: vi.fn(() => ({
    list: mockLocationsList,
    getById: mockLocationsGetById,
  })),
  createLocationsMethods: vi.fn(() => ({
    list: mockLocationsList,
    search: mockLocationsSearch,
    create: mockLocationsCreate,
    withReferences: mockLocationsWithReferences,
    getById: mockLocationsGetById,
    getByIds: mockLocationsGetByIds,
    createBulk: mockLocationsCreateBulk,
    delete: mockLocationsDelete,
    deleteAll: mockLocationsDeleteAll,
    update: mockLocationsUpdate,
    updateReference: mockLocationsUpdateReference,
  })),
  createLocationSheetsReadMethods: vi.fn(() => ({
    list: mockLocationSheetsList,
    getWithLocation: mockLocationSheetsGetWithLocation,
  })),
  createLocationSheetsMethods: vi.fn(() => ({
    list: mockLocationSheetsList,
    insert: mockLocationSheetsInsert,
    delete: mockLocationSheetsDelete,
    getWithLocation: mockLocationSheetsGetWithLocation,
    promoteDefault: mockLocationSheetsPromoteDefault,
  })),
}));

const mockLibraryGetAll = vi.fn();

vi.doMock('@/lib/db/scoped/library', () => ({
  createLibraryMethods: vi.fn(() => ({
    getAll: mockLibraryGetAll,
  })),
}));

const mockBillingGetBalance = vi.fn();
const mockBillingDeductCredits = vi.fn();

vi.doMock('@/lib/db/scoped/billing', () => ({
  createBillingReadMethods: vi.fn(() => ({
    getBalance: mockBillingGetBalance,
  })),
  createBillingMethods: vi.fn(() => ({
    getBalance: mockBillingGetBalance,
    deductCredits: mockBillingDeductCredits,
  })),
}));

const mockApiKeysResolveKey = vi.fn();
const mockApiKeysSaveKey = vi.fn();

vi.doMock('@/lib/db/scoped/api-keys', () => ({
  createApiKeysReadMethods: vi.fn(() => ({
    resolveKey: mockApiKeysResolveKey,
  })),
  createApiKeysMethods: vi.fn(() => ({
    resolveKey: mockApiKeysResolveKey,
    saveKey: mockApiKeysSaveKey,
  })),
}));

const mockTeamManagementGetMembers = vi.fn();
const mockTeamManagementCreateInvitation = vi.fn();

vi.doMock('@/lib/db/scoped/team-management', () => ({
  createTeamManagementReadMethods: vi.fn(() => ({
    getMembers: mockTeamManagementGetMembers,
    getMemberEmail: vi.fn(),
  })),
  createTeamManagementMethods: vi.fn(() => ({
    getMembers: mockTeamManagementGetMembers,
    getMemberEmail: vi.fn(),
    createInvitation: mockTeamManagementCreateInvitation,
  })),
}));

vi.doMock('@/lib/db/scoped/admin', () => ({
  createAdminMethods: vi.fn(() => ({})),
}));

const mockCharactersGetById = vi.fn();
const mockCharactersListWithTalent = vi.fn();
const mockCharactersListWithSheets = vi.fn();
const mockCharactersUpdateTalent = vi.fn();
const mockCharactersUpdateSheetStatus = vi.fn();
const mockCharactersGetShotIdsForCharacter = vi.fn();

vi.doMock('@/lib/db/scoped/characters', () => ({
  createCharactersMethods: vi.fn(() => ({
    getById: mockCharactersGetById,
    listWithTalent: mockCharactersListWithTalent,
    listWithSheets: mockCharactersListWithSheets,
    updateTalent: mockCharactersUpdateTalent,
    updateSheetStatus: mockCharactersUpdateSheetStatus,
    getShotIdsForCharacter: mockCharactersGetShotIdsForCharacter,
  })),
}));

const mockSeqLocationsGetById = vi.fn();
const mockSeqLocationsList = vi.fn();
const mockSeqLocationsListWithReferences = vi.fn();
const mockSeqLocationsUpdateReferenceStatus = vi.fn();
const mockSeqLocationsGetShotIdsForLocation = vi.fn();
const mockSeqLocationsGetTeamLibrary = vi.fn();

vi.doMock('@/lib/db/scoped/sequence-locations', () => ({
  createSequenceLocationsMethods: vi.fn(() => ({
    getById: mockSeqLocationsGetById,
    list: mockSeqLocationsList,
    listWithReferences: mockSeqLocationsListWithReferences,
    updateReferenceStatus: mockSeqLocationsUpdateReferenceStatus,
    getShotIdsForLocation: mockSeqLocationsGetShotIdsForLocation,
    getTeamLibrary: mockSeqLocationsGetTeamLibrary,
  })),
}));

// DB chain mock for inline operations (characters, shots)
const mockWhere = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();

function wireDbChain() {
  const chain = {
    select: mockSelect,
    from: mockFrom,
    where: mockWhere,
  };
  mockSelect.mockReturnValue(chain);
  mockFrom.mockReturnValue(chain);
  mockWhere.mockResolvedValue([]);
  return chain;
}

let dbChain: ReturnType<typeof wireDbChain>;
const mockGetDb = vi.fn(() => dbChain);

vi.doMock('#db-client', () => ({
  getDb: mockGetDb,
}));

const { createScopedDb } = await import('./scoped');

const TEAM_ID = 'team_01';
const USER_ID = 'user_01';

describe('createScopedDb', () => {
  beforeEach(() => {
    // Clear all mocks
    for (const m of [
      mockSequencesList,
      mockSequencesCreate,
      mockSequencesGetById,
      mockUpdateStatus,
      mockUpdateMusicFields,
      mockGetMusicStatus,
      mockSequencesUpdate,
      mockSequencesDelete,
      mockSequencesGetForUser,
      mockSequencesUpdateTitle,
      mockSequencesUpdateAnalysisDurationMs,
      mockSequencesUpdateMusicPrompt,
      mockSequencesUpdateWorkflow,
      mockTalentList,
      mockTalentGetByIds,
      mockTalentCreate,
      mockTalentUpdate,
      mockTalentDelete,
      mockTalentToggleFavorite,
      mockTalentGetById,
      mockTalentGetWithRelations,
      mockTalentSheetsGetById,
      mockTalentSheetsCreate,
      mockTalentSheetsUpdate,
      mockTalentSheetsDelete,
      mockTalentMediaGetById,
      mockTalentMediaCreate,
      mockTalentMediaDelete,
      mockStylesList,
      mockStylesCreate,
      mockStylesUpdate,
      mockStylesDelete,
      mockStylesGetById,
      mockStylesPublicList,
      mockStylesIncrementUsage,
      mockLocationsList,
      mockLocationsSearch,
      mockLocationsCreate,
      mockLocationsWithReferences,
      mockLocationsGetById,
      mockLocationsGetByIds,
      mockLocationsCreateBulk,
      mockLocationsDelete,
      mockLocationsDeleteAll,
      mockLocationsUpdate,
      mockLocationsUpdateReference,
      mockLocationSheetsList,
      mockLocationSheetsInsert,
      mockLocationSheetsDelete,
      mockLocationSheetsGetWithLocation,
      mockLocationSheetsPromoteDefault,
      mockLibraryGetAll,
      mockCharactersGetById,
      mockCharactersListWithTalent,
      mockCharactersListWithSheets,
      mockCharactersUpdateTalent,
      mockCharactersUpdateSheetStatus,
      mockCharactersGetShotIdsForCharacter,
      mockSeqLocationsGetById,
      mockSeqLocationsList,
      mockSeqLocationsListWithReferences,
      mockSeqLocationsUpdateReferenceStatus,
      mockSeqLocationsGetShotIdsForLocation,
      mockSeqLocationsGetTeamLibrary,
      mockBillingGetBalance,
      mockBillingDeductCredits,
      mockApiKeysResolveKey,
      mockApiKeysSaveKey,
      mockTeamManagementGetMembers,
      mockTeamManagementCreateInvitation,
      mockGetDb,
      mockSelect,
      mockFrom,
      mockWhere,
    ]) {
      m.mockClear();
    }
    dbChain = wireDbChain();
  });

  it('exposes teamId and userId', () => {
    const db = createScopedDb(TEAM_ID, USER_ID);
    expect(db.teamId).toBe(TEAM_ID);
    expect(db.userId).toBe(USER_ID);
  });

  describe('sequences', () => {
    it('list() delegates to sub-module', async () => {
      const sentinel = [{ id: 'seq_1' }];
      mockSequencesList.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.sequences.list();

      expect(mockSequencesList).toHaveBeenCalled();
      expect(result).toEqual(sentinel);
    });

    it('create() delegates to sub-module', async () => {
      const sentinel = { id: 'seq_2' };
      mockSequencesCreate.mockResolvedValue(sentinel);

      const params = {
        userId: 'user_1',
        title: 'Test',
        styleId: 'style_1',
        analysisModel: 'model_1',
      };

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.sequences.create(params);

      expect(mockSequencesCreate).toHaveBeenCalledWith(params);
      expect(result).toEqual(sentinel);
    });

    it('getById() delegates to sub-module', async () => {
      const sentinel = { id: 'seq_1', teamId: TEAM_ID };
      mockSequencesGetById.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.sequences.getById('seq_1');

      expect(mockSequencesGetById).toHaveBeenCalledWith('seq_1');
      expect(result).toEqual(sentinel);
    });
  });

  describe('sequence()', () => {
    it('updateStatus() delegates to sub-module', async () => {
      const db = createScopedDb(TEAM_ID, USER_ID);
      await db.sequence('seq_01').updateStatus('processing');

      expect(mockUpdateStatus).toHaveBeenCalledWith('processing');
    });

    it('updateStatus() passes error parameter', async () => {
      const db = createScopedDb(TEAM_ID, USER_ID);
      await db.sequence('seq_01').updateStatus('failed', 'Something broke');

      expect(mockUpdateStatus).toHaveBeenCalledWith(
        'failed',
        'Something broke'
      );
    });

    it('updateMusicFields() delegates to sub-module', async () => {
      const fields = { musicStatus: 'generating' as const, musicError: null };
      const db = createScopedDb(TEAM_ID, USER_ID);
      await db.sequence('seq_01').updateMusicFields(fields);

      expect(mockUpdateMusicFields).toHaveBeenCalledWith(fields);
    });

    it('getMusicStatus() delegates to sub-module', async () => {
      const sentinel = { musicStatus: 'completed', musicUrl: 'url' };
      mockGetMusicStatus.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.sequence('seq_01').getMusicStatus();

      expect(result).toEqual(sentinel);
    });
  });

  describe('talent', () => {
    it('list() delegates to sub-module', async () => {
      const sentinel = [{ id: 'talent_1' }];
      mockTalentList.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.talent.list();

      expect(mockTalentList).toHaveBeenCalled();
      expect(result).toEqual(sentinel);
    });

    it('list() forwards options', async () => {
      mockTalentList.mockResolvedValue([]);

      const db = createScopedDb(TEAM_ID, USER_ID);
      await db.talent.list({ favoritesOnly: true });

      expect(mockTalentList).toHaveBeenCalledWith({ favoritesOnly: true });
    });

    it('getByIds() delegates to sub-module', async () => {
      const sentinel = [{ id: 'talent_1' }];
      mockTalentGetByIds.mockResolvedValue(sentinel);

      const ids = ['talent_1', 'talent_2'];
      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.talent.getByIds(ids);

      expect(mockTalentGetByIds).toHaveBeenCalledWith(ids);
      expect(result).toEqual(sentinel);
    });

    it('create() delegates to sub-module', async () => {
      const sentinel = { id: 'talent_3' };
      mockTalentCreate.mockResolvedValue(sentinel);

      const data = { name: 'Actor' };
      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.talent.create(data);

      expect(mockTalentCreate).toHaveBeenCalledWith(data);
      expect(result).toEqual(sentinel);
    });

    it('update() delegates to sub-module', async () => {
      const sentinel = { id: 'talent_1' };
      mockTalentUpdate.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.talent.update('talent_1', { name: 'Updated' });

      expect(mockTalentUpdate).toHaveBeenCalledWith('talent_1', {
        name: 'Updated',
      });
      expect(result).toEqual(sentinel);
    });

    it('delete() delegates to sub-module', async () => {
      mockTalentDelete.mockResolvedValue(true);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.talent.delete('talent_1');

      expect(mockTalentDelete).toHaveBeenCalledWith('talent_1');
      expect(result).toBe(true);
    });

    it('toggleFavorite() delegates to sub-module', async () => {
      const sentinel = { isFavorite: true };
      mockTalentToggleFavorite.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.talent.toggleFavorite('talent_1');

      expect(mockTalentToggleFavorite).toHaveBeenCalledWith('talent_1');
      expect(result).toEqual(sentinel);
    });
  });

  describe('styles', () => {
    it('list() delegates to sub-module', async () => {
      const sentinel = [{ id: 'style_1' }];
      mockStylesList.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.styles.list();

      expect(mockStylesList).toHaveBeenCalled();
      expect(result).toEqual(sentinel);
    });

    it('create() delegates to sub-module', async () => {
      const sentinel = { id: 'style_2' };
      mockStylesCreate.mockResolvedValue(sentinel);

      const data = { name: 'Noir' };
      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.styles.create(data);

      expect(mockStylesCreate).toHaveBeenCalledWith(data);
      expect(result).toEqual(sentinel);
    });

    it('update() delegates to sub-module', async () => {
      const sentinel = { id: 'style_1' };
      mockStylesUpdate.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.styles.update('style_1', { name: 'Updated' });

      expect(mockStylesUpdate).toHaveBeenCalledWith('style_1', {
        name: 'Updated',
      });
      expect(result).toEqual(sentinel);
    });

    it('delete() delegates to sub-module', async () => {
      mockStylesDelete.mockResolvedValue(undefined);

      const db = createScopedDb(TEAM_ID, USER_ID);
      await db.styles.delete('style_1');

      expect(mockStylesDelete).toHaveBeenCalledWith('style_1');
    });
  });

  describe('locations', () => {
    it('list() delegates to sub-module', async () => {
      const sentinel = [{ id: 'loc_1' }];
      mockLocationsList.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locations.list();

      expect(mockLocationsList).toHaveBeenCalled();
      expect(result).toEqual(sentinel);
    });

    it('search() delegates to sub-module', async () => {
      const sentinel = [{ id: 'loc_1' }];
      mockLocationsSearch.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locations.search('park', 5);

      expect(mockLocationsSearch).toHaveBeenCalledWith('park', 5);
      expect(result).toEqual(sentinel);
    });

    it('create() delegates to sub-module', async () => {
      const sentinel = { id: 'loc_2' };
      mockLocationsCreate.mockResolvedValue(sentinel);

      const data = { name: 'Beach' };
      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locations.create(data);

      expect(mockLocationsCreate).toHaveBeenCalledWith(data);
      expect(result).toEqual(sentinel);
    });

    it('withReferences() delegates to sub-module', async () => {
      const sentinel = [{ id: 'loc_1', references: [] }];
      mockLocationsWithReferences.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locations.withReferences();

      expect(mockLocationsWithReferences).toHaveBeenCalled();
      expect(result).toEqual(sentinel);
    });
  });

  describe('locationSheets', () => {
    it('list() delegates to sub-module', async () => {
      const sentinel = [{ id: 'sheet_1' }];
      mockLocationSheetsList.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locationSheets.list('loc_01');

      expect(mockLocationSheetsList).toHaveBeenCalledWith('loc_01');
      expect(result).toEqual(sentinel);
    });

    it('insert() delegates to sub-module', async () => {
      const sentinel = [{ id: 'sheet_2' }];
      mockLocationSheetsInsert.mockResolvedValue(sentinel);

      const sheets: NewLocationSheet[] = [
        { locationId: 'loc_01', name: 'Night', source: 'manual_upload' },
      ];
      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locationSheets.insert(sheets);

      expect(mockLocationSheetsInsert).toHaveBeenCalledWith(sheets);
      expect(result).toEqual(sentinel);
    });

    it('delete() delegates to sub-module', async () => {
      const db = createScopedDb(TEAM_ID, USER_ID);
      await db.locationSheets.delete('sheet_01');

      expect(mockLocationSheetsDelete).toHaveBeenCalledWith('sheet_01');
    });

    it('getWithLocation() delegates to sub-module', async () => {
      const sentinel = {
        sheet: { id: 'sheet_01' },
        location: { id: 'loc_01' },
      };
      mockLocationSheetsGetWithLocation.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locationSheets.getWithLocation('sheet_01');

      expect(result).toEqual(sentinel);
    });

    it('promoteDefault() delegates to sub-module', async () => {
      const db = createScopedDb(TEAM_ID, USER_ID);
      await db.locationSheets.promoteDefault('loc_01');

      expect(mockLocationSheetsPromoteDefault).toHaveBeenCalledWith('loc_01');
    });
  });

  describe('characters', () => {
    it('getById() delegates to sub-module', async () => {
      const sentinel = { id: 'char_01', name: 'Hero' };
      mockCharactersGetById.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.characters.getById('char_01');

      expect(mockCharactersGetById).toHaveBeenCalledWith('char_01');
      expect(result).toEqual(sentinel);
    });

    it('listWithTalent() delegates to sub-module', async () => {
      const sentinel = [{ id: 'char_01', name: 'Hero', talent: null }];
      mockCharactersListWithTalent.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.characters.listWithTalent('seq_01');

      expect(mockCharactersListWithTalent).toHaveBeenCalledWith('seq_01');
      expect(result).toEqual(sentinel);
    });

    it('listWithSheets() delegates to sub-module', async () => {
      const sentinel = [{ id: 'char_01', sheetStatus: 'completed' }];
      mockCharactersListWithSheets.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.characters.listWithSheets('seq_01');

      expect(mockCharactersListWithSheets).toHaveBeenCalledWith('seq_01');
      expect(result).toEqual(sentinel);
    });

    it('updateTalent() delegates to sub-module', async () => {
      const sentinel = { id: 'char_01', talentId: 'talent_01' };
      mockCharactersUpdateTalent.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.characters.updateTalent('char_01', 'talent_01');

      expect(mockCharactersUpdateTalent).toHaveBeenCalledWith(
        'char_01',
        'talent_01'
      );
      expect(result).toEqual(sentinel);
    });

    it('updateSheetStatus() delegates to sub-module', async () => {
      const sentinel = { id: 'char_01', sheetStatus: 'generating' };
      mockCharactersUpdateSheetStatus.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.characters.updateSheetStatus(
        'char_01',
        'generating'
      );

      expect(mockCharactersUpdateSheetStatus).toHaveBeenCalledWith(
        'char_01',
        'generating'
      );
      expect(result).toEqual(sentinel);
    });

    it('getShotIdsForCharacter() delegates to sub-module', async () => {
      const sentinel = ['shot_01', 'shot_02'];
      mockCharactersGetShotIdsForCharacter.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.characters.getShotIdsForCharacter(
        'seq_01',
        'char_01'
      );

      expect(mockCharactersGetShotIdsForCharacter).toHaveBeenCalledWith(
        'seq_01',
        'char_01'
      );
      expect(result).toEqual(sentinel);
    });
  });

  describe('sequenceLocations', () => {
    it('getById() delegates to sub-module', async () => {
      const sentinel = { id: 'loc_01', name: 'Park' };
      mockSeqLocationsGetById.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.sequenceLocations.getById('loc_01');

      expect(mockSeqLocationsGetById).toHaveBeenCalledWith('loc_01');
      expect(result).toEqual(sentinel);
    });

    it('list() delegates to sub-module', async () => {
      const sentinel = [{ id: 'loc_01' }];
      mockSeqLocationsList.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.sequenceLocations.list('seq_01');

      expect(mockSeqLocationsList).toHaveBeenCalledWith('seq_01');
      expect(result).toEqual(sentinel);
    });

    it('listWithReferences() delegates to sub-module', async () => {
      const sentinel = [{ id: 'loc_01', referenceStatus: 'completed' }];
      mockSeqLocationsListWithReferences.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.sequenceLocations.listWithReferences('seq_01');

      expect(mockSeqLocationsListWithReferences).toHaveBeenCalledWith('seq_01');
      expect(result).toEqual(sentinel);
    });

    it('updateReferenceStatus() delegates to sub-module', async () => {
      const sentinel = { id: 'loc_01', referenceStatus: 'generating' };
      mockSeqLocationsUpdateReferenceStatus.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.sequenceLocations.updateReferenceStatus(
        'loc_01',
        'generating'
      );

      expect(mockSeqLocationsUpdateReferenceStatus).toHaveBeenCalledWith(
        'loc_01',
        'generating'
      );
      expect(result).toEqual(sentinel);
    });

    it('getShotIdsForLocation() delegates to sub-module', async () => {
      const sentinel = ['shot_01', 'shot_03'];
      mockSeqLocationsGetShotIdsForLocation.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.sequenceLocations.getShotIdsForLocation(
        'seq_01',
        'loc_01'
      );

      expect(mockSeqLocationsGetShotIdsForLocation).toHaveBeenCalledWith(
        'seq_01',
        'loc_01'
      );
      expect(result).toEqual(sentinel);
    });

    it('getTeamLibrary() delegates to sub-module', async () => {
      const sentinel = [{ id: 'loc_01', sequenceTitle: 'Test' }];
      mockSeqLocationsGetTeamLibrary.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.sequenceLocations.getTeamLibrary(TEAM_ID, {
        completedOnly: true,
      });

      expect(mockSeqLocationsGetTeamLibrary).toHaveBeenCalledWith(TEAM_ID, {
        completedOnly: true,
      });
      expect(result).toEqual(sentinel);
    });
  });

  describe('shots', () => {
    it('getById() queries db directly', async () => {
      const sentinel = { id: 'shot_01' };
      mockWhere.mockResolvedValue([sentinel]);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.shots.getById('shot_01');

      expect(result).toEqual(sentinel);
    });

    it('getById() returns null when not found', async () => {
      mockWhere.mockResolvedValue([]);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.shots.getById('shot_99');

      expect(result).toBeNull();
    });
  });

  describe('library', () => {
    it('getAll() delegates to sub-module', async () => {
      const sentinel = { styles: [], vfx: [], audio: [] };
      mockLibraryGetAll.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.library.getAll();

      expect(mockLibraryGetAll).toHaveBeenCalled();
      expect(result).toEqual(sentinel);
    });
  });
});
