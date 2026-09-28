import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  SafeFSChunkStore,
  sanitizeTorrentName,
  sanitizeTorrentPath,
} from '../src/torrent-store.js';

const ROOT = path.join(os.tmpdir(), 'tp-torrent-store-test');

test('sanitizeTorrentPath: strips traversal and absolute components', () => {
  assert.equal(sanitizeTorrentPath('../../etc/passwd'), 'etc/passwd');
  assert.equal(sanitizeTorrentPath('..\\..\\x'), 'x');
  assert.equal(sanitizeTorrentPath('a/b/../c'), 'a/b/c');
  assert.equal(sanitizeTorrentPath('/abs/root'), 'abs/root');
  assert.equal(sanitizeTorrentPath('\u0000..\u0000'), '_.._');
});

test('sanitizeTorrentPath: neutralizes windows drive/colon and reserved chars', () => {
  const p = sanitizeTorrentPath('C:\\Windows\\System32\\evil');
  assert.ok(!p.includes(':'), p);
  assert.ok(!p.includes('..'), p);
  assert.equal(p, 'C_/Windows/System32/evil');
});

test('sanitizeTorrentName: collapses separators to a single component', () => {
  assert.equal(sanitizeTorrentName('a/b'), 'a_b');
  assert.equal(sanitizeTorrentName('../../../../evil'), 'evil');
  assert.equal(sanitizeTorrentName('..'), 'torrent');
  assert.equal(sanitizeTorrentName(''), 'torrent');
});

test('SafeFSChunkStore: keeps every resolved path inside the store root', () => {
  const store = new SafeFSChunkStore(16384, {
    path: ROOT,
    name: '../../../../evil',
    addUID: true,
    files: [
      { path: '../../../../etc/passwd', length: 10, offset: 0 },
      { path: 'sub/../ok.bin', length: 20, offset: 10 },
    ],
  });

  const root = path.resolve(ROOT);
  for (const file of store.files) {
    assert.ok(
      file.path === root || file.path.startsWith(root + path.sep),
      `escaped root: ${file.path}`,
    );
    assert.ok(!file.path.includes('..'), file.path);
  }
  assert.equal(store.files.length, 2);
});

test('SafeFSChunkStore: preserves legitimate subdirectory structure', () => {
  const store = new SafeFSChunkStore(16384, {
    path: ROOT,
    name: 'Movie',
    addUID: true,
    files: [{ path: 'Season 1/ep1.mkv', length: 5, offset: 0 }],
  });
  assert.equal(store.files[0].path, path.join(ROOT, 'Movie', 'Season 1', 'ep1.mkv'));
});
