import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perf } from '../src/perf.js';

test('perf: aggregates basic stats', () => {
  perf.reset();
  perf.time('x', 10);
  perf.time('x', 30);
  const snap = perf.snapshot();
  assert.equal(snap['x'].count, 2);
  assert.equal(snap['x'].avgMs, 20);
  assert.equal(snap['x'].minMs, 10);
  assert.equal(snap['x'].maxMs, 30);
});

test('perf: caps the number of metric names (POST /api/perf is caller-driven)', () => {
  perf.reset();
  for (let i = 0; i < 500; i++) perf.time(`metric-${i}`, 1);
  assert.ok(Object.keys(perf.snapshot()).length <= 200);
  perf.reset();
});
