import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHlsDir, parseThumbDir, matchesKeep } from '../src/cache-dirs.js';

test('parseHlsDir parses topicId and fileIndex', () => {
  assert.deepEqual(parseHlsDir('6829503_0_11_2406_2160'), { topicId: 6829503, fileIndex: 0 });
  assert.deepEqual(parseHlsDir('5389600_0_1_0_1080'), { topicId: 5389600, fileIndex: 0 });
  assert.deepEqual(parseHlsDir('5067493_12_2_100_720'), { topicId: 5067493, fileIndex: 12 });
  assert.deepEqual(parseHlsDir('1_0_def_0_full'), { topicId: 1, fileIndex: 0 });
});

test('parseHlsDir rejects junk and malformed names', () => {
  assert.equal(parseHlsDir(''), null);
  assert.equal(parseHlsDir('onlyone'), null);
  assert.equal(parseHlsDir('abc_def'), null);
  assert.equal(parseHlsDir('1'), null);
  assert.equal(parseHlsDir('1.5_2'), null);
  assert.equal(parseHlsDir('..'), null);
});

test('parseThumbDir parses topicId and fileIndex', () => {
  assert.deepEqual(parseThumbDir('4301725_52'), { topicId: 4301725, fileIndex: 52 });
  assert.deepEqual(parseThumbDir('6829503_0'), { topicId: 6829503, fileIndex: 0 });
});

test('parseThumbDir rejects junk', () => {
  assert.equal(parseThumbDir(''), null);
  assert.equal(parseThumbDir('abc'), null);
  assert.equal(parseThumbDir('1'), null);
  assert.equal(parseThumbDir('a_b'), null);
});

test('matchesKeep keeps only the requested topic (keepFileIndex null)', () => {
  const ref = { topicId: 5, fileIndex: 2 };
  assert.equal(matchesKeep(ref, 5, null), true);
  assert.equal(matchesKeep({ topicId: 6, fileIndex: 2 }, 5, null), false);
  assert.equal(matchesKeep({ topicId: 5, fileIndex: 9 }, 5, null), true);
});

test('matchesKeep with a concrete file keeps only that file of the topic', () => {
  assert.equal(matchesKeep({ topicId: 5, fileIndex: 2 }, 5, 2), true);
  assert.equal(matchesKeep({ topicId: 5, fileIndex: 3 }, 5, 2), false);
  assert.equal(matchesKeep({ topicId: 6, fileIndex: 2 }, 5, 2), false);
});
