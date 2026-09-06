import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameOriginGuard } from '../src/csrf.js';

type Req = { method: string; headers: Record<string, string> };
type Result = { status?: number; body?: unknown } | { next: true };

function run(guard: typeof sameOriginGuard, method: string, headers: Record<string, string>): Promise<Result> {
  return new Promise((resolve) => {
    const req: Req = { method, headers };
    const res = {
      statusCode: 0,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        resolve({ status: this.statusCode, body });
      },
    };
    guard(req as never, res as never, () => resolve({ next: true }));
  });
}

test('sameOriginGuard: GET всегда разрешён', async () => {
  const r = await run(sameOriginGuard, 'GET', {});
  assert.ok('next' in r);
});

test('sameOriginGuard: POST без заголовков (curl/панель) разрешён', async () => {
  const r = await run(sameOriginGuard, 'POST', {});
  assert.ok('next' in r);
});

test('sameOriginGuard: same-origin POST разрешён', async () => {
  const r = await run(sameOriginGuard, 'POST', {
    origin: 'http://192.168.1.5:3000',
    host: '192.168.1.5:3000',
    'sec-fetch-site': 'same-origin',
  });
  assert.ok('next' in r);
});

test('sameOriginGuard: cross-site Sec-Fetch-Site отклоняется', async () => {
  const r = await run(sameOriginGuard, 'POST', {
    origin: 'https://evil.com',
    host: '192.168.1.5:3000',
    'sec-fetch-site': 'cross-site',
  });
  assert.ok('status' in r);
  assert.equal(r.status, 403);
});

test('sameOriginGuard: внешний Origin отклоняется', async () => {
  const r = await run(sameOriginGuard, 'POST', {
    origin: 'https://evil.com',
    host: '192.168.1.5:3000',
  });
  assert.ok('status' in r);
  assert.equal(r.status, 403);
});

test('sameOriginGuard: Origin=null (sandbox/data:) отклоняется', async () => {
  const r = await run(sameOriginGuard, 'POST', {
    origin: 'null',
    host: '192.168.1.5:3000',
  });
  assert.ok('status' in r);
  assert.equal(r.status, 403);
});
