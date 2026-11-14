/**
 * The upgrade itself: probe, download, verify, install, confirm.
 *
 * Every step is separated so the read-only tools can reuse it and so a failed
 * run leaves a machine-readable record of how far it got.
 *
 * @module dsh-upgrade/upgrade
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLI_RELATIVE_PATH,
  MANIFEST_RELATIVE_PATH,
  cliDependencySpec,
  detectInstallRoot,
  installedVersion,
} from './install.js';
import {
  PACKAGE_NAME,
  distFor,
  fetchPackument,
  pickTargetVersion,
  resolveRegistry,
  summarize,
} from './registry.js';
import { downloadTarball, npmInstallTarball, pinDependency, runCommand, verifyTarball } from './npm.js';
import { isNewer } from './version.js';

/** Where upgrade bookkeeping lands, relative to the install root. */
const STATE_DIR = '.dsh-upgrade';

/**
 * Read the last upgrade record, if any.
 * @param {string} root - install root.
 * @returns {object | undefined} the record.
 */
export function readLastRun(root) {
  const path = join(root, STATE_DIR, 'last-run.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Persist an upgrade record so a later run (or a rollback) can see it.
 * @param {string} root - install root.
 * @param {object} record - what to write.
 * @returns {string} the record path.
 */
export function writeLastRun(root, record) {
  const directory = join(root, STATE_DIR);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'last-run.json');
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Back up the manifests an `npm install` is about to rewrite.
 * @param {string} root - install root.
 * @param {string} stamp - timestamp identifying this backup.
 * @returns {string[]} the files copied.
 */
export function backupManifests(root, stamp) {
  const directory = join(root, STATE_DIR, 'backups', stamp);
  mkdirSync(directory, { recursive: true });
  const copied = [];
  for (const name of ['package.json', 'package-lock.json']) {
    const source = join(root, name);
    if (!existsSync(source)) continue;
    copyFileSync(source, join(directory, name));
    copied.push(join(directory, name));
  }
  return copied;
}

/**
 * Ask the installed CLI what version it reports.
 *
 * The manifest can be rewritten while the running process keeps the old code
 * loaded, so the authoritative check is a fresh process reading the same
 * files. `--version` is cheap and does not start a server.
 *
 * @param {string} root - install root.
 * @param {object} [options] - `{ signal }`.
 * @returns {Promise<{reported: string, ok: boolean, detail: string}>} CLI answer.
 */
export async function cliReportedVersion(root, options = {}) {
  const bin = join(root, CLI_RELATIVE_PATH);
  try {
    const result = await runCommand(process.execPath, [bin, '--version'], {
      cwd: root,
      signal: options.signal,
      timeoutMs: 60_000,
    });
    const reported = result.stdout.trim().split(/\r?\n/u).pop() ?? '';
    if (result.code !== 0) {
      return {
        reported,
        ok: false,
        detail: `cli exited ${String(result.code)}: ${result.stderr.trim().slice(0, 400)}`,
      };
    }
    return { reported, ok: reported.length > 0, detail: 'cli answered --version' };
  } catch (error) {
    return { reported: '', ok: false, detail: String(error?.message ?? error) };
  }
}

/**
 * Resolve everything needed for an upgrade without touching the disk.
 * @param {object} [options] - `{ root, registry, channel, signal }`.
 * @returns {Promise<object>} the probe result.
 */
export async function probe(options = {}) {
  const root = detectInstallRoot({ explicit: options.root });
  const registry = resolveRegistry(options.registry, root);
  const channel = options.channel ?? 'newest';
  const installed = installedVersion(root);
  const packument = await fetchPackument(PACKAGE_NAME, { registry, signal: options.signal });
  const target = pickTargetVersion(packument, channel);
  const summary = summarize(packument, installed, channel, registry);
  const dist = distFor(packument, target);
  return {
    root,
    registry,
    channel,
    installedVersion: installed,
    pinnedSpec: cliDependencySpec(root),
    targetVersion: target,
    updateAvailable: installed.length > 0 ? isNewer(target, installed) : true,
    tarball: dist,
    tarballFileName: `deepseek-ai-dsh-${target}.tgz`,
    distTags: summary.distTags,
    newestVersion: summary.newestVersion,
    publishedCount: summary.publishedCount,
  };
}

/**
 * Perform the upgrade.
 *
 * @param {object} [options] - `{ root, registry, channel, dryRun, signal, onLine }`.
 * @returns {Promise<object>} a step-by-step result.
 */
export async function applyUpgrade(options = {}) {
  const steps = [];
  const record = (stage, status, detail) => {
    steps.push({ stage, status, detail });
  };
  const probed = await probe(options);
  const { root, targetVersion, installedVersion: before } = probed;
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  record('probe', 'ok', `installed ${before || '(unknown)'} -> target ${targetVersion} (${probed.channel})`);

  if (!probed.updateAvailable) {
    record('compare', 'skipped', `already at ${before}; nothing newer is published`);
    return { applied: false, reason: 'up-to-date', ...probed, steps, verified: true };
  }

  const target = join(root, probed.tarballFileName);
  let reused = false;
  if (existsSync(target)) {
    const existing = verifyTarball(target, probed.tarball);
    if (existing.ok) {
      reused = true;
      record('download', 'reused', `${probed.tarballFileName} already present and ${existing.detail}`);
    } else {
      record('download', 'stale', `existing tarball failed verification (${existing.detail}); re-downloading`);
    }
  }
  if (!reused) {
    await downloadTarball({
      url: probed.tarball.tarball,
      directory: root,
      fileName: probed.tarballFileName,
      signal: options.signal,
    });
    const verified = verifyTarball(target, probed.tarball);
    if (!verified.ok) {
      throw new Error(`downloaded tarball failed verification: ${verified.detail}`);
    }
    record('download', 'ok', `${probed.tarballFileName} ${verified.detail}`);
  }

  const backups = backupManifests(root, stamp);
  record('backup', backups.length > 0 ? 'ok' : 'empty', backups.map((p) => p.split(/[\\/]/u).pop()).join(', ') || 'no manifests to back up');

  const installResult = await npmInstallTarball({
    root,
    tarball: target,
    dryRun: options.dryRun === true,
    signal: options.signal,
    onLine: options.onLine,
  });
  const tail = installResult.stderr.trim().split(/\r?\n/u).filter((line) => line.length > 0).slice(-8);
  if (installResult.code !== 0) {
    record('install', 'failed', `npm exited ${String(installResult.code)}: ${tail.join(' | ').slice(0, 800)}`);
    writeLastRun(root, {
      at: new Date().toISOString(),
      root,
      before,
      target: targetVersion,
      applied: false,
      steps,
      backupStamp: stamp,
    });
    throw new Error(`npm install failed (exit ${String(installResult.code)}): ${tail.join(' | ')}`);
  }
  record(
    'install',
    options.dryRun === true ? 'dry-run' : 'ok',
    `${(installResult.stdout.match(/(added|changed|removed|up to date)[^\r\n]*/gu) ?? []).slice(-3).join(' | ') || 'npm completed'}`,
  );

  if (options.dryRun === true) {
    record('pin', 'planned', `would repin ${probed.tarballFileName} (not written during a dry run)`);
    return { applied: false, reason: 'dry-run', ...probed, steps, backupStamp: stamp };
  }

  const pinned = pinDependency(root, probed.tarballFileName);
  record(
    'pin',
    pinned.changed ? 'ok' : 'unchanged',
    pinned.changed ? `${pinned.previous || '(none)'} -> ${pinned.next}` : `already ${pinned.next}`,
  );

  const after = installedVersion(root);
  const cli = await cliReportedVersion(root, { signal: options.signal });
  const versionOk = after === targetVersion;
  const cliOk = cli.ok && cli.reported === targetVersion;
  record('verify-manifest', versionOk ? 'ok' : 'failed', `${MANIFEST_RELATIVE_PATH} says ${after || '(unreadable)'}`);
  record('verify-cli', cliOk ? 'ok' : 'failed', `\`dsh --version\` -> ${cli.reported || '(no output)'} (${cli.detail})`);

  writeLastRun(root, {
    at: new Date().toISOString(),
    root,
    before,
    target: targetVersion,
    applied: versionOk,
    verified: versionOk && cliOk,
    cliReported: cli.reported,
    steps,
    backupStamp: stamp,
  });

  return {
    applied: versionOk,
    reason: versionOk ? 'upgraded' : 'version-mismatch',
    ...probed,
    installedAfter: after,
    cliReported: cli.reported,
    verified: versionOk && cliOk,
    steps,
    backupStamp: stamp,
  };
}

/**
 * Verify the on-disk install against the newest published version.
 * @param {object} [options] - `{ root, registry, channel, signal }`.
 * @returns {Promise<object>} verification result.
 */
export async function verifyInstall(options = {}) {
  const probed = await probe(options);
  const cli = await cliReportedVersion(probed.root, { signal: options.signal });
  const manifestOk = probed.installedVersion === probed.targetVersion;
  const cliOk = cli.ok && cli.reported === probed.targetVersion;
  const tarball = join(probed.root, probed.tarballFileName);
  const digest = existsSync(tarball) ? verifyTarball(tarball, probed.tarball) : { ok: false, detail: 'tarball not present' };
  return {
    ...probed,
    manifestOk,
    cliOk,
    tarballOk: digest.ok,
    cliReported: cli.reported,
    cliDetail: cli.detail,
    tarballDetail: digest.detail,
    verified: manifestOk && cliOk,
    hash: createHash('sha1').update(`${probed.installedVersion}|${probed.targetVersion}`).digest('hex').slice(0, 12),
  };
}
