// @ts-nocheck — test sentinels are intentionally partial objects
import { describe, expect, it, beforeEach, vi } from 'vitest';

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
const mockSequencesUpdateWorkflow = vi.fn();
const mockUpdateStatus = vi.fn();

vi.doMock('@/sequences/server/db/sequences', () => ({
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
    updateWorkflow: mockSequencesUpdateWorkflow,
  })),
  createSequenceMethods: vi.fn((_db: unknown, sequenceId: string) => ({
    sequenceId,
    updateStatus: mockUpdateStatus,
  })),
}));

const mockStylesList = vi.fn();
const mockStylesCreate = vi.fn();
const mockStylesUpdate = vi.fn();
const mockStylesDelete = vi.fn();
const mockStylesGetById = vi.fn();
const mockStylesPublicList = vi.fn();
const mockStylesIncrementUsage = vi.fn();

vi.doMock('@/look/server/db/styles', () => ({
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

const mockLibraryGetAll = vi.fn();

vi.doMock('@/look/server/db/library', () => ({
  createLibraryMethods: vi.fn(() => ({
    getAll: mockLibraryGetAll,
  })),
}));

const mockBillingGetBalance = vi.fn();
const mockBillingDeductCredits = vi.fn();

vi.doMock('@/billing/server/db/billing', () => ({
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

vi.doMock('@/models/server/db/api-keys', () => ({
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

vi.doMock('@/platform/server/db/scoped/team-management', () => ({
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

vi.doMock('@/platform/server/db/scoped/admin', () => ({
  createAdminMethods: vi.fn(() => ({})),
}));

const mockCharactersGetById = vi.fn();
const mockCharactersList = vi.fn();
const mockCharactersListWithSheets = vi.fn();
const mockCharactersGetShotIdsForCharacter = vi.fn();

vi.doMock('@/cast/server/db/characters', () => ({
  createCharactersMethods: vi.fn(() => ({
    getById: mockCharactersGetById,
    list: mockCharactersList,
    listWithSheets: mockCharactersListWithSheets,
    getShotIdsForCharacter: mockCharactersGetShotIdsForCharacter,
  })),
}));

const mockLocationsGetById = vi.fn();
const mockLocationsList = vi.fn();
const mockLocationsListWithReferences = vi.fn();
const mockLocationsGetShotIdsForLocation = vi.fn();
const mockLocationsListTeam = vi.fn();
const mockLocationsAttach = vi.fn();
const mockCreateLocationsMethods = vi.fn(() => ({
  getById: mockLocationsGetById,
  list: mockLocationsList,
  listWithReferences: mockLocationsListWithReferences,
  getShotIdsForLocation: mockLocationsGetShotIdsForLocation,
  listTeam: mockLocationsListTeam,
  attach: mockLocationsAttach,
}));

vi.doMock('@/cast/server/db/locations', () => ({
  createLocationsMethods: mockCreateLocationsMethods,
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
      mockSequencesUpdate,
      mockSequencesDelete,
      mockSequencesGetForUser,
      mockSequencesUpdateTitle,
      mockSequencesUpdateAnalysisDurationMs,
      mockSequencesUpdateWorkflow,
      mockStylesList,
      mockStylesCreate,
      mockStylesUpdate,
      mockStylesDelete,
      mockStylesGetById,
      mockStylesPublicList,
      mockStylesIncrementUsage,
      mockLibraryGetAll,
      mockCharactersGetById,
      mockCharactersList,
      mockCharactersListWithSheets,
      mockCharactersGetShotIdsForCharacter,
      mockLocationsGetById,
      mockLocationsList,
      mockLocationsListWithReferences,
      mockLocationsGetShotIdsForLocation,
      mockLocationsListTeam,
      mockLocationsAttach,
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

  describe('characters', () => {
    it('getById() delegates to sub-module', async () => {
      const sentinel = { id: 'char_01', name: 'Hero' };
      mockCharactersGetById.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.characters.getById('char_01');

      expect(mockCharactersGetById).toHaveBeenCalledWith('char_01');
      expect(result).toEqual(sentinel);
    });

    it('list() delegates to sub-module', async () => {
      const sentinel = [{ id: 'char_01', name: 'Hero' }];
      mockCharactersList.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.characters.list('seq_01');

      expect(mockCharactersList).toHaveBeenCalledWith('seq_01');
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

  describe('locations', () => {
    it('is built for the team: every statement is team-scoped (#1695)', () => {
      createScopedDb(TEAM_ID, USER_ID);

      expect(mockCreateLocationsMethods).toHaveBeenCalledWith(
        expect.anything(),
        TEAM_ID
      );
    });

    it('getById() delegates to sub-module', async () => {
      const sentinel = { id: 'loc_01', name: 'Park' };
      mockLocationsGetById.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locations.getById('seq_01', 'loc_01');

      expect(mockLocationsGetById).toHaveBeenCalledWith('seq_01', 'loc_01');
      expect(result).toEqual(sentinel);
    });

    it('list() delegates to sub-module', async () => {
      const sentinel = [{ id: 'loc_01' }];
      mockLocationsList.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locations.list('seq_01');

      expect(mockLocationsList).toHaveBeenCalledWith('seq_01');
      expect(result).toEqual(sentinel);
    });

    it('listWithReferences() delegates to sub-module', async () => {
      const sentinel = [{ id: 'loc_01', referenceStatus: 'completed' }];
      mockLocationsListWithReferences.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locations.listWithReferences('seq_01');

      expect(mockLocationsListWithReferences).toHaveBeenCalledWith('seq_01');
      expect(result).toEqual(sentinel);
    });

    it('getShotIdsForLocation() delegates to sub-module', async () => {
      const sentinel = ['shot_01', 'shot_03'];
      mockLocationsGetShotIdsForLocation.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locations.getShotIdsForLocation(
        'seq_01',
        'loc_01'
      );

      expect(mockLocationsGetShotIdsForLocation).toHaveBeenCalledWith(
        'seq_01',
        'loc_01'
      );
      expect(result).toEqual(sentinel);
    });

    it('listTeam() delegates to sub-module, taking no team argument', async () => {
      const sentinel = [{ id: 'loc_01', usedAnywhere: false }];
      mockLocationsListTeam.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locations.listTeam();

      expect(mockLocationsListTeam).toHaveBeenCalledWith();
      expect(result).toEqual(sentinel);
    });

    it('attach() delegates to sub-module', async () => {
      const sentinel = { id: 'loc_01', attached: true };
      mockLocationsAttach.mockResolvedValue(sentinel);

      const db = createScopedDb(TEAM_ID, USER_ID);
      const result = await db.locations.attach('seq_01', 'loc_01', {
        actorId: USER_ID,
      });

      expect(mockLocationsAttach).toHaveBeenCalledWith('seq_01', 'loc_01', {
        actorId: USER_ID,
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
