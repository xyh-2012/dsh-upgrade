/**
 * npm registry access — figuring out which version is actually newer.
 *
 * This installation was pinned by an npm dist-tag that trails the real
 * newest build (`latest` pointed at the installed rc.1 while `next`
 * already published rc.3), so the plugin must look at the tag map AND at
 * the full version list, not just `dist-tags.latest`.
 *
 * @module dsh-upgrade/registry
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isNewer, sortVersions } from './version.js';

/** Package that carries the CLI + web app. */
export const PACKAGE_NAME = '@deepseek-ai/dsh';

/** Fallback when no registry can be discovered. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * Read the `registry=` line from an npmrc file, ignoring comments.
 * @param {string} path - absolute path to the npmrc.
 * @returns {string | undefined} the configured registry, if any.
 */
function readRegistryFromNpmrc(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === 'registry' && value.length > 0) return value.replace(/\/+$/u, '');
  }
  return undefined;
}

/**
 * Resolve the registry to query, in priority order: explicit override,
 * environment, project npmrc, user npmrc, npm default.
 * @param {string} [override] - registry from plugin config or tool arguments.
 * @param {string} [cwd] - project directory whose `.npmrc` should be consulted.
 * @returns {string} a registry base URL without a trailing slash.
 */
export function resolveRegistry(override, cwd) {
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim().replace(/\/+$/u, '');
  }
  const fromEnv = process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv.trim().replace(/\/+$/u, '');
  }
  const candidates = [];
  if (typeof cwd === 'string' && cwd.length > 0) candidates.push(join(cwd, '.npmrc'));
  candidates.push(join(homedir(), '.npmrc'));
  for (const candidate of candidates) {
    const found = readRegistryFromNpmrc(candidate);
    if (found !== undefined) return found;
  }
  return DEFAULT_REGISTRY;
}

/**
 * Turn a package name into its packument URL. Scoped names need the `/`
 * between scope and package encoded as `%2f` for some registries.
 * @param {string} registry - registry base URL.
 * @param {string} name - package name such as `@deepseek-ai/dsh`.
 * @returns {string} absolute URL.
 */
export function packumentUrl(registry, name) {
  return `${registry}/${name.replace('/', '%2f')}`;
}

/**
 * Fetch a packument (the full version document) for a package.
 * @param {string} name - package name.
 * @param {object} [options] - `{ registry, signal, timeoutMs }`.
 * @returns {Promise<object>} the parsed packument.
 */
export async function fetchPackument(name, options = {}) {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(packumentUrl(registry, name), {
      headers: {
        accept: 'application/json',
        // Registries serve the abbreviated document only when it is asked for;
        // the full one is what carries every `dist` block.
        'user-agent': 'dsh-upgrade (+https://github.com/xyh-2012/dsh-upgrade)',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`registry responded ${response.status} ${response.statusText} for ${name}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Candidate versions published for a package, oldest first.
 * @param {object} packument - parsed packument.
 * @returns {string[]} version strings.
 */
export function publishedVersions(packument) {
  const versions = Object.keys(packument?.versions ?? {});
  return sortVersions(versions);
}

/**
 * The dist-tags map with non-string entries dropped.
 * @param {object} packument - parsed packument.
 * @returns {Record<string, string>} tag name to version.
 */
export function distTags(packument) {
  const tags = packument?.['dist-tags'] ?? {};
  const result = {};
  for (const [tag, version] of Object.entries(tags)) {
    if (typeof version === 'string' && version.length > 0) result[tag] = version;
  }
  return result;
}

/**
 * Pick the version an upgrade should target.
 *
 * `latest` may resolve to something older than the newest published build
 * (the exact trap this plugin exists to work around), so `newest` — the
 * maximum of every published version — is the default.
 *
 * @param {object} packument - parsed packument.
 * @param {string} [channel] - `newest`, `latest`, `next`, `alpha` or a literal
 *   version string.
 * @returns {string} the target version.
 */
export function pickTargetVersion(packument, channel = 'newest') {
  const tags = distTags(packument);
  const versions = publishedVersions(packument);
  if (versions.length === 0) throw new Error('this package has no published versions');
  if (channel === 'newest' || channel === undefined || channel === '') {
    return versions[versions.length - 1];
  }
  if (channel === 'latest') return tags.latest ?? versions[versions.length - 1];
  if (Object.hasOwn(tags, channel)) return tags[channel];
  if (versions.includes(channel)) return channel;
  throw new Error(
    `unknown channel "${channel}" (dist-tags: ${Object.keys(tags).join(', ') || 'none'})`,
  );
}

/**
 * The `dist` block for one version, carrying the tarball URL and hashes.
 * @param {object} packument - parsed packument.
 * @param {string} version - exact version.
 * @returns {{tarball: string, integrity?: string, shasum?: string}} dist info.
 */
export function distFor(packument, version) {
  const entry = packument?.versions?.[version];
  if (entry === undefined) throw new Error(`version ${version} is not published`);
  const dist = entry.dist ?? {};
  if (typeof dist.tarball !== 'string' || dist.tarball.length === 0) {
    throw new Error(`version ${version} has no tarball URL`);
  }
  return { tarball: dist.tarball, integrity: dist.integrity, shasum: dist.shasum };
}

/**
 * A compact, model-friendly summary of what the registry offers.
 * @param {object} packument - parsed packument.
 * @param {string} installedVersion - currently installed version.
 * @param {string} [channel] - requested channel.
 * @param {string} [registry] - registry that was queried.
 * @returns {object} summary for the status tool.
 */
export function summarize(packument, installedVersion, channel = 'newest', registry) {
  const tags = distTags(packument);
  const versions = publishedVersions(packument);
  const target = pickTargetVersion(packument, channel);
  return {
    registry,
    channel,
    installedVersion,
    distTags: tags,
    newestVersion: versions[versions.length - 1],
    publishedCount: versions.length,
    targetVersion: target,
    updateAvailable: installedVersion.length > 0 ? isNewer(target, installedVersion) : false,
  };
}
