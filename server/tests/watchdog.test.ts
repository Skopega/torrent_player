import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import type { Services } from '../src/services.js';

// Проверка мидлваря живости для watchdog'а (api.ts): любой клиентский запрос к
// /api/topic/:id обновляет «последнюю активность», а внутренний ffmpeg-feed
// (?feed=1) — нет (иначе транскод поддерживал бы сам себя).
async function withServer(
  seen: number[],
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const services = {
    noteClientActivity: (id: number) => seen.push(id),
    thumbnails: { coverage: () => 0, total: () => null },
  } as unknown as Services;
  const app = express();
  app.use('/api', createApi(services));
  const server = app.listen(0);
  await new Promise<void>((res) => server.once('listening', res));
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
}

test('watchdog: client request to a topic bumps activity', async () => {
  const seen: number[] = [];
  await withServer(seen, async (base) => {
    const res = await fetch(`${base}/api/topic/9/stream/2/thumbnails/meta`);
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [9]);
  });
});

test('watchdog: ffmpeg feed (?feed=1) does not bump activity', async () => {
  const seen: number[] = [];
  await withServer(seen, async (base) => {
    const res = await fetch(`${base}/api/topic/9/stream/2/thumbnails/meta?feed=1`);
    assert.equal(res.status, 200);
    assert.deepEqual(seen, []);
  });
});
