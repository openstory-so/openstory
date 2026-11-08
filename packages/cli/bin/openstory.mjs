#!/usr/bin/env node
import { main } from '../dist/cli.js';

await main(process.argv.slice(2));
