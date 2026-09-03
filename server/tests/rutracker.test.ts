import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';
import { parseSearch } from '../src/rutracker.js';
import { parseTopic } from '../src/rutracker.js';
import { parseResolution, parseBitrate, resolutionFromDimensions } from '../src/rutracker.js';

function readCp1251(name: string): string {
  const p = path.join(process.cwd(), 'tests', 'fixtures', name);
  return iconv.decode(fs.readFileSync(p), 'win1251');
}

test('parseSearch extracts rows with ids and titles', () => {
  const html = readCp1251('search.html');
  const results = parseSearch(html);

  assert.ok(results.length >= 20, `expected many rows, got ${results.length}`);

  const first = results[0];
  assert.ok(first.id > 0, 'id should be positive');
  assert.ok(first.title.length > 10, 'title should be non-trivial');
  assert.ok(first.seeds >= 0, 'seeds should be a number');
  assert.ok(first.leech >= 0, 'leech should be a number');
  assert.ok(first.size > 0, 'size bytes should be positive');
  assert.ok(first.sizeHuman.length > 0, 'sizeHuman should be present');
});

test('parseSearch truncates title to main name (no brackets) and keeps resolution', () => {
  const html = readCp1251('search.html');
  const results = parseSearch(html);
  const hasRes = results.some((r) => r.resolution !== null);
  assert.ok(hasRes, 'some results should have a resolution');
  const withBrackets = results.some((r) => r.title.includes('[') || r.title.includes('('));
  assert.ok(!withBrackets, 'titles should not contain metadata brackets');
  const nonEmpty = results.every((r) => r.title.trim().length > 0);
  assert.ok(nonEmpty, 'titles should be non-empty');
});

test('parseTopic extracts title, poster, fields, stats', () => {
  const html = readCp1251('topic.html');
  const topic = parseTopic(html, 6883079);

  assert.equal(topic.id, 6883079);
  assert.ok(topic.title.includes('Backrooms'), `title: ${topic.title}`);
  assert.ok(topic.poster, 'poster should be resolved');
  assert.ok(topic.seeds > 0, 'seeds > 0');
  assert.ok(topic.leech >= 0, 'leech >= 0');
  assert.ok(topic.sizeBytes > 0, 'size > 0');

  const keys = topic.fields.map((f) => f.key);
  assert.ok(keys.includes('Страна'), `fields should include Страна, got ${keys.join(', ')}`);
  assert.ok(topic.description.length > 0, 'description should be present');
});

test('parseTopic fields have non-empty values', () => {
  const html = readCp1251('topic.html');
  const topic = parseTopic(html, 6883079);
  for (const f of topic.fields) {
    assert.ok(f.value.length > 0, `field "${f.key}" should have a value`);
  }
});

test('parseTopic extracts poster from <var class="postImg postImgAligned"> title attr', () => {
  const html = [
    '<html><body>',
    '<h1 class="maintitle"><a id="topic-title">T</a></h1>',
    '<div class="post_body">',
    '<var class="postImg postImgAligned img-right" title="https://i125.fastpic.org/big/2025/0908/13/x.jpg">',
    '</div>',
    '</body></html>',
  ].join('');
  const topic = parseTopic(html, 1);
  assert.equal(topic.poster, 'https://i125.fastpic.org/big/2025/0908/13/x.jpg');
});

test('parseTopic skips rank badge and picks img-right poster', () => {
  const html = [
    '<html><body>',
    '<h1 class="maintitle"><a id="topic-title">T</a></h1>',
    '<div class="post_body">',
    '<img class="postImg postImgAligned img-right" alt="pic" src="http://static.rutracker.cc/ranks/rg_mult.gif">',
    '<img class="postImg postImgAligned img-right" alt="pic" src="https://linko-man.narod.ru/rutracker/images/duck_tales/duck_tales_dvd.png">',
    '</div>',
    '</body></html>',
  ].join('');
  const topic = parseTopic(html, 1);
  assert.equal(
    topic.poster,
    'https://linko-man.narod.ru/rutracker/images/duck_tales/duck_tales_dvd.png',
  );
});

test('parseTopic skips smiley placeholder and picks real image', () => {
  const html = [
    '<html><body>',
    '<h1 class="maintitle"><a id="topic-title">T</a></h1>',
    '<div class="post_body">',
    '<a href="/go/2"><img src="https://static.rutracker.cc/smiles/tr_oops.gif" class="postImg postImgAligned img-right" alt="!"></a>',
    '<div class="sp-body"><var class="postImg" title="http://i31.tinypic.com/kej3x2.jpg"></var></div>',
    '</div>',
    '</body></html>',
  ].join('');
  const topic = parseTopic(html, 1);
  assert.equal(topic.poster, 'http://i31.tinypic.com/kej3x2.jpg');
});

test('parseResolution maps explicit and rip-type tags', () => {
  assert.equal(parseResolution('Фильм [2025, США, BDRemux 1080p]'), '1080p');
  assert.equal(parseResolution('Фильм [2025, США, WEB-DL 2160p, HDR10]'), '4K');
  assert.equal(parseResolution('Фильм [2025, США, WEB-DLRip 720p]'), '720p');
  // без явного разрешения rip-тип НЕ угадываем
  assert.equal(parseResolution('Фильм [2025, США, BDRip]'), null);
  assert.equal(parseResolution('Фильм [2025, США, HDRip]'), null);
  assert.equal(parseResolution('Фильм [2025, США, WEB-DLRip]'), null);
  assert.equal(parseResolution('Фильм [2025, США, DVDRip]'), '480p');
  assert.equal(parseResolution('Фильм [2025, США, WEB-DL 1080p]'), '1080p');
  assert.equal(parseResolution('Фильм [2025, США, 4K UHD]'), '4K');
  assert.equal(parseResolution('Игра [Portable]'), null);
});

test('resolutionFromDimensions maps frame sizes', () => {
  assert.equal(resolutionFromDimensions('x264, 852x480, 23.976 fps'), '480p');
  assert.equal(resolutionFromDimensions('AVC, 1920x1080'), '1080p');
  assert.equal(resolutionFromDimensions('HEVC, 3840x2160'), '4K');
  assert.equal(resolutionFromDimensions('XviD, 704x384'), '360p');
  assert.equal(resolutionFromDimensions('нет размеров'), null);
});

test('parseBitrate extracts integer bitrate', () => {
  assert.equal(parseBitrate('MPEG-4 AVC, 2291 Kbps, 1024x554, 23.976 fps'), '2 Mbps');
  assert.equal(parseBitrate('AVC, 45.6 Mbps, 3840x2160'), '46 Mbps');
  assert.equal(parseBitrate('HEVC, 5000 Kbps'), '5 Mbps');
  assert.equal(parseBitrate('AVC, 448 Kbps'), '448 Kbps');
  assert.equal(parseBitrate('AVC (x264), 1920x1080, ≈10 500 кбит/с, 23.976 к/с, 10 бит'), '11 Mbps');
  assert.equal(parseBitrate('x264, 6000 kb/s'), '6 Mbps');
  assert.equal(parseBitrate('XviD, 4 417 кбит/с'), '4 Mbps');
  assert.equal(parseBitrate('нет битрейта тут'), null);
});
