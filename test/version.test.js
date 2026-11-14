import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, isNewer, isPrerelease, parseVersion, sortVersions } from '../lib/version.js';

test('parseVersion splits core and prerelease', () => {
  assert.deepEqual(parseVersion('0.2.2-rc.3'), { core: [0, 2, 2], pre: ['rc', '3'] });
  assert.deepEqual(parseVersion('1.2.3'), { core: [1, 2, 3], pre: [] });
  assert.deepEqual(parseVersion('2.0.0+build.9'), { core: [2, 0, 0], pre: [] });
  assert.deepEqual(parseVersion('1.2'), { core: [1, 2, 0], pre: [] });
});

test('compareVersions orders the core numerically', () => {
  assert.equal(compareVersions('0.2.2', '0.2.10'), -1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2.2', '0.2.2'), 0);
});

test('a release outranks its own prereleases', () => {
  assert.equal(compareVersions('0.2.2', '0.2.2-rc.3'), 1);
  assert.equal(compareVersions('0.2.2-rc.3', '0.2.2'), -1);
});

test('prerelease identifiers follow semver section 11', () => {
  assert.equal(compareVersions('0.2.2-alpha.3', '0.2.2-rc.1'), -1);
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.2'), -1);
  assert.equal(compareVersions('0.2.2-rc.2', '0.2.2-rc.10'), -1);
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.1.1'), -1);
  assert.equal(compareVersions('0.2.2-1', '0.2.2-rc'), -1);
});

test('isNewer only reports forward movement', () => {
  assert.equal(isNewer('0.2.2-rc.3', '0.2.2-rc.1'), true);
  assert.equal(isNewer('0.2.2-rc.1', '0.2.2-rc.3'), false);
  assert.equal(isNewer('0.2.2-rc.1', '0.2.2-rc.1'), false);
});

test('sortVersions is ascending and does not mutate its input', () => {
  const input = ['0.2.2-rc.3', '0.2.2-rc.1', '0.2.2', '0.2.2-alpha.3'];
  assert.deepEqual(sortVersions(input), ['0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.3', '0.2.2']);
  assert.deepEqual(input, ['0.2.2-rc.3', '0.2.2-rc.1', '0.2.2', '0.2.2-alpha.3']);
});

test('isPrerelease detects a prerelease tail', () => {
  assert.equal(isPrerelease('0.2.2-rc.3'), true);
  assert.equal(isPrerelease('0.2.2'), false);
});

test('parseVersion rejects an empty string', () => {
  assert.throws(() => parseVersion(''), /empty/u);
});
