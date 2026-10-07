#!/usr/bin/env node
// ali-kiro — CLI entry point.
// Thin dispatcher only: parse flags, then delegate to the pipeline / cli / demo
// modules. No install or catalog logic lives here.
import { createRequire } from 'node:module';
import { parseArgs, HELP, UsageError } from './src/cli/args.mjs';
import { listCatalog } from './src/cli/list.mjs';
import { runPipeline, EXIT, STEP_DESCRIPTIONS } from './src/install/pipeline.mjs';
import { runDemo } from './src/install/demo.mjs';

const require = createRequire(import.meta.url);
let version = process.env.ALI_KIRO_VERSION || '0.0.0-dev';
try {
  const pkg = JSON.parse(require('node:fs').readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  version = pkg.version;
} catch { /* compiled standalone binary: falls back to ALI_KIRO_VERSION */ }

async function main(argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    console.log(HELP);
    return EXIT.OK;
  }
  if (opts.version) {
    console.log(`ali-kiro ${version}`);
    return EXIT.OK;
  }
  if (opts.list) {
    await listCatalog(opts);
    return EXIT.OK;
  }
  if (opts.steps) {
    STEP_DESCRIPTIONS.forEach((desc, i) => console.log(`  ${i + 1}. ${desc}`));
    return EXIT.OK;
  }
  if (opts.demo) {
    await runDemo(opts);
    return EXIT.OK;
  }

  // Default: run the 7-step pipeline. It returns an EXIT code itself.
  return runPipeline(opts);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof UsageError) {
      // Message from parseArgs + a short hint; exit code 4 (usage error).
      console.error(err.message);
      console.error('Run "ali-kiro --help" for usage.');
      process.exit(EXIT.USAGE);
    }
    console.error(`ali-kiro: unexpected error: ${(err && err.message) || err}`);
    process.exit(EXIT.INSTALL);
  });