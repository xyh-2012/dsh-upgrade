import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REGISTRY,
  distFor,
  distTags,
  packumentUrl,
  pickTargetVersion,
  publishedVersions,
  resolveRegistry,
  summarize,
} from '../lib/registry.js';

const PACKUMENT = {
  name: '@deepseek-ai/dsh',
  'dist-tags': { alpha: '0.2.2-alpha.3', latest: '0.2.2-rc.1', next: '0.2.2-rc.3' },
  versions: {
    '0.2.1-rc.5': { dist: { tarball: 'https://example.test/dsh-0.2.1-rc.5.tgz', shasum: 'aaa' } },
    '0.2.2-alpha.3': { dist: { tarball: 'https://example.test/dsh-0.2.2-alpha.3.tgz', shasum: 'bbb' } },
    '0.2.2-rc.1': { dist: { tarball: 'https://example.test/dsh-0.2.2-rc.1.tgz', shasum: 'ccc' } },
    '0.2.2-rc.2': { dist: { tarball: 'https://example.test/dsh-0.2.2-rc.2.tgz', shasum: 'ddd' } },
    '0.2.2-rc.3': {
      dist: {
        tarball: 'https://example.test/dsh-0.2.2-rc.3.tgz',
        integrity: 'sha512-abc',
        shasum: '503dbd88f4be3d7fd4129315f7b7a0cfd74cdbf7',
      },
    },
  },
};

test('packumentUrl encodes the scope separator', () => {
  assert.equal(packumentUrl('https://r.test', '@deepseek-ai/dsh'), 'https://r.test/@deepseek-ai%2fdsh');
  assert.equal(packumentUrl('https://r.test', 'plain'), 'https://r.test/plain');
});

test('resolveRegistry prefers an explicit override', () => {
  assert.equal(resolveRegistry('https://custom.test/'), 'https://custom.test');
});

test('publishedVersions sorts ascending', () => {
  assert.deepEqual(publishedVersions(PACKUMENT), [
    '0.2.1-rc.5',
    '0.2.2-alpha.3',
    '0.2.2-rc.1',
    '0.2.2-rc.2',
    '0.2.2-rc.3',
  ]);
});

test('distTags drops non-string entries', () => {
  assert.deepEqual(distTags({ 'dist-tags': { latest: '1.0.0', broken: 7 } }), { latest: '1.0.0' });
  assert.deepEqual(distTags({}), {});
});

test('pickTargetVersion defaults to the newest build, not the latest tag', () => {
  assert.equal(pickTargetVersion(PACKUMENT), '0.2.2-rc.3');
  assert.equal(pickTargetVersion(PACKUMENT, 'newest'), '0.2.2-rc.3');
});

test('pickTargetVersion follows an explicit tag', () => {
  assert.equal(pickTargetVersion(PACKUMENT, 'latest'), '0.2.2-rc.1');
  assert.equal(pickTargetVersion(PACKUMENT, 'next'), '0.2.2-rc.3');
  assert.equal(pickTargetVersion(PACKUMENT, 'alpha'), '0.2.2-alpha.3');
});

test('pickTargetVersion accepts an exact published version', () => {
  assert.equal(pickTargetVersion(PACKUMENT, '0.2.2-rc.2'), '0.2.2-rc.2');
});

test('pickTargetVersion rejects an unknown channel with the tag list', () => {
  assert.throws(() => pickTargetVersion(PACKUMENT, 'beta'), /unknown channel "beta".*alpha/u);
});

test('distFor returns the tarball and hashes', () => {
  const dist = distFor(PACKUMENT, '0.2.2-rc.3');
  assert.equal(dist.tarball, 'https://example.test/dsh-0.2.2-rc.3.tgz');
  assert.equal(dist.integrity, 'sha512-abc');
});

test('distFor rejects an unpublished version', () => {
  assert.throws(() => distFor(PACKUMENT, '9.9.9'), /not published/u);
});

test('summarize reports that an update is available', () => {
  const summary = summarize(PACKUMENT, '0.2.2-rc.1', 'newest', 'https://r.test');
  assert.equal(summary.installedVersion, '0.2.2-rc.1');
  assert.equal(summary.newestVersion, '0.2.2-rc.3');
  assert.equal(summary.targetVersion, '0.2.2-rc.3');
  assert.equal(summary.updateAvailable, true);
  assert.equal(summary.publishedCount, 5);
});

test('summarize reports no update when already newest', () => {
  const summary = summarize(PACKUMENT, '0.2.2-rc.3', 'newest', 'https://r.test');
  assert.equal(summary.updateAvailable, false);
});

test('summarize with the latest tag sees the pinned regression', () => {
  const summary = summarize(PACKUMENT, '0.2.2-rc.1', 'latest', 'https://r.test');
  assert.equal(summary.targetVersion, '0.2.2-rc.1');
  assert.equal(summary.updateAvailable, false);
});

test('the default registry is the public one', () => {
  assert.equal(DEFAULT_REGISTRY, 'https://registry.npmjs.org');
});
