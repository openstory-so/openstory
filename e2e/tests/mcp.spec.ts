/**
 * MCP tools end to end (#2243): one agent session builds and edits a sequence
 * through `/mcp` with the signed-in session, then reads every view of it back.
 * Tools that start paid generation are left to the pipeline specs.
 */
import { z } from 'zod';
import { expect, test } from '../fixtures/auth.fixture';
import { createTestSequence } from '../fixtures/sequence.fixture';
import { call, fixture, refuse, rpc, upload } from '../fixtures/mcp';

test.describe('MCP tools', () => {
  test('lists its tools and says who is calling', async ({
    request,
    testUser,
  }) => {
    const { result } = await rpc(request, 'tools/list');
    const { tools } = z
      .object({ tools: z.array(z.object({ name: z.string() })) })
      .parse(result);
    expect(tools.length).toBeGreaterThan(100);
    expect(tools.map((t) => t.name)).toContain('openstory.create_scene');

    const { result: who } = await rpc(request, 'tools/call', {
      name: 'whoami',
      arguments: {},
    });
    expect(JSON.stringify(who)).toContain(testUser.organizationId);
  });

  test('refuses a caller with no session', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext({
      baseURL: 'http://localhost:3020',
      storageState: { cookies: [], origins: [] },
    });
    const res = await anonymous.post('/mcp', {
      headers: { accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.status()).toBe(401);
    await anonymous.dispose();
  });

  test('builds and edits a sequence through tools', async ({
    request,
    testUser,
  }) => {
    const sequence = await createTestSequence(
      testUser.organizationId,
      testUser.id,
      'MCP edited sequence'
    );
    const sequenceId = sequence.id;
    const s = { sequenceId };

    // Structure: two scenes, extra shots, reorder, delete + restore.
    const first = await call(
      request,
      'create_scene',
      s,
      z.object({
        sceneId: z.string(),
        shotId: z.string(),
        scriptVersionId: z.string(),
      })
    );
    const second = await call(
      request,
      'create_scene',
      s,
      z.object({
        sceneId: z.string(),
        shotId: z.string(),
        scriptVersionId: z.string(),
      })
    );
    await call(request, 'update_scene', {
      ...s,
      sceneId: first.sceneId,
      expectedScriptVersionId: first.scriptVersionId,
      title: 'The diner at closing',
      scriptExtract:
        'INT. DINER - NIGHT\nMAYA wipes the counter. JONAH walks in, soaked.',
      location: 'Diner',
      timeOfDay: 'night',
      storyBeat: 'Jonah comes back',
    });
    const extraShot = await call(
      request,
      'create_shot',
      {
        ...s,
        sceneId: first.sceneId,
      },
      z.object({ shotId: z.string() })
    );
    await call(request, 'reorder_shots', {
      ...s,
      sceneId: first.sceneId,
      shotIds: [extraShot.shotId, first.shotId],
    });
    await call(request, 'reorder_scenes', {
      ...s,
      sceneIds: [second.sceneId, first.sceneId],
    });
    await call(request, 'update_shot', {
      ...s,
      shotId: first.shotId,
      durationSeconds: 6,
    });
    await call(request, 'delete_shot', { ...s, shotId: extraShot.shotId });
    await call(request, 'restore_shot', { ...s, shotId: extraShot.shotId });
    await call(request, 'delete_scene', { ...s, sceneId: second.sceneId });
    await call(request, 'list_deleted', s);
    await call(request, 'restore_scene', { ...s, sceneId: second.sceneId });

    // Shot content: prompts, dialogue, spec, prompt history.
    await call(request, 'update_shot_prompt', {
      ...s,
      shotId: first.shotId,
      promptType: 'visual',
      text: 'Maya behind the counter, neon sign buzzing behind her.',
    });
    await call(request, 'update_shot_prompt', {
      ...s,
      shotId: first.shotId,
      promptType: 'motion',
      text: 'Slow push in on Maya as the door opens.',
    });
    await call(request, 'update_shot_spec', {
      ...s,
      shotId: first.shotId,
      spec: {
        action: 'Maya wipes the counter as the door opens',
        framing: {
          shotSize: 'medium close-up',
          angle: 'eye level',
          composition: 'Maya left of frame, door right',
          subjectStartState: 'Wiping the counter',
        },
        cameraMovement: { move: 'push in', pacing: 'slow' },
        direction: 'She does not look up',
        soundCue: 'Rain on the window',
      },
    });
    await call(request, 'get_shot_spec', { ...s, shotId: first.shotId });
    await call(request, 'rebuild_shot_prompts', {
      ...s,
      shotId: first.shotId,
    });
    const motionVersions = await call(
      request,
      'list_versions',
      { ...s, kind: 'motion_prompt', entityId: first.shotId },
      z.object({ versions: z.array(z.object({ id: z.string() })) })
    );
    const firstMotion = motionVersions.versions[0];
    expect(firstMotion).toBeDefined();
    await call(request, 'get_version', {
      ...s,
      kind: 'motion_prompt',
      entityId: first.shotId,
      versionId: firstMotion?.id,
    });
    await call(request, 'restore_shot_prompt_version', {
      ...s,
      shotId: first.shotId,
      promptType: 'motion',
      versionId: firstMotion?.id,
    });
    await call(request, 'apply_sequence_edits', {
      ...s,
      changes: [
        {
          tool: 'update_scene',
          arguments: {
            sceneId: second.sceneId,
            expectedScriptVersionId: second.scriptVersionId,
            title: 'Outside in the rain',
            scriptExtract: 'EXT. DINER - NIGHT\nJONAH stands under the awning.',
          },
        },
      ],
    });
    await call(request, 'list_shot_dialogue', { ...s, shotId: first.shotId });
    for (const [kind, entityId] of [
      ['motion_prompt', first.shotId],
      ['scene_script', first.sceneId],
    ] as const) {
      await call(request, 'list_versions', { ...s, kind, entityId });
    }

    // Cast: a character with a second look, a location, both edited.
    const character = await call(
      request,
      'create_character',
      {
        ...s,
        name: 'Maya',
        age: '30s',
        physicalDescription: 'Short dark hair, tired eyes',
        standardClothing: 'Diner apron over a grey t-shirt',
        personality: 'Dry, patient',
      },
      z.object({ characterId: z.string() })
    );
    const characterId = character.characterId;
    await call(request, 'update_character', {
      ...s,
      characterId,
      voiceOnly: false,
      personality: 'Dry, patient, quietly hopeful',
    });
    const look = await call(
      request,
      'create_character_look',
      {
        ...s,
        characterId,
        name: 'Off shift',
        clothing: 'Rain jacket, jeans',
        styling: null,
      },
      z.object({ lookId: z.string() })
    );
    await call(request, 'update_character_look', {
      ...s,
      characterId,
      lookId: look.lookId,
      clothing: 'Rain jacket, jeans, scarf',
    });
    await call(request, 'list_character_look_versions', {
      ...s,
      characterId,
      lookId: look.lookId,
    });
    await call(request, 'remove_character_look', {
      ...s,
      characterId,
      lookId: look.lookId,
    });
    await call(request, 'restore_character_look', {
      ...s,
      characterId,
      lookId: look.lookId,
    });
    await call(request, 'get_character', { ...s, characterId });
    await call(request, 'list_character_voices', { ...s, characterId });
    await call(request, 'update_shot_dialogue', {
      ...s,
      shotId: first.shotId,
      lines: [
        {
          character: 'Maya',
          line: 'We closed an hour ago.',
          tone: 'dry tired',
        },
      ],
    });

    const location = await call(
      request,
      'create_location',
      {
        ...s,
        name: 'Corner diner',
        type: 'interior',
        description: 'Chrome counter, red stools, rain on the window',
      },
      z.object({ locationId: z.string() })
    );
    await call(request, 'update_location', {
      ...s,
      locationId: location.locationId,
      ambiance: 'Fluorescent hum, quiet',
    });
    await call(request, 'get_location', {
      ...s,
      locationId: location.locationId,
    });
    await call(request, 'list_entity_usages', {
      ...s,
      kind: 'location',
      entityId: location.locationId,
    });
    await call(request, 'get_reference_staleness', {
      ...s,
      kind: 'character',
      entityId: characterId,
    });

    // Sequence settings, music prompt, archive round trip.
    await call(request, 'update_sequence', {
      ...s,
      title: 'MCP edited sequence (renamed)',
      targetDurationSeconds: 30,
      includeMusic: true,
    });
    await call(request, 'update_music_prompt', {
      ...s,
      prompt: 'Late-night lo-fi piano, rain ambience',
      tags: 'lofi, piano',
    });
    await call(request, 'get_sequence_music', s);
    await call(request, 'get_music_staleness', s);
    await call(request, 'archive_sequence', s);
    const archived = await call(request, 'list_archived_sequences');
    expect(JSON.stringify(archived)).toContain(sequenceId);
    await call(request, 'unarchive_sequence', s);

    // Every read view of the edited sequence.
    for (const [name, args] of [
      ['get_sequence', s],
      ['get_sequence_status', s],
      ['get_sequence_settings', s],
      ['get_sequence_script', s],
      ['get_sequence_contact_sheet', s],
      ['get_production_bible', s],
      ['list_scenes', s],
      ['get_scene', { ...s, sceneId: first.sceneId }],
      ['list_shots', s],
      ['get_shot', { ...s, shotId: first.shotId }],
      ['get_shot_frames', { ...s, shotId: first.shotId }],
      ['get_shot_audio', { ...s, shotId: first.shotId }],
      ['get_shot_staleness', { ...s, shotId: first.shotId }],
      ['get_shot_variant_grid', { ...s, shotId: first.shotId }],
      ['list_shot_staleness', s],
      [
        'list_shot_references',
        { ...s, shotId: first.shotId, kind: 'character' },
      ],
      ['list_shot_dialogue_claims', { ...s, shotId: first.shotId }],
      ['list_frames', { ...s, shotId: first.shotId }],
      ['list_characters', s],
      ['list_locations', s],
      ['list_elements', s],
      ['list_deleted_cast', s],
      ['list_render_segments', s],
      ['list_exports', s],
      ['get_export_status', s],
      ['list_sequence_assets', s],
      ['plan_generation', { ...s, mode: 'missing', stopAt: 'images' }],
      ['list_sequences', {}],
      ['list_styles', {}],
      ['list_models', {}],
      ['list_library_locations', {}],
      ['list_library_characters', {}],
      ['list_library_resources', { kind: 'audio' }],
      ['list_gallery_samples', {}],
      ['list_generated_assets', {}],
      ['list_studio_uploads', {}],
    ] as const) {
      await call(request, name, args);
    }

    const events = await call(
      request,
      'list_sequence_events',
      s,
      z.object({ events: z.array(z.object({ id: z.string() })) })
    );
    expect(events.events.length).toBeGreaterThan(0);
    await call(request, 'get_sequence_event', {
      ...s,
      eventId: events.events[0]?.id,
    });

    // Nothing is rendered yet, so there is nothing to export.
    expect(await refuse(request, 'plan_export', s)).toContain(
      'No scene videos'
    );

    const script = await call(request, 'get_sequence_script', s);
    expect(JSON.stringify(script)).toContain('JONAH walks in');

    // Removing cast from the sequence, then putting it back.
    await call(request, 'delete_character', { ...s, characterId });
    await call(request, 'restore_character', { ...s, characterId });
    await call(request, 'delete_location', {
      ...s,
      locationId: location.locationId,
    });
    await call(request, 'restore_location', {
      ...s,
      locationId: location.locationId,
    });
  });

  test('a style is created, edited and deleted', async ({ request }) => {
    const created = await call(
      request,
      'create_style',
      {
        name: 'MCP Noir',
        description: 'High contrast black and white',
        category: 'cinematic',
        tags: ['noir'],
        config: {
          version: 2,
          look: {
            mood: 'tense',
            artStyle: 'film noir',
            lighting: 'hard key light',
            colorPalette: ['black', 'white'],
            colorGrading: 'monochrome',
          },
          motion: { camera: 'low angles, slow dolly' },
        },
      },
      z.object({ id: z.string().optional(), styleId: z.string().optional() })
    );
    const styleId = created.styleId ?? created.id;
    expect(styleId).toBeTruthy();
    await call(request, 'get_style', { id: styleId });
    await call(request, 'update_style', {
      styleId,
      description: 'High contrast monochrome with deep shadows',
    });
    await call(request, 'delete_style', { styleId });
  });

  test('refuses edits it cannot apply', async ({ request, testUser }) => {
    const sequence = await createTestSequence(
      testUser.organizationId,
      testUser.id,
      'MCP refusals'
    );
    const s = { sequenceId: sequence.id };
    const scene = await call(
      request,
      'create_scene',
      s,
      z.object({ sceneId: z.string(), scriptVersionId: z.string() })
    );

    expect(
      await refuse(request, 'get_sequence', {
        sequenceId: '01NOTAREALSEQUENCE00000000',
      })
    ).toBeTruthy();
    expect(
      await refuse(request, 'get_shot', {
        ...s,
        shotId: '01NOTAREALSHOT000000000000',
      })
    ).toBeTruthy();
    // A stale script version is a conflict, not a silent overwrite.
    await call(request, 'update_scene', {
      ...s,
      sceneId: scene.sceneId,
      expectedScriptVersionId: scene.scriptVersionId,
      title: 'First edit',
    });
    expect(
      await refuse(request, 'update_scene', {
        ...s,
        sceneId: scene.sceneId,
        expectedScriptVersionId: scene.scriptVersionId,
        title: 'Second edit from a stale read',
      })
    ).toBeTruthy();
    expect(
      await refuse(request, 'reorder_scenes', { ...s, sceneIds: ['nope'] })
    ).toBeTruthy();
  });

  test('uploads become a shot still, a sheet and an element', async ({
    request,
    testUser,
  }) => {
    const sequence = await createTestSequence(
      testUser.organizationId,
      testUser.id,
      'MCP uploads'
    );
    const s = { sequenceId: sequence.id };
    const scene = await call(
      request,
      'create_scene',
      s,
      z.object({ sceneId: z.string(), shotId: z.string() })
    );

    // A real person needs the portrait-rights sign-off before it is stored.
    expect(
      await refuse(request, 'upload_media', {
        ...s,
        use: 'shot_image',
        data: fixture('test-image.jpg'),
        mimeType: 'image/jpeg',
        filename: 'test-image.jpg',
      })
    ).toContain('real person');
    const still = await upload(
      request,
      s.sequenceId,
      'shot_image',
      'test-image.jpg',
      'image/jpeg',
      true
    );
    const set = await call(
      request,
      'set_shot_image_from_upload',
      { ...s, shotId: scene.shotId, upload: still },
      z.object({ versionId: z.string() })
    );
    await call(request, 'select_shot_image_version', {
      ...s,
      shotId: scene.shotId,
      versionId: set.versionId,
    });

    const character = await call(
      request,
      'create_character',
      { ...s, name: 'Scarlett' },
      z.object({ characterId: z.string() })
    );
    const sheet = await upload(
      request,
      s.sequenceId,
      'character_sheet',
      'character-sheet.jpg',
      'image/jpeg',
      true
    );
    await call(request, 'set_character_sheet_from_upload', {
      ...s,
      characterId: character.characterId,
      upload: sheet,
    });

    const prop = await upload(
      request,
      s.sequenceId,
      'element',
      'broadcast-mic.jpg',
      'image/jpeg'
    );
    const element = await call(
      request,
      'add_element',
      { ...s, upload: prop, name: 'Broadcast mic' },
      z.object({ elementId: z.string(), token: z.string() })
    );
    const e = { ...s, elementId: element.elementId };
    await call(request, 'get_element', e);
    await call(request, 'set_element_description', {
      ...e,
      description: 'A silver broadcast microphone on a desk stand',
    });
    await call(request, 'rename_element_token', { ...e, token: 'onair_mic' });
    await call(request, 'delete_element', e);
    await call(request, 'restore_element', e);

    const images = await call(
      request,
      'list_versions',
      { ...s, kind: 'character_sheet', entityId: character.characterId },
      z.object({ versions: z.array(z.object({ id: z.string() })) })
    );
    expect(images.versions).toHaveLength(1);
  });
});
