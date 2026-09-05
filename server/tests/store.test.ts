import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HistoryEntry } from '../src/store.js';

// Store определяет DATA_DIR из TP_DATA_DIR в момент импорта модуля — создаём
// изолированный временный каталог до динамического import (node --test гоняет
// каждый файл в отдельном процессе, так что окружение не утекает в другие тесты).
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tp-store-test-'));
process.env.TP_DATA_DIR = tmp;
const { Store } = await import('../src/store.js');

after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// Store перечитывает файлы из DATA_DIR при конструировании — очищаем каталог,
// чтобы каждый тест был изолирован (все экземпляры пишут в один tmp).
function freshStore(): Store {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  return new Store();
}

function entry(id: number, title = `topic ${id}`): HistoryEntry {
  return {
    id,
    title,
    category: 'movies',
    poster: null,
    sizeHuman: '1 GB',
    seeds: 1,
    leech: 0,
    resolution: null,
    bitrate: null,
    duration: null,
    date: '2026-01-01',
  };
}

const NO_RESUME = {
  fileIndex: null,
  position: null,
  volume: null,
  muted: null,
  audioTrack: null,
  subtitleTrack: null,
};

const fullResume = (over: Record<string, unknown>) => ({ ...NO_RESUME, ...over });

test('history: new entry has no saved settings', () => {
  const s = freshStore();
  s.addHistory(entry(1));
  assert.deepEqual(s.getHistoryResume(1), NO_RESUME);
});

test('history: setHistoryResume persists fileIndex and position', () => {
  const s = freshStore();
  s.addHistory(entry(2));
  assert.equal(s.setHistoryResume(2, 5, 612), true);
  assert.deepEqual(s.getHistoryResume(2), fullResume({ fileIndex: 5, position: 612 }));
  assert.equal(s.getHistory()[0].lastFileIndex, 5);
});

test('history: setHistoryVolume persists volume and mute', () => {
  const s = freshStore();
  s.addHistory(entry(3));
  assert.equal(s.setHistoryVolume(3, 0.35, true), true);
  assert.deepEqual(s.getHistoryResume(3), fullResume({ volume: 0.35, muted: true }));
  assert.equal(s.getHistory()[0].volume, 0.35);
});

test('history: setHistoryTracks persists audio and subtitle streams', () => {
  const s = freshStore();
  s.addHistory(entry(4));
  assert.equal(s.setHistoryTracks(4, 2, null), true);
  assert.deepEqual(s.getHistoryResume(4), fullResume({ audioTrack: 2, subtitleTrack: null }));
  assert.equal(s.setHistoryTracks(4, 2, 5), true);
  assert.deepEqual(s.getHistoryResume(4), fullResume({ audioTrack: 2, subtitleTrack: 5 }));
  const e = s.getHistory()[0];
  assert.equal(e.audioTrack, 2);
  assert.equal(e.subtitleTrack, 5);
});

test('history: setters for missing id are a no-op', () => {
  const s = freshStore();
  s.addHistory(entry(5));
  assert.equal(s.setHistoryResume(999, 1, 10), false);
  assert.equal(s.setHistoryVolume(999, 0.5, false), false);
  assert.equal(s.setHistoryTracks(999, 1, 2), false);
  assert.equal(s.getHistory().length, 1);
  assert.deepEqual(s.getHistoryResume(999), NO_RESUME);
});

test('history: re-add keeps saved settings when entry lacks them', () => {
  const s = freshStore();
  s.addHistory(entry(6, 'before'));
  assert.equal(s.setHistoryResume(6, 7, 1200), true);
  assert.equal(s.setHistoryVolume(6, 0.6, false), true);
  assert.equal(s.setHistoryTracks(6, 2, 5), true);
  s.addHistory(entry(6, 'after'));
  const e = s.getHistory()[0];
  assert.equal(e.title, 'after');
  assert.equal(e.lastFileIndex, 7);
  assert.equal(e.lastPosition, 1200);
  assert.equal(e.volume, 0.6);
  assert.equal(e.muted, false);
  assert.equal(e.audioTrack, 2);
  assert.equal(e.subtitleTrack, 5);
  assert.deepEqual(
    s.getHistoryResume(6),
    fullResume({ fileIndex: 7, position: 1200, volume: 0.6, muted: false, audioTrack: 2, subtitleTrack: 5 }),
  );
});

test('history: removeHistory forgets all saved settings', () => {
  const s = freshStore();
  s.addHistory(entry(7));
  assert.equal(s.setHistoryResume(7, 3, 42), true);
  assert.equal(s.setHistoryVolume(7, 0.9, false), true);
  assert.equal(s.setHistoryTracks(7, 1, null), true);
  s.removeHistory(7);
  assert.deepEqual(s.getHistoryResume(7), NO_RESUME);
  // Последующее re-add не должно воскресить настройки.
  s.addHistory(entry(7));
  assert.deepEqual(s.getHistoryResume(7), NO_RESUME);
});
