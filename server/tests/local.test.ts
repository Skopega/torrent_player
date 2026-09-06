import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import parseTorrent, { toTorrentFile } from 'parse-torrent';

// LocalLibrary (и Store) берут DATA_DIR из TP_DATA_DIR в момент импорта — создаём
// изолированный каталог до динамического import.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tp-local-test-'));
process.env.TP_DATA_DIR = tmp;
const { LocalLibrary } = await import('../src/local.js');
const { Store } = await import('../src/store.js');

after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const VALID_MAGNET =
  'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Some+Title&tr=udp%3A%2F%2Ftracker.example.com%3A80%2Fannounce';

function validTorrentBuf(): Buffer {
  const pieces = Buffer.alloc(20, 7);
  const info = {
    name: 'My Test Movie.mkv',
    'piece length': 16384,
    length: 16384,
    pieces,
  };
  return Buffer.from(toTorrentFile({ info, announce: ['udp://tracker.example.com:80/announce'] }));
}

function fresh(): LocalLibrary {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  return new LocalLibrary();
}

test('local: magnet round-trip with negative id and persistence', async () => {
  const lib = fresh();
  const meta = await lib.addMagnet(VALID_MAGNET);
  assert.ok(meta.id < 0);
  assert.equal(meta.kind, 'magnet');
  assert.equal(lib.getByTopicId(meta.id)?.id, meta.id);
  assert.equal(lib.get(meta.id)?.name, meta.name);

  // Переживает пересоздание (диск).
  const lib2 = new LocalLibrary();
  const persisted = lib2.getByTopicId(meta.id);
  assert.ok(persisted);
  assert.equal(persisted.magnet, VALID_MAGNET);
});

test('local: invalid magnet rejected', async () => {
  const lib = fresh();
  await assert.rejects(() => lib.addMagnet('magnet:?xt=urn:ed2k:whatever'), /bad_magnet/);
  await assert.rejects(() => lib.addMagnet('not a magnet'), /bad_magnet/);
  await assert.rejects(() => lib.addMagnet(''), /bad_magnet/);
});

test('local: torrent round-trip stores bytes file', async () => {
  const lib = fresh();
  const buf = validTorrentBuf();
  const meta = await lib.addTorrent(buf);
  assert.ok(meta.id < 0);
  assert.equal(meta.kind, 'torrent');
  const srcPath = lib.sourceTorrentPath(meta.id);
  assert.ok(srcPath);
  assert.equal(existsSync(srcPath!), true);
  assert.deepEqual(readFileSync(srcPath!), buf);
  // Парсится обратно как валидный торрент.
  const parsed = (await parseTorrent(readFileSync(srcPath!))) as { infoHash?: string; name?: string };
  assert.ok(parsed.infoHash);
});

test('local: rename and setBanner persist', async () => {
  const lib = fresh();
  const meta = await lib.addMagnet(VALID_MAGNET, 'first');
  assert.equal(lib.rename(meta.id, '  new name ' )?.name, 'new name');
  lib.setBanner(meta.id, true);
  const lib2 = new LocalLibrary();
  assert.equal(lib2.getByTopicId(meta.id)?.name, 'new name');
  assert.equal(lib2.getByTopicId(meta.id)?.hasBanner, true);
  assert.equal(lib2.bannerPath(meta.id), path.join(tmp, 'local', String(-meta.id), 'banner.jpg'));
});

test('local: remove deletes dir and registry', async () => {
  const lib = fresh();
  const meta = await lib.addTorrent(validTorrentBuf());
  const dir = lib.dir(meta.id);
  assert.equal(existsSync(dir), true);
  assert.equal(lib.remove(meta.id), true);
  assert.equal(lib.getByTopicId(meta.id), null);
  assert.equal(existsSync(dir), false);
  assert.equal(lib.remove(meta.id), false);
});

test('local: explicit absId is honored and advances the counter', async () => {
  const lib = fresh();
  const a = await lib.addMagnet(VALID_MAGNET, undefined, 7);
  assert.equal(a.id, -7);
  assert.equal(a.absId, 7);
  // Следующий автоматический id строго больше выданного явно.
  const b = await lib.addMagnet('magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=B');
  assert.ok(b.absId > 7);
  assert.equal(lib.getByTopicId(-7)?.id, -7);
});

test('local: sweep removes entries not in keep set', async () => {
  const lib = fresh();
  const a = await lib.addMagnet(VALID_MAGNET);
  const b = await lib.addMagnet('magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff&dn=Keep');
  const removed = lib.sweep([b.id]);
  assert.deepEqual(removed, [a.absId]);
  assert.equal(lib.getByTopicId(a.id), null);
  assert.equal(lib.getByTopicId(b.id)?.id, b.id);
});

test('local: survives full and video cache clears (data/local outside cache)', async () => {
  const lib = fresh();
  const meta = await lib.addMagnet(VALID_MAGNET);
  const store = new Store();
  store.clearCache();
  store.clearVideoCache();
  const lib2 = new LocalLibrary();
  assert.equal(lib2.getByTopicId(meta.id)?.id, meta.id);
  assert.equal(lib2.getByTopicId(meta.id)?.magnet, VALID_MAGNET);
});
