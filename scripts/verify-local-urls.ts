#!/usr/bin/env bun
/**
 * Local Database URL Verification Script
 *
 * Same as verify-production-urls.ts but connects to local Supabase instance
 *
 * Usage:
 *   bun scripts/verify-local-urls.ts
 */

import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';

// Get local Supabase credentials
const LOCAL_URL = 'http://127.0.0.1:54321';

// Local Supabase uses a well-known service role key for development
// This is the standard key used by all local Supabase instances
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// Verify local Supabase is running
try {
  execSync('bunx supabase status', { encoding: 'utf-8', stdio: 'pipe' });
} catch (error) {
  console.error('❌ Error: Local Supabase is not running');
  console.error('Start it with: bunx supabase start');
  process.exit(1);
}

const supabase = createClient(LOCAL_URL, SERVICE_ROLE_KEY);

type FrameRow = {
  id: string;
  thumbnail_url: string | null;
  thumbnail_path: string | null;
  video_url: string | null;
  video_path: string | null;
};

type StyleRow = {
  id: string;
  preview_url: string | null;
};

type CharacterRow = {
  id: string;
  lora_url: string | null;
  preview_url: string | null;
};

type VfxRow = {
  id: string;
  preview_url: string | null;
};

type AudioRow = {
  id: string;
  file_url: string | null;
};

type UserRow = {
  id: string;
  image: string | null;
};

type VerificationReport = {
  frames: {
    total: number;
    withVideoPath: number;
    withThumbnailPath: number;
    withVideoUrl: number;
    withThumbnailUrl: number;
    supabaseVideoUrls: number;
    supabaseThumbnailUrls: number;
    missingPaths: number;
  };
  styles: {
    total: number;
    withPreviewUrl: number;
    supabasePreviewUrls: number;
  };
  characters: {
    total: number;
    withLoraUrl: number;
    withPreviewUrl: number;
    supabaseLoraUrls: number;
    supabasePreviewUrls: number;
  };
  vfx: {
    total: number;
    withPreviewUrl: number;
    supabasePreviewUrls: number;
  };
  audio: {
    total: number;
    withFileUrl: number;
    supabaseFileUrls: number;
  };
  users: {
    total: number;
    withImage: number;
    supabaseImages: number;
  };
};

function isSupabaseUrl(url: string | null): boolean {
  if (!url) return false;
  return url.includes('supabase.co/storage');
}

async function verifyFrames() {
  console.log('\n📊 Analyzing frames table...');

  const { data: frames, error } = await supabase
    .from('frames')
    .select('id, thumbnail_url, thumbnail_path, video_url, video_path');

  if (error) {
    throw new Error(`Failed to fetch frames: ${error.message}`);
  }

  if (!frames) {
    throw new Error('No frames data returned');
  }

  const stats = {
    total: frames.length,
    withVideoPath: 0,
    withThumbnailPath: 0,
    withVideoUrl: 0,
    withThumbnailUrl: 0,
    supabaseVideoUrls: 0,
    supabaseThumbnailUrls: 0,
    missingPaths: 0,
  };

  for (const frame of frames as FrameRow[]) {
    if (frame.video_path) stats.withVideoPath++;
    if (frame.thumbnail_path) stats.withThumbnailPath++;
    if (frame.video_url) stats.withVideoUrl++;
    if (frame.thumbnail_url) stats.withThumbnailUrl++;
    if (isSupabaseUrl(frame.video_url)) stats.supabaseVideoUrls++;
    if (isSupabaseUrl(frame.thumbnail_url)) stats.supabaseThumbnailUrls++;

    // Missing paths but has URLs (needs migration)
    if (
      (frame.video_url && !frame.video_path) ||
      (frame.thumbnail_url && !frame.thumbnail_path)
    ) {
      stats.missingPaths++;
    }
  }

  console.log(`  Total frames: ${stats.total}`);
  console.log(
    `  With video_path: ${stats.withVideoPath} (${((stats.withVideoPath / stats.total) * 100).toFixed(1)}%)`
  );
  console.log(
    `  With thumbnail_path: ${stats.withThumbnailPath} (${((stats.withThumbnailPath / stats.total) * 100).toFixed(1)}%)`
  );
  console.log(`  Supabase video URLs: ${stats.supabaseVideoUrls}`);
  console.log(`  Supabase thumbnail URLs: ${stats.supabaseThumbnailUrls}`);
  console.log(`  Frames missing paths: ${stats.missingPaths} ⚠️`);

  return stats;
}

async function verifyStyles() {
  console.log('\n📊 Analyzing styles table...');

  const { data: styles, error } = await supabase
    .from('styles')
    .select('id, preview_url');

  if (error) {
    throw new Error(`Failed to fetch styles: ${error.message}`);
  }

  if (!styles) {
    throw new Error('No styles data returned');
  }

  const typedStyles = styles as StyleRow[];

  const stats = {
    total: typedStyles.length,
    withPreviewUrl: typedStyles.filter((s) => s.preview_url).length,
    supabasePreviewUrls: typedStyles.filter((s) => isSupabaseUrl(s.preview_url))
      .length,
  };

  console.log(`  Total styles: ${stats.total}`);
  console.log(`  With preview_url: ${stats.withPreviewUrl}`);
  console.log(`  Supabase preview URLs: ${stats.supabasePreviewUrls}`);

  return stats;
}

async function verifyCharacters() {
  console.log('\n📊 Analyzing characters table...');

  const { data: characters, error } = await supabase
    .from('characters')
    .select('id, lora_url, preview_url');

  if (error) {
    throw new Error(`Failed to fetch characters: ${error.message}`);
  }

  if (!characters) {
    throw new Error('No characters data returned');
  }

  const typedCharacters = characters as CharacterRow[];

  const stats = {
    total: typedCharacters.length,
    withLoraUrl: typedCharacters.filter((c) => c.lora_url).length,
    withPreviewUrl: typedCharacters.filter((c) => c.preview_url).length,
    supabaseLoraUrls: typedCharacters.filter((c) => isSupabaseUrl(c.lora_url))
      .length,
    supabasePreviewUrls: typedCharacters.filter((c) =>
      isSupabaseUrl(c.preview_url)
    ).length,
  };

  console.log(`  Total characters: ${stats.total}`);
  console.log(`  With lora_url: ${stats.withLoraUrl}`);
  console.log(`  With preview_url: ${stats.withPreviewUrl}`);
  console.log(`  Supabase lora URLs: ${stats.supabaseLoraUrls}`);
  console.log(`  Supabase preview URLs: ${stats.supabasePreviewUrls}`);

  return stats;
}

async function verifyVfx() {
  console.log('\n📊 Analyzing vfx table...');

  const { data: vfx, error } = await supabase
    .from('vfx')
    .select('id, preview_url');

  if (error) {
    throw new Error(`Failed to fetch vfx: ${error.message}`);
  }

  if (!vfx) {
    throw new Error('No vfx data returned');
  }

  const typedVfx = vfx as VfxRow[];

  const stats = {
    total: typedVfx.length,
    withPreviewUrl: typedVfx.filter((v) => v.preview_url).length,
    supabasePreviewUrls: typedVfx.filter((v) => isSupabaseUrl(v.preview_url))
      .length,
  };

  console.log(`  Total vfx: ${stats.total}`);
  console.log(`  With preview_url: ${stats.withPreviewUrl}`);
  console.log(`  Supabase preview URLs: ${stats.supabasePreviewUrls}`);

  return stats;
}

async function verifyAudio() {
  console.log('\n📊 Analyzing audio table...');

  const { data: audio, error } = await supabase
    .from('audio')
    .select('id, file_url');

  if (error) {
    throw new Error(`Failed to fetch audio: ${error.message}`);
  }

  if (!audio) {
    throw new Error('No audio data returned');
  }

  const typedAudio = audio as AudioRow[];

  const stats = {
    total: typedAudio.length,
    withFileUrl: typedAudio.filter((a) => a.file_url).length,
    supabaseFileUrls: typedAudio.filter((a) => isSupabaseUrl(a.file_url))
      .length,
  };

  console.log(`  Total audio: ${stats.total}`);
  console.log(`  With file_url: ${stats.withFileUrl}`);
  console.log(`  Supabase file URLs: ${stats.supabaseFileUrls}`);

  return stats;
}

async function verifyUsers() {
  console.log('\n📊 Analyzing user table...');

  const { data: users, error } = await supabase
    .from('user')
    .select('id, image');

  if (error) {
    throw new Error(`Failed to fetch users: ${error.message}`);
  }

  if (!users) {
    throw new Error('No users data returned');
  }

  const typedUsers = users as UserRow[];

  const stats = {
    total: typedUsers.length,
    withImage: typedUsers.filter((u) => u.image).length,
    supabaseImages: typedUsers.filter((u) => isSupabaseUrl(u.image)).length,
  };

  console.log(`  Total users: ${stats.total}`);
  console.log(`  With image: ${stats.withImage}`);
  console.log(`  Supabase images: ${stats.supabaseImages}`);

  return stats;
}

function printSummary(report: VerificationReport) {
  console.log('\n' + '='.repeat(60));
  console.log('📋 MIGRATION SUMMARY (LOCAL DATABASE)');
  console.log('='.repeat(60));

  const totalSupabaseUrls =
    report.frames.supabaseVideoUrls +
    report.frames.supabaseThumbnailUrls +
    report.styles.supabasePreviewUrls +
    report.characters.supabaseLoraUrls +
    report.characters.supabasePreviewUrls +
    report.vfx.supabasePreviewUrls +
    report.audio.supabaseFileUrls +
    report.users.supabaseImages;

  console.log(`\n🔍 Total Supabase URLs found: ${totalSupabaseUrls}`);
  console.log(`   - Frame videos: ${report.frames.supabaseVideoUrls}`);
  console.log(`   - Frame thumbnails: ${report.frames.supabaseThumbnailUrls}`);
  console.log(`   - Style previews: ${report.styles.supabasePreviewUrls}`);
  console.log(`   - Character LoRAs: ${report.characters.supabaseLoraUrls}`);
  console.log(
    `   - Character previews: ${report.characters.supabasePreviewUrls}`
  );
  console.log(`   - VFX previews: ${report.vfx.supabasePreviewUrls}`);
  console.log(`   - Audio files: ${report.audio.supabaseFileUrls}`);
  console.log(`   - User images: ${report.users.supabaseImages}`);

  console.log(
    `\n⚠️  Frames missing storage paths: ${report.frames.missingPaths}`
  );

  if (report.frames.missingPaths > 0) {
    console.log('\n⚡ NEXT STEP:');
    console.log('   Test the database URL update script on local database');
    console.log(
      '   Command: NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \\'
    );
    console.log(`            SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY} \\`);
    console.log('            bun scripts/update-database-urls.ts --dry-run');
  } else if (totalSupabaseUrls > 0) {
    console.log('\n✅ GOOD NEWS:');
    console.log('   All frames have storage paths populated!');
    console.log(
      '   Old Supabase URLs will be ignored - signed URLs regenerate from paths'
    );
    console.log('\n💡 OPTIONAL:');
    console.log('   You can test the cleanup script on local database');
    console.log(
      '   Command: NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \\'
    );
    console.log(`            SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY} \\`);
    console.log(
      '            bun scripts/update-database-urls.ts --cleanup --dry-run'
    );
  } else {
    console.log('\n✅ ALL CLEAR:');
    console.log('   No Supabase URLs found - migration already complete!');
  }

  console.log('\n' + '='.repeat(60));
}

async function main() {
  console.log('🔍 Local Database URL Verification Script');
  console.log('=========================================\n');
  console.log(`Local Supabase URL: ${LOCAL_URL}`);

  try {
    const report: VerificationReport = {
      frames: await verifyFrames(),
      styles: await verifyStyles(),
      characters: await verifyCharacters(),
      vfx: await verifyVfx(),
      audio: await verifyAudio(),
      users: await verifyUsers(),
    };

    printSummary(report);
  } catch (error) {
    console.error('\n❌ Verification failed:', error);
    console.error('\nMake sure local Supabase is running: bunx supabase start');
    process.exit(1);
  }
}

void main();
