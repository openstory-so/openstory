#!/usr/bin/env bun
/**
 * CLI script to trigger the analyze-script workflow
 *
 * Usage:
 *   bun scripts/analyze-script.ts --script <file> --style <file> [options]
 *
 * Required:
 *   --script <file>       Path to script file (.txt or .md)
 *   --style <file>        Path to style config JSON file
 *
 * Options:
 *   --aspect-ratio        16:9 | 9:16 | 1:1 (default: 16:9)
 *   --analysis-model      Analysis model ID (default: anthropic/claude-haiku-4.5)
 *   --image-model         Image model for thumbnails (e.g., flux_1_1_ultra)
 *   --video-model         Video model for motion (e.g., wan_i2v)
 *   --user-id             User ID for authenticated runs
 *   --team-id             Team ID for authenticated runs
 *   --sequence-id         Sequence ID to associate with
 *
 * Example:
 *   bun scripts/analyze-script.ts \
 *     --script examples/script.txt \
 *     --style examples/style.json \
 *     --analysis-model cerebras/llama-3.3-70b
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import {
  ANALYSIS_MODEL_IDS,
  DEFAULT_ANALYSIS_MODEL,
  isValidAnalysisModelId,
} from '../src/lib/ai/models.config';
import {
  aspectRatioSchema,
  type AspectRatio,
} from '../src/lib/constants/aspect-ratios';
import { z } from 'zod';
import {
  parseStyleConfig,
  type StyleConfig,
} from '../src/lib/style/style-config';
import { triggerWorkflow } from '../src/lib/workflow/client';

function printUsage() {
  console.log(`
Usage:
  bun scripts/analyze-script.ts --script <file> --style <file> [options]

Required:
  --script <file>       Path to script file (.txt or .md)
  --style <file>        Path to style config JSON file

Options:
  --aspect-ratio        16:9 | 9:16 | 1:1 (default: 16:9)
  --analysis-model      Analysis model ID (default: ${DEFAULT_ANALYSIS_MODEL})
  --image-model         Image model for thumbnails (e.g., flux_1_1_ultra)
  --video-model         Video model for motion (e.g., wan_i2v)
  --user-id             User ID for authenticated runs
  --team-id             Team ID for authenticated runs
  --sequence-id         Sequence ID to associate with

Available aspect ratios: 16:9, 9:16, 1:1

Available analysis models:
${ANALYSIS_MODEL_IDS.map((id) => `  - ${id}`).join('\n')}

Style config format (JSON):
{
  "mood": "Tense and foreboding",
  "artStyle": "Cinematic realism",
  "lighting": "Low-key dramatic lighting",
  "colorPalette": ["#1a1a2e", "#16213e"],
  "cameraWork": "Dynamic handheld",
  "referenceFilms": ["rain-slicked neon-noir cityscape cinematography"],
  "colorGrading": "Cool desaturated"
}
`);
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      script: { type: 'string' },
      style: { type: 'string' },
      'aspect-ratio': { type: 'string', default: '16:9' },
      'analysis-model': { type: 'string', default: DEFAULT_ANALYSIS_MODEL },
      'image-model': { type: 'string', default: DEFAULT_IMAGE_MODEL },
      'video-model': { type: 'string', default: DEFAULT_VIDEO_MODEL },
      'user-id': { type: 'string' },
      'team-id': { type: 'string' },
      'sequence-id': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  // Validate required arguments
  if (!values.script) {
    console.error('Error: --script is required');
    console.log('Run with --help for usage information');
    process.exit(1);
  }

  if (!values.style) {
    console.error('Error: --style is required');
    console.log('Run with --help for usage information');
    process.exit(1);
  }

  // Read script file
  let script: string;
  try {
    script = await readFile(values.script, 'utf-8');
  } catch {
    console.error(`Error: Could not read script file: ${values.script}`);
    process.exit(1);
  }

  if (script.length < 10) {
    console.error('Error: Script must be at least 10 characters');
    process.exit(1);
  }

  // Read and validate style config
  let styleConfig: unknown;
  try {
    const styleContent = await readFile(values.style, 'utf-8');
    styleConfig = JSON.parse(styleContent);
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`Error: Invalid JSON in style file: ${values.style}`);
    } else {
      console.error(`Error: Could not read style file: ${values.style}`);
    }
    process.exit(1);
  }

  // Accepts both the legacy flat (v1) and grouped (v2) shapes on disk.
  let parsedStyle: StyleConfig;
  try {
    parsedStyle = parseStyleConfig(styleConfig);
  } catch (error) {
    console.error('Error: Invalid style config');
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) {
        console.error(`  ${issue.path.join('.')}: ${issue.message}`);
      }
    } else {
      console.error(
        `  ${error instanceof Error ? error.message : String(error)}`
      );
    }
    process.exit(1);
  }

  // Validate aspect ratio
  const aspectRatioResult = aspectRatioSchema.safeParse(values['aspect-ratio']);
  if (!aspectRatioResult.success) {
    console.error(`Error: Invalid aspect ratio: ${values['aspect-ratio']}`);
    console.error('Valid options: 16:9, 9:16, 1:1');
    process.exit(1);
  }
  const aspectRatio: AspectRatio = aspectRatioResult.data;

  // Validate analysis model
  const analysisModel = values['analysis-model'];
  if (!isValidAnalysisModelId(analysisModel)) {
    console.error(`Error: Invalid analysis model: ${analysisModel}`);
    console.error('Run with --help to see available models');
    process.exit(1);
  }

  console.log('📝 Triggering analyze-script workflow…');
  console.log(`   Script: ${values.script} (${script.length} chars)`);
  console.log(`   Style: ${values.style}`);
  console.log(`   Aspect ratio: ${aspectRatio}`);
  console.log(`   Analysis model: ${analysisModel}`);
  if (values['image-model'])
    console.log(`   Image model: ${values['image-model']}`);
  if (values['video-model'])
    console.log(`   Video model: ${values['video-model']}`);
  console.log('');

  try {
    const workflowRunId = await triggerWorkflow(
      '/analyze-script',
      {
        script,
        styleConfig: parsedStyle,
        aspectRatio,
        analysisModelId: analysisModel,
        imageModel: values['image-model'],
        videoModel: values['video-model'],
        userId: values['user-id'] ?? 'cli-user',
        teamId: values['team-id'] ?? 'cli-team',
        sequenceId: values['sequence-id'],
      },
      { label: 'cli-analyze-script' }
    );

    console.log('✅ Workflow triggered successfully');
    console.log(`   Workflow Run ID: ${workflowRunId}`);
    console.log('');
    console.log('Check status at:');
    console.log(`   GET /api/workflows/status/${workflowRunId}`);
  } catch (error) {
    console.error(
      'Error triggering workflow:',
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}

void main();
