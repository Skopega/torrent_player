import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TorrentScheduler } from '../src/scheduler.js';
import type { Torrent } from 'webtorrent';

interface Call {
  op: 'select' | 'deselect';
  from: number;
  to: number;
  priority?: number;
}

function fakeTorrent(pieceCount: number) {
  const calls: Call[] = [];
  return {
    pieces: new Array(pieceCount).fill(null),
    calls,
    select(from: number, to: number, priority?: number) {
      calls.push({ op: 'select', from, to, priority });
    },
    deselect(from: number, to: number) {
      calls.push({ op: 'deselect', from, to });
    },
  };
}

function schedulerOf(t: ReturnType<typeof fakeTorrent>) {
  return new TorrentScheduler(t as unknown as Torrent);
}

test('raise + commit issues a single select', () => {
  const t = fakeTorrent(10);
  const s = schedulerOf(t);
  s.raise(0, 4, 80);
  s.commit();
  assert.deepEqual(t.calls, [{ op: 'select', from: 0, to: 4, priority: 80 }]);
});

test('commit is a no-op when nothing changed', () => {
  const t = fakeTorrent(10);
  const s = schedulerOf(t);
  s.raise(0, 4, 80);
  s.commit();
  t.calls.length = 0;
  s.commit();
  assert.deepEqual(t.calls, []);
});

test('overlapping raise keeps the max priority per piece', () => {
  const t = fakeTorrent(10);
  const s = schedulerOf(t);
  s.raise(0, 4, 50);
  s.raise(2, 6, 80);
  s.commit();
  assert.deepEqual(t.calls, [
    { op: 'select', from: 0, to: 1, priority: 50 },
    { op: 'select', from: 2, to: 6, priority: 80 },
  ]);
});

test('release subtracts a range via deselect', () => {
  const t = fakeTorrent(10);
  const s = schedulerOf(t);
  s.raise(0, 1, 50);
  s.raise(2, 6, 80);
  s.commit();
  t.calls.length = 0;
  s.release(2, 3);
  s.commit();
  assert.deepEqual(t.calls, [{ op: 'deselect', from: 2, to: 3 }]);
});

test('lowering priority deselects old and selects new', () => {
  const t = fakeTorrent(10);
  const s = schedulerOf(t);
  s.raise(0, 1, 50);
  s.raise(2, 6, 80);
  s.commit();
  t.calls.length = 0;
  s.set(2, 6, 50);
  s.commit();
  assert.deepEqual(t.calls, [
    { op: 'deselect', from: 2, to: 6 },
    { op: 'select', from: 2, to: 6, priority: 50 },
  ]);
});

test('clear releases everything selected', () => {
  const t = fakeTorrent(10);
  const s = schedulerOf(t);
  s.raise(0, 1, 50);
  s.raise(2, 6, 80);
  s.commit();
  t.calls.length = 0;
  s.clear();
  s.commit();
  assert.deepEqual(t.calls, [{ op: 'deselect', from: 0, to: 6 }]);
});

test('raising the middle of a range only touches that sub-range', () => {
  const t = fakeTorrent(10);
  const s = schedulerOf(t);
  s.set(0, 9, 50);
  s.commit();
  t.calls.length = 0;
  s.raise(4, 5, 90);
  s.commit();
  assert.deepEqual(t.calls, [
    { op: 'deselect', from: 4, to: 5 },
    { op: 'select', from: 4, to: 5, priority: 90 },
  ]);
});

test('commit produces no select for a fully released window', () => {
  const t = fakeTorrent(10);
  const s = schedulerOf(t);
  s.set(2, 5, 50);
  s.commit();
  t.calls.length = 0;
  s.release(2, 5);
  s.commit();
  assert.deepEqual(t.calls, [{ op: 'deselect', from: 2, to: 5 }]);
});

test('releaseAt clears only matching priorities, keeps higher SEEK', () => {
  const t = fakeTorrent(10);
  const s = schedulerOf(t);
  s.set(0, 9, 50); // BUFFER-фон
  s.set(2, 3, 80); // PLAYBACK
  s.set(4, 5, 90); // SEEK (выше)
  s.commit();
  t.calls.length = 0;
  // Снимаем только PLAYBACK/BUFFER — SEEK (90) должен остаться нетронутым.
  s.releaseAt(0, 9, [80, 50]);
  s.commit();
  assert.deepEqual(t.calls, [
    { op: 'deselect', from: 0, to: 3 },
    { op: 'deselect', from: 6, to: 9 },
  ]);
});
