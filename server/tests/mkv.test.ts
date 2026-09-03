import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  MkvIndex,
  parseCluster,
  parseElement,
  blocksToCues,
  formatWindowVtt,
  readVint,
  findSegment,
  clusterByteForTime,
  type SubtitleCue,
} from '../src/mkv.js';

const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static') as string | null;

const SRT = `1
00:00:00,500 --> 00:00:03,000
SRT первая строка

2
00:00:04,000 --> 00:00:06,500
SRT вторая строка

3
00:00:07,000 --> 00:00:10,000
SRT третья строка
`;

const ASS = `[Script Info]
Title: test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,ASS первая строка
Dialogue: 0,0:00:04.00,0:00:06.50,Default,,0,0,0,,ASS вторая строка {\\an8}
Dialogue: 0,0:00:07.00,0:00:10.00,Default,,0,0,0,,Третья \\Nстрока
`;

function buildMkv(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkvtest-'));
  const srt = path.join(dir, 't.srt');
  const ass = path.join(dir, 't.ass');
  const mkv = path.join(dir, 't.mkv');
  fs.writeFileSync(srt, SRT, 'utf8');
  fs.writeFileSync(ass, ASS, 'utf8');
  assert.ok(ffmpegPath, 'ffmpeg-static должен быть установлен');
  const r = spawnSync(
    ffmpegPath!,
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=15:size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=15',
      '-i', srt,
      '-i', ass,
      '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac',
      '-c:s:0', 'srt', '-metadata:s:s:0', 'language=rus',
      '-c:s:1', 'ass', '-metadata:s:s:1', 'language=eng',
      mkv,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `ffmpeg mux failed: ${r.stderr}`);
  return mkv;
}

function readRangeFor(file: string) {
  return async (start: number, end: number): Promise<Buffer | null> => {
    const size = fs.statSync(file).size;
    const s = Math.max(0, start);
    const e = Math.min(size, end);
    if (e <= s) return null;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(e - s);
    try {
      fs.readSync(fd, buf, 0, buf.length, s);
    } finally {
      fs.closeSync(fd);
    }
    return buf;
  };
}

test('MkvIndex парсит Tracks (SRT+ASS) и Cues', async () => {
  const mkv = buildMkv();
  const size = fs.statSync(mkv).size;
  const index = await MkvIndex.load(readRangeFor(mkv), size);
  assert.equal(index.subtitleTracks.length, 2, 'ожидается 2 субтитрные дорожки');
  assert.ok(/s_text\/utf8/i.test(index.subtitleTracks[0].codec ?? ''), `codec0=${index.subtitleTracks[0].codec}`);
  assert.ok(/s_text\/ass/i.test(index.subtitleTracks[1].codec ?? ''), `codec1=${index.subtitleTracks[1].codec}`);
  assert.equal(index.subtitleTracks[0].language, 'rus');
  assert.equal(index.subtitleTracks[1].language, 'eng');
  assert.ok(index.cues.length > 0, `cues=${index.cues.length}`);
});

test('parseCluster извлекает SRT-куи с абсолютными таймингами', async () => {
  const mkv = buildMkv();
  const size = fs.statSync(mkv).size;
  const index = await MkvIndex.load(readRangeFor(mkv), size);
  const track = index.subtitleTracks[0]; // SRT
  const cues = await collectAllCues(mkv, index, track.trackNumber, track.codec);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, 'SRT первая строка');
  assert.ok(Math.abs(cues[0].start - 0.5) < 0.2, `start=${cues[0].start}`);
  assert.ok(cues[0].end > cues[0].start);
});

test('ASS-куи: встроенные тайминги, чистый текст', async () => {
  const mkv = buildMkv();
  const size = fs.statSync(mkv).size;
  const index = await MkvIndex.load(readRangeFor(mkv), size);
  const track = index.subtitleTracks[1]; // ASS
  const cues = await collectAllCues(mkv, index, track.trackNumber, track.codec);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, 'ASS первая строка');
  assert.ok(Math.abs(cues[0].start - 1.0) < 0.2, `start=${cues[0].start}`);
  assert.ok(Math.abs(cues[0].end - 3.0) < 0.2, `end=${cues[0].end}`);
  assert.ok(!cues[1].text.includes('{\\an8}'), `text=${cues[1].text}`);
  assert.ok(cues[2].text.includes('\n'), `\\N должен стать переносом: ${JSON.stringify(cues[2].text)}`);
});

test('formatWindowVtt фильтрует и сдвигает окно', async () => {
  const mkv = buildMkv();
  const size = fs.statSync(mkv).size;
  const index = await MkvIndex.load(readRangeFor(mkv), size);
  const track = index.subtitleTracks[0];
  const cues = await collectAllCues(mkv, index, track.trackNumber, track.codec);
  const vtt = formatWindowVtt(cues, 4, 6, 4); // окно [4,10], сдвиг -4
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(!vtt.includes('SRT первая строка')); // до окна
  assert.ok(vtt.includes('SRT вторая строка'));
  assert.ok(vtt.includes('SRT третья строка'));
  const m = /-->\s*([\d:.]+)/.exec(vtt);
  assert.ok(m, `тайминг не найден: ${vtt}`);
});

async function collectAllCues(
  mkv: string,
  index: MkvIndex,
  trackNumber: number,
  codec: string | null,
): Promise<SubtitleCue[]> {
  const blocks = [];
  const seen = new Set<number>();
  for (const cue of index.cues) {
    if (seen.has(cue.clusterPos)) continue;
    seen.add(cue.clusterPos);
    const abs = index.segmentDataPos + cue.clusterPos;
    const header = await readRangeFor(mkv)(abs, abs + 12);
    assert.ok(header);
    const el = parseElement(header!, 0);
    assert.ok(el.ok && el.size > 0);
    const buf = await readRangeFor(mkv)(abs, abs + el.size);
    assert.ok(buf);
    const el2 = parseElement(buf!, 0);
    blocks.push(...parseCluster(buf!.subarray(el2.dataPos), trackNumber));
  }
  return blocksToCues(blocks, codec);
}

test('readVint не обрезает значения > 2^32 (8-байтовый vint)', () => {
  // Размер Segment 17.5 ГБ из реального файла: 0x000004181516B9 = 17583904441.
  const buf = Buffer.from([0x01, 0x00, 0x00, 0x04, 0x18, 0x15, 0x16, 0xb9]);
  const v = readVint(buf, 0);
  assert.equal(v.size, 8);
  assert.equal(v.value, 17583904441);
});

test('findSegment читает Segment с размером > 2^32', () => {
  const content = Buffer.alloc(35, 0x42); // тело EBML-заголовка (35 байт)
  const buf = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xa3]), // EBML id + size 35
    content,
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0x00, 0x00, 0x04, 0x18, 0x15, 0x16, 0xb9]),
  ]);
  const seg = findSegment(buf);
  assert.ok(seg, 'Segment должен быть найден');
  assert.equal(seg!.segSize, 17583904441);
  assert.equal(seg!.segDataPos, 52);
});

test('clusterByteForTime выбирает кластер по времени (VBR-точный seek)', () => {
  const cues = [
    { timeMs: 0, clusterPos: 50 },
    { timeMs: 10000, clusterPos: 2000 },
    { timeMs: 20000, clusterPos: 4000 },
  ];
  const segData = 1000;
  assert.equal(clusterByteForTime(cues, segData, 5), 1050); // 5s -> cue 0
  assert.equal(clusterByteForTime(cues, segData, 9.999), 1050); // до границы -> cue 0
  assert.equal(clusterByteForTime(cues, segData, 10), 3000); // на границе -> cue 10s
  assert.equal(clusterByteForTime(cues, segData, 15), 3000); // 15s -> cue 10s
  assert.equal(clusterByteForTime(cues, segData, 99), 5000); // за концом -> последний
  assert.equal(clusterByteForTime(cues, segData, 0), 1050); // с самого начала
  assert.equal(clusterByteForTime([], segData, 5), null); // нет Cues
});
