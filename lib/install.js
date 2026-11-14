/**
 * Locating the DSH installation this plugin is running inside.
 *
 * The desktop shell launches `node <root>\node_modules\@deepseek-ai\dsh\lib\bin.js
 * web`, so `process.argv[1]` names the very install that must be upgraded.
 * The root is never guessed from the working directory: a different
 * checkout may sit beside it.
 *
 * @module dsh-upgrade/install
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

/** Relative path from an install root to the CLI entry point. */
export const CLI_RELATIVE_PATH = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

/** Relative path from an install root to the CLI manifest. */
export const MANIFEST_RELATIVE_PATH = join('node_modules', '@deepseek-ai', 'dsh', 'package.json');

/**
 * Does this directory look like a DSH install root?
 * @param {string} candidate - absolute directory path.
 * @returns {boolean} true when the CLI entry and manifest are both present.
 */
export function isInstallRoot(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  return existsSync(join(candidate, CLI_RELATIVE_PATH))
    && existsSync(join(candidate, MANIFEST_RELATIVE_PATH));
}

/**
 * Walk upwards from a starting path looking for an install root.
 * @param {string} start - file or directory to start from.
 * @param {number} [maxLevels] - how many parent hops to try.
 * @returns {string | undefined} the install root, when found.
 */
export function findRootUpwards(start, maxLevels = 8) {
  let current = resolve(start);
  try {
    if (statSync(current).isFile()) current = dirname(current);
  } catch {
    // A non-existent path still has a usable parent chain.
  }
  const { root } = parse(current);
  for (let level = 0; level <= maxLevels; level += 1) {
    if (isInstallRoot(current)) return current;
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * Resolve the install root of the running DSH process.
 *
 * Candidates are tried in order: an explicit path, the CLI entry the process
 * was started from, this plugin's own file location, then `C:\dsh` as the
 * conventional Windows location.
 *
 * @param {object} [options] - `{ explicit }`.
 * @returns {string} absolute install root.
 */
export function detectInstallRoot(options = {}) {
  const { explicit } = options;
  if (typeof explicit === 'string' && explicit.length > 0) {
    const resolved = resolve(explicit);
    if (!isInstallRoot(resolved)) {
      throw new Error(
        `${resolved} is not a DSH install root (missing ${MANIFEST_RELATIVE_PATH})`,
      );
    }
    return resolved;
  }
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry.length > 0) {
    const found = findRootUpwards(entry);
    if (found !== undefined) return found;
  }
  const selfFound = findRootUpwards(new URL(import.meta.url).pathname.replace(/^\//u, ''));
  if (selfFound !== undefined) return selfFound;
  if (isInstallRoot('C:\\dsh')) return 'C:\\dsh';
  throw new Error('could not locate the DSH install root; pass `root` explicitly');
}

/**
 * Read and parse a JSON file.
 * @param {string} path - absolute path.
 * @returns {any} parsed value.
 */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The version of the DSH CLI installed under a root.
 * @param {string} root - install root.
 * @returns {string} the `version` field, or an empty string when unreadable.
 */
export function installedVersion(root) {
  try {
    const manifest = readJson(join(root, MANIFEST_RELATIVE_PATH));
    return typeof manifest.version === 'string' ? manifest.version : '';
  } catch {
    return '';
  }
}

/**
 * The root `package.json` that pins the CLI dependency.
 * @param {string} root - install root.
 * @returns {object} parsed manifest (empty object when missing).
 */
export function rootManifest(root) {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return {};
  try {
    return readJson(path);
  } catch {
    return {};
  }
}

/**
 * The dependency spec recorded for the CLI in the root manifest.
 * @param {string} root - install root.
 * @returns {string} e.g. `file:deepseek-ai-dsh-0.2.2-rc.1.tgz`.
 */
export function cliDependencySpec(root) {
  const manifest = rootManifest(root);
  const dependencies = manifest.dependencies ?? {};
  const spec = dependencies['@deepseek-ai/dsh'];
  return typeof spec === 'string' ? spec : '';
}

/**
 * Is a `.tgz` already sitting in the root for this version?
 * @param {string} root - install root.
 * @param {string} version - version to look for.
 * @returns {string | undefined} the absolute tarball path.
 */
export function existingTarball(root, version) {
  const path = join(root, `deepseek-ai-dsh-${version}.tgz`);
  return existsSync(path) ? path : undefined;
}
