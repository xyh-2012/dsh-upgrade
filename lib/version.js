/**
 * Minimal semver comparator — no dependency on the `semver` package, which a
 * profile install may not have (and must not pull in).
 *
 * Only the subset npm actually publishes here matters: `MAJOR.MINOR.PATCH`
 * with an optional `-prerelease` tail (`0.2.2-rc.3`, `0.2.2-alpha.3`).
 *
 * @module dsh-upgrade/version
 */

const IDENT = /^(0|[1-9]\d*)$/;

/**
 * Split a version into its numeric core and prerelease identifiers.
 * @param {string} version - e.g. `0.2.2-rc.3`.
 * @returns {{core: number[], pre: string[]}} parsed parts.
 */
export function parseVersion(version) {
  const text = String(version ?? '').trim();
  if (text.length === 0) throw new Error('version is empty');
  const plus = text.indexOf('+');
  const withoutBuild = plus >= 0 ? text.slice(0, plus) : text;
  const dash = withoutBuild.indexOf('-');
  const coreText = dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild;
  const preText = dash >= 0 ? withoutBuild.slice(dash + 1) : '';
  const core = coreText.split('.').map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
  while (core.length < 3) core.push(0);
  const pre = preText.length > 0 ? preText.split('.') : [];
  return { core, pre };
}

/**
 * Compare two prerelease identifier lists per semver §11.
 * @returns {number} negative when `a` precedes `b`.
 */
function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  // A version without a prerelease tail outranks one that has it.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = IDENT.test(left);
    const rightNumeric = IDENT.test(right);
    if (leftNumeric && rightNumeric) {
      const diff = Number.parseInt(left, 10) - Number.parseInt(right, 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two versions.
 * @param {string} a - left version.
 * @param {string} b - right version.
 * @returns {number} -1, 0 or 1.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = left.core[index] - right.core[index];
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return comparePre(left.pre, right.pre);
}

/**
 * Whether `candidate` is strictly newer than `current`.
 * @param {string} candidate - version to test.
 * @param {string} current - installed version.
 * @returns {boolean} true when an upgrade would move forward.
 */
export function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

/**
 * Sort versions ascending (stable copy).
 * @param {string[]} versions - version strings.
 * @returns {string[]} a new sorted array.
 */
export function sortVersions(versions) {
  return [...versions].sort(compareVersions);
}

/**
 * Whether a version carries a prerelease tail.
 * @param {string} version - version string.
 * @returns {boolean} true for `-rc.1`-style versions.
 */
export function isPrerelease(version) {
  return parseVersion(version).pre.length > 0;
}
