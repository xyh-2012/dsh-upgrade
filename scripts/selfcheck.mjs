#!/usr/bin/env node
/**
 * Standalone self-check: run the plugin's own logic without DSH.
 *
 * Useful in CI and when the Web UI is not up. Exits non-zero when the install
 * is not on the newest published version (use `--allow-outdated` to make that
 * a warning instead).
 *
 * Usage: node scripts/selfcheck.mjs [--root <dir>] [--channel <name>] [--apply] [--dry-run] [--allow-outdated]
 */
import process from 'node:process';
import { applyUpgrade, probe, verifyInstall } from '../lib/upgrade.js';

/**
 * Parse `--flag value` and `--flag` pairs.
 * @param {string[]} argv - arguments after the script name.
 * @returns {Record<string, string | boolean>} parsed options.
 */
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

/**
 * Print a labelled section.
 * @param {string} label - heading.
 * @param {string[]} lines - body lines.
 */
function section(label, lines) {
  console.log(`\n${label}`);
  for (const line of lines) console.log(`  ${line}`);
}

const options = parseArgs(process.argv.slice(2));
const root = typeof options.root === 'string' ? options.root : undefined;
const channel = typeof options.channel === 'string' ? options.channel : 'newest';

try {
  if (options.apply === true) {
    const outcome = await applyUpgrade({ root, channel, dryRun: options['dry-run'] === true });
    section('apply', outcome.steps.map((step) => `${step.stage}: ${step.status} — ${step.detail}`));
    console.log(`\napplied=${String(outcome.applied)} verified=${String(outcome.verified)} reason=${String(outcome.reason)}`);
    process.exitCode = outcome.applied === true || options['dry-run'] === true ? 0 : 1;
  } else {
    const probed = await probe({ root, channel });
    section('probe', [
      `root: ${probed.root}`,
      `registry: ${probed.registry}`,
      `installed: ${probed.installedVersion || '(unknown)'}`,
      `newest published: ${probed.newestVersion}`,
      `target (${probed.channel}): ${probed.targetVersion}`,
      `dist-tags: ${JSON.stringify(probed.distTags)}`,
      `update available: ${String(probed.updateAvailable)}`,
    ]);
    const verified = await verifyInstall({ root, channel });
    section('verify', [
      `manifest matches target: ${String(verified.manifestOk)}`,
      `cli reports target: ${String(verified.cliOk)} -> ${verified.cliReported || '(no output)'}`,
      `tarball hash: ${verified.tarballDetail}`,
      `verified: ${String(verified.verified)}`,
    ]);
    const outdated = verified.manifestOk === false;
    if (outdated && options['allow-outdated'] !== true) {
      console.log('\nRESULT: outdated — run with --apply to upgrade.');
      process.exitCode = 1;
    } else {
      console.log(outdated ? '\nRESULT: outdated (allowed).' : '\nRESULT: up to date.');
    }
  }
} catch (error) {
  console.error(`\nFAILED: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
}
