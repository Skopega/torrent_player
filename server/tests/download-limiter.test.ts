import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DownloadLimiter,
  LimiterConfig,
  quantile,
  serveStats,
  type LimiterSignals,
} from '../src/download-limiter.js';

function sig(over: Partial<LimiterSignals> = {}): LimiterSignals {
  return {
    serveMedMs: 50,
    serveMinMs: 50,
    serveCount: 5,
    observedBps: 5_000_000,
    needBps: 1_000_000,
    local: false,
    ...over,
  };
}

test('quantile/serveStats', () => {
  assert.equal(quantile([], 0.95), null);
  assert.equal(quantile([10, 20, 30, 40], 0.5), 30);
  const s = serveStats([40, 10, 30, 20]);
  assert.equal(s.count, 4);
  assert.equal(s.min, 10);
  assert.equal(s.med, 30);
});

test('serveStats: одиночный выброс не сдвигает медиану', () => {
  const s = serveStats([5, 5, 5, 5, 5, 5, 5, 5, 5, 400]);
  assert.equal(s.count, 10);
  assert.equal(s.min, 5);
  assert.equal(s.med, 5);
});

test('starts unlimited and stays unlimited without pressure', () => {
  const l = new DownloadLimiter();
  for (let i = 0; i < 10; i++) {
    const st = l.tick(sig());
    assert.equal(st.capBps, -1);
  }
});

test('local file removes the cap', () => {
  const l = new DownloadLimiter();
  const st = l.tick(sig({ local: true, observedBps: 9_000_000 }));
  assert.equal(st.capBps, -1);
  assert.equal(st.reason, 'local');
});

test('устойчивое давление медианы режет cap от фактической скорости', () => {
  const l = new DownloadLimiter();
  l.tick(sig()); // baseline ≈ 50
  const pressure = sig({ serveMedMs: 400, serveMinMs: 50, observedBps: 8_000_000 });
  assert.equal(l.tick(pressure).pressure, true);
  const st = l.tick(pressure);
  assert.equal(st.pressure, true);
  // cap = max(need*3, observed*0.5) = max(3e6, 4e6)
  assert.equal(st.capBps, 4_000_000);
});

test('одиночный выброс: медиана не считает давлением', () => {
  const l = new DownloadLimiter();
  l.tick(sig({ serveMedMs: 10, serveMinMs: 10 })); // baseline ≈ 10
  const st = serveStats([10, 10, 10, 10, 10, 10, 10, 10, 10, 400]);
  const noisy = sig({ serveMedMs: st.med, serveMinMs: st.min, serveCount: st.count });
  for (let i = 0; i < 6; i++) assert.equal(l.tick(noisy).pressure, false);
});

test('мало замеров в окне — сигнал не считается давлением', () => {
  const l = new DownloadLimiter();
  l.tick(sig());
  const few = sig({ serveMedMs: 500, serveCount: 2 });
  assert.equal(l.tick(few).pressure, false);
});

test('повторное давление не опускает cap ниже пола по битрейту', () => {
  const l = new DownloadLimiter();
  l.tick(sig());
  const pressure = sig({ serveMedMs: 400 });
  for (let i = 0; i < 40; i++) l.tick(pressure);
  assert.ok(l.state.capBps > 0);
  assert.ok(l.state.capBps >= 1_000_000 * LimiterConfig.MIN_NEED_MULTIPLE);
});

test('плавный рост (AIMD) без прыжка в unlimited при высокой сети', () => {
  const l = new DownloadLimiter();
  l.tick(sig());
  const pressure = sig({ serveMedMs: 400, observedBps: 8_000_000 });
  l.tick(pressure);
  l.tick(pressure); // cap = 4e6
  const start = l.state.capBps;
  assert.equal(start, 4_000_000);

  // Чисто, но фактическая скорость выше лимита (сеть не узкое место) — растём плавно.
  const clean = sig({ serveMedMs: 50, observedBps: 50_000_000 });
  let grew = false;
  for (let i = 0; i < 12; i++) {
    const st = l.tick(clean);
    if (st.capBps > start) grew = true;
    assert.notEqual(st.capBps, -1, 'не должно прыгать в unlimited, пока сеть выше лимита');
  }
  assert.ok(grew, 'cap должен расти аддитивно в спокойствии');
});

test('снятие лимита, когда узкое место — сеть', () => {
  const l = new DownloadLimiter();
  l.tick(sig());
  const pressure = sig({ serveMedMs: 400, observedBps: 8_000_000 });
  l.tick(pressure);
  l.tick(pressure); // cap = 4e6
  assert.ok(l.state.capBps > 0);

  const networkLimited = sig({ serveMedMs: 50, observedBps: 1_000_000 });
  for (let i = 0; i < LimiterConfig.COOLDOWN_TICKS + 3; i++) l.tick(networkLimited);
  assert.equal(l.state.capBps, -1);
});

test('reset returns to unlimited', () => {
  const l = new DownloadLimiter();
  l.tick(sig());
  const pressure = sig({ serveMedMs: 400 });
  l.tick(pressure);
  l.tick(pressure);
  assert.ok(l.state.capBps > 0);
  l.reset();
  assert.equal(l.state.capBps, -1);
});

test('сходится к устойчивой скорости, не осциллируя в unlimited', () => {
  const l = new DownloadLimiter();
  const need = 1_000_000;
  const KNEE = 12_000_000; // диск держит ~12 МБ/с
  let capped = false;
  let unlimitedAfterCap = 0;
  let pressureEvents = 0;
  for (let i = 0; i < 300; i++) {
    const cap = l.state.capBps;
    const rate = cap < 0 ? 20_000_000 : cap; // фактически качаем столько
    const lat = rate > KNEE ? 300 : 5; // выше колена — диск захлёбывается
    const obs = Math.min(rate, 30_000_000);
    if (l.state.pressure) pressureEvents++;
    const st = l.tick({ serveMedMs: lat, serveMinMs: 5, serveCount: 5, observedBps: obs, needBps: need, local: false });
    if (st.capBps > 0) capped = true;
    if (capped && st.capBps === -1) unlimitedAfterCap++;
  }
  const final = l.state.capBps;
  assert.ok(capped, 'контур должен включить cap на медленном диске');
  assert.equal(unlimitedAfterCap, 0, 'после включения cap не должен прыгать в unlimited');
  assert.ok(final > 0 && final <= KNEE + need, `cap должен держаться около колена, а не ${final}`);
});
