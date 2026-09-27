import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  previewHardShare,
  previewShareFor,
  nextPreviewShare,
  previewOffMs,
  PREVIEW_SHARE_PAUSED,
  PREVIEW_SHARE_LOW,
  PREVIEW_MAX_SHARE,
  PREVIEW_TARGET_PREP,
  PREVIEW_AHEAD_LOW_SEC,
  PREVIEW_AHEAD_SAFE_SEC,
} from '../src/preview-budget.js';

const on = { playing: true };
const off = { playing: false };

// --- previewHardShare: жёсткие условия ------------------------------------------

test('пауза даёт 30% независимо от подготовки', () => {
  assert.equal(previewHardShare({ prep: 0.2, ahead: 0, ...off }), PREVIEW_SHARE_PAUSED);
  assert.equal(previewHardShare({ prep: 5, ahead: 9999, ...off }), PREVIEW_SHARE_PAUSED);
});

test('при хорошей подготовке 2 минуты не требуем — лишь маленький предохранитель', () => {
  // prep >= 1.1: до безопасного порога — 0, выше — динамика.
  assert.equal(previewHardShare({ prep: 3, ahead: PREVIEW_AHEAD_SAFE_SEC - 1, ...on }), 0);
  assert.equal(previewHardShare({ prep: 3, ahead: PREVIEW_AHEAD_SAFE_SEC, ...on }), null);
  assert.equal(previewHardShare({ prep: 3, ahead: 60, ...on }), null);
});

test('при слабой подготовке (< 1.1) буфер 2 мин обязателен', () => {
  assert.equal(previewHardShare({ prep: 0.9, ahead: PREVIEW_AHEAD_LOW_SEC - 1, ...on }), 0);
  assert.equal(previewHardShare({ prep: 0.9, ahead: PREVIEW_AHEAD_LOW_SEC, ...on }), PREVIEW_SHARE_LOW);
  assert.equal(previewHardShare({ prep: 1.09, ahead: 600, ...on }), PREVIEW_SHARE_LOW);
});

test('играет, подготовка >= 1.1, запас есть — динамический режим (null)', () => {
  assert.equal(previewHardShare({ prep: 1.1, ahead: 120, ...on }), null);
  assert.equal(previewHardShare({ prep: 5, ahead: 9999, ...on }), null);
});

// --- previewShareFor ------------------------------------------------------------

test('previewShareFor отдаёт сохранённую долю в динамическом режиме', () => {
  assert.equal(previewShareFor(0.7, { prep: 5, ahead: 600, ...on }), 0.7);
});

test('previewShareFor перебивается жёсткими случаями', () => {
  assert.equal(previewShareFor(0.7, { prep: 5, ahead: 600, ...off }), PREVIEW_SHARE_PAUSED);
  assert.equal(previewShareFor(0.7, { prep: 5, ahead: 10, ...on }), 0);
  assert.equal(previewShareFor(0.7, { prep: 1, ahead: 600, ...on }), PREVIEW_SHARE_LOW);
});

// --- nextPreviewShare: динамика -------------------------------------------------

test('высокая подготовка быстро поднимает долю до максимума 0.9', () => {
  let share = 0.4;
  for (let i = 0; i < 20; i++) {
    share = nextPreviewShare(share, { prep: 5, ahead: 600, ...on });
  }
  assert.equal(share, PREVIEW_MAX_SHARE);
});

test('быстрый разгон: при prep=5 доля доходит до 0.9 за считанные тики', () => {
  let share = 0;
  let ticks = 0;
  while (share < PREVIEW_MAX_SHARE && ticks < 10) {
    share = nextPreviewShare(share, { prep: 5, ahead: 600, ...on });
    ticks++;
  }
  assert.equal(share, PREVIEW_MAX_SHARE);
  assert.ok(ticks <= 4, `слишком медленно: ${ticks} тиков`);
});

test('подготовка ниже цели опускает долю до нуля', () => {
  let share = 0.7;
  for (let i = 0; i < 20; i++) {
    share = nextPreviewShare(share, { prep: PREVIEW_TARGET_PREP - 0.3, ahead: 600, ...on });
  }
  assert.equal(share, 0);
});

test('мёртвая зона вокруг цели не меняет долю', () => {
  for (const prep of [1.45, 1.5, 1.55]) {
    assert.equal(nextPreviewShare(0.5, { prep, ahead: 600, ...on }), 0.5);
  }
});

test('nextPreviewShare возвращает жёсткие значения', () => {
  assert.equal(nextPreviewShare(0.9, { prep: 5, ahead: 600, ...off }), PREVIEW_SHARE_PAUSED);
  assert.equal(nextPreviewShare(0.9, { prep: 5, ahead: 10, ...on }), 0);
  assert.equal(nextPreviewShare(0.9, { prep: 1, ahead: 600, ...on }), PREVIEW_SHARE_LOW);
});

test('доля не выходит за границы [0, 0.9]', () => {
  assert.equal(nextPreviewShare(0.9, { prep: 99, ahead: 9999, ...on }), PREVIEW_MAX_SHARE);
  assert.equal(nextPreviewShare(0, { prep: 1.2, ahead: 600, ...on }), 0);
});

// --- previewOffMs ---------------------------------------------------------------

test('пауза подобрана так, что средняя доля on/(on+off) ≈ fraction', () => {
  // Подбираем окно так, чтобы не срабатывали пол (1500мс) и потолок (120с).
  const cases: Array<[number, number]> = [
    [0.9, 30_000],
    [0.4, 10_000],
    [0.3, 10_000],
    [0.1, 10_000],
  ];
  for (const [fraction, runMs] of cases) {
    const off = previewOffMs(fraction, runMs);
    const duty = runMs / (runMs + off);
    assert.ok(
      Math.abs(duty - fraction) < 0.02,
      `fraction=${fraction} duty=${duty.toFixed(3)} off=${off}`,
    );
  }
});

test('нулевая доля — окно закрыто навсегда', () => {
  assert.equal(previewOffMs(0, 5000), Number.POSITIVE_INFINITY);
});

test('пауза ограничена снизу и сверху', () => {
  assert.ok(previewOffMs(0.9, 1) >= 1500);
  assert.equal(previewOffMs(0.01, 1_000_000), 120_000);
});
