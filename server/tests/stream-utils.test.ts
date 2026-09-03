import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWebVttCueSetting,
  canDirectPlay,
  compareEpisodes,
  episodeOf,
  extOf,
  isTextSubtitleCodec,
  isVideoFile,
  lastWebVttEnd,
  mimeFor,
  parseRangeHeader,
  pieceRange,
  shiftWebVttTimestamps,
  windowWebVtt,
} from '../src/stream-utils.js';

test('parseRangeHeader: no header -> none', () => {
  assert.deepEqual(parseRangeHeader(undefined, 1000), { kind: 'none' });
});

test('parseRangeHeader: open-ended ranges', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-', 1000), { kind: 'partial', start: 0, end: 999 });
  assert.deepEqual(parseRangeHeader('bytes=500-', 1000), { kind: 'partial', start: 500, end: 999 });
});

test('parseRangeHeader: bounded ranges', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-499', 1000), { kind: 'partial', start: 0, end: 499 });
  assert.deepEqual(parseRangeHeader('bytes=100-199', 1000), { kind: 'partial', start: 100, end: 199 });
});

test('parseRangeHeader: suffix range', () => {
  assert.deepEqual(parseRangeHeader('bytes=-100', 1000), { kind: 'partial', start: 900, end: 999 });
});

test('parseRangeHeader: clamps end to size', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-100000', 1000), { kind: 'partial', start: 0, end: 999 });
});

test('parseRangeHeader: invalid ranges', () => {
  assert.equal(parseRangeHeader('bytes=abc', 1000).kind, 'invalid');
  assert.equal(parseRangeHeader('bytes=1000-', 1000).kind, 'invalid');
  assert.equal(parseRangeHeader('bytes=500-400', 1000).kind, 'invalid');
  assert.equal(parseRangeHeader('bytes=-0', 1000).kind, 'invalid');
});

test('parseRangeHeader: takes first of multiple ranges', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-99,200-299', 1000), {
    kind: 'partial',
    start: 0,
    end: 99,
  });
});

test('parseRangeHeader: empty file', () => {
  assert.deepEqual(parseRangeHeader(undefined, 0), { kind: 'none' });
  assert.equal(parseRangeHeader('bytes=0-', 0).kind, 'invalid');
});

test('extOf lowercases and handles missing ext', () => {
  assert.equal(extOf('Movie.MKV'), '.mkv');
  assert.equal(extOf('noext'), '');
  assert.equal(extOf('a.b.mp4'), '.mp4');
});

test('mimeFor maps known video extensions', () => {
  assert.equal(mimeFor('a.mp4'), 'video/mp4');
  assert.equal(mimeFor('a.mkv'), 'video/x-matroska');
  assert.equal(mimeFor('a.webm'), 'video/webm');
  assert.equal(mimeFor('file.xyz'), 'application/octet-stream');
});

test('isVideoFile detects video by extension', () => {
  assert.ok(isVideoFile('movie.mkv'));
  assert.ok(isVideoFile('clip.MP4'));
  assert.ok(!isVideoFile('readme.txt'));
  assert.ok(!isVideoFile('sub.srt'));
});

test('pieceRange maps bytes within file to torrent pieces', () => {
  assert.deepEqual(pieceRange(0, 0, 999, 16384), { first: 0, last: 0 });
  assert.deepEqual(pieceRange(100000, 0, 999, 16384), { first: 6, last: 6 });
  assert.deepEqual(pieceRange(0, 16384, 32767, 16384), { first: 1, last: 1 });
  assert.deepEqual(pieceRange(0, 0, 16384, 16384), { first: 0, last: 1 });
});

test('canDirectPlay decides container + codec support', () => {
  assert.equal(canDirectPlay('.mp4', 'h264', 'aac'), true);
  assert.equal(canDirectPlay('.mkv', 'h264', 'aac'), false);
  assert.equal(canDirectPlay('.mp4', 'hevc', 'aac'), false);
  assert.equal(canDirectPlay('.mp4', 'h264', 'ac3'), false);
  assert.equal(canDirectPlay('.webm', 'vp9', 'opus'), true);
  assert.equal(canDirectPlay('.mp4', 'h264', null), true);
});

test('episodeOf recognizes SxxExx / 1x02 / серия N patterns', () => {
  assert.deepEqual(episodeOf('Show.S01E02.mkv'), { season: 1, episode: 2 });
  assert.deepEqual(episodeOf('Show.S1E10.mkv'), { season: 1, episode: 10 });
  assert.deepEqual(episodeOf('Show.1x02.mkv'), { season: 1, episode: 2 });
  assert.deepEqual(episodeOf('Show.1X10.mkv'), { season: 1, episode: 10 });
  assert.deepEqual(episodeOf('Сериал серия 03.mkv'), { season: 1, episode: 3 });
  assert.deepEqual(episodeOf('Сезон 2 серия 05.mkv'), { season: 2, episode: 5 });
  assert.equal(episodeOf('movie.1080p.mkv'), null);
  assert.equal(episodeOf('movie.1920x1080.mkv'), null);
});

test('compareEpisodes orders by season then episode', () => {
  const names = ['S02E10', 'S01E02', 'S02E02', 'S01E10', 'S01E01'];
  assert.deepEqual([...names].sort(compareEpisodes), [
    'S01E01',
    'S01E02',
    'S01E10',
    'S02E02',
    'S02E10',
  ]);
});

test('compareEpisodes handles zero-padded and plain numbers naturally', () => {
  const names = ['серия 10', 'серия 2', 'серия 21', 'серия 1'];
  assert.deepEqual([...names].sort(compareEpisodes), [
    'серия 1',
    'серия 2',
    'серия 10',
    'серия 21',
  ]);
});

test('compareEpisodes naturally orders bare episode numbers', () => {
  const names = ['10.mkv', '2.mkv', '21.mkv', '1.mkv', '34.mkv'];
  assert.deepEqual([...names].sort(compareEpisodes), [
    '1.mkv',
    '2.mkv',
    '10.mkv',
    '21.mkv',
    '34.mkv',
  ]);
});

test('isTextSubtitleCodec distinguishes text from image subtitles', () => {
  assert.equal(isTextSubtitleCodec('subrip'), true);
  assert.equal(isTextSubtitleCodec('ass'), true);
  assert.equal(isTextSubtitleCodec('SSA'), true);
  assert.equal(isTextSubtitleCodec('webvtt'), true);
  assert.equal(isTextSubtitleCodec('mov_text'), true);
  assert.equal(isTextSubtitleCodec('hdmv_pgs_subtitle'), false);
  assert.equal(isTextSubtitleCodec('dvd_subtitle'), false);
  assert.equal(isTextSubtitleCodec(null), false);
});

test('applyWebVttCueSetting appends cue setting only to timing lines', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:04.000',
    '<v Голос>Текст</v>',
    '',
    '00:00:05.000 --> 00:00:08.000',
    'Вторая строка',
    '',
  ].join('\n');
  const out = applyWebVttCueSetting(vtt, 'line:-2');
  const lines = out.split('\n');
  assert.equal(lines[0], 'WEBVTT');
  assert.equal(lines[2], '00:00:01.000 --> 00:00:04.000 line:-2');
  assert.equal(lines[3], '<v Голос>Текст</v>');
  assert.equal(lines[5], '00:00:05.000 --> 00:00:08.000 line:-2');
});

test('shiftWebVttTimestamps subtracts offset and drops cues before it', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:04.000',
    'Ранняя',
    '',
    '00:00:05.000 --> 00:00:08.000',
    'Позже',
    '',
    '00:00:10.000 --> 00:00:20.000',
    'Поздняя',
  ].join('\n');
  const out = shiftWebVttTimestamps(vtt, 6);
  const blocks = out.split('\n\n');
  assert.equal(blocks[0], 'WEBVTT');
  assert.equal(blocks[1], '00:00:00.000 --> 00:00:02.000\nПозже');
  assert.equal(blocks[2], '00:00:04.000 --> 00:00:14.000\nПоздняя');
});

test('shiftWebVttTimestamps preserves trailing cue settings', () => {
  const vtt = 'WEBVTT\n\n00:00:10.000 --> 00:00:20.000 line:-2\nТекст\n';
  const out = shiftWebVttTimestamps(vtt, 5);
  assert.ok(out.includes('00:00:05.000 --> 00:00:15.000 line:-2'));
});

test('shiftWebVttTimestamps no-op for zero offset', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nТекст\n';
  assert.equal(shiftWebVttTimestamps(vtt, 0), vtt);
});

test('shiftWebVttTimestamps handles MM:SS.mmm (short ffmpeg form)', () => {
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:03.000\nРанняя\n\n00:05.000 --> 00:08.000\nПозже\n';
  const out = shiftWebVttTimestamps(vtt, 4);
  assert.ok(!out.includes('Ранняя'));
  assert.ok(out.includes('00:00:01.000 --> 00:00:04.000\nПозже'));
});

test('lastWebVttEnd returns max cue end in absolute seconds', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nA\n\n00:00:05.000 --> 00:00:08.000\nB\n';
  assert.equal(lastWebVttEnd(vtt), 8);
  assert.equal(lastWebVttEnd('WEBVTT\n'), 0);
});

test('windowWebVtt keeps only cues overlapping [t, t+dur] and shifts them', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:04.000',
    'Ранняя',
    '',
    '00:00:05.000 --> 00:00:08.000',
    'В окне',
    '',
    '00:00:10.000 --> 00:00:20.000',
    'Поздняя',
  ].join('\n');
  const { vtt: out, coverage } = windowWebVtt(vtt, 4, 5, 3);
  assert.ok(out.includes('В окне'));
  assert.ok(!out.includes('Ранняя'));
  assert.ok(!out.includes('Поздняя'));
  assert.ok(out.includes('00:00:02.000 --> 00:00:05.000'));
  assert.equal(coverage, 20);
});

test('windowWebVtt keeps cues crossing the window start', () => {
  const vtt = 'WEBVTT\n\n00:00:03.000 --> 00:00:07.000\nДлинная\n';
  const { vtt: out } = windowWebVtt(vtt, 5, 10, 0);
  assert.ok(out.includes('Длинная'));
});

test('windowWebVtt drops cues fully after the window', () => {
  const vtt = 'WEBVTT\n\n00:00:20.000 --> 00:00:25.000\nПосле\n';
  const { vtt: out } = windowWebVtt(vtt, 0, 10, 0);
  assert.ok(!out.includes('После'));
});
