// Общие константы клиента, повторяющие серверные. Собраны в одном месте, чтобы не
// рассыпать «магию» по компонентам. ВАЖНО: при изменении синхронизировать с сервером:
//   - THUMB_INTERVAL_SEC / THUMB_NEAREST_WINDOW_SLOTS ↔ server/src/thumbnails.ts
//   - HLS_SEGMENT_SECONDS ↔ server/src/hls.ts (SEGMENT_SECONDS)
//   - RES_OPTIONS / QUALITY_OPTIONS / DEFAULT_QUALITY ↔ server/src/quality.ts

// Интервал превью (совпадает с THUMB_INTERVAL_SEC на сервере).
export const THUMB_INTERVAL_SEC = 10;
// Окно «ближайшего» превью в слотах (±30 слотов при шаге 10с = ±5 минут).
export const THUMB_NEAREST_WINDOW_SLOTS = 30;

// Длина HLS-сегмента: позиция сессии округляется до границы сегмента, чтобы кеш
// сегментов попадал при близких перемотках.
export const HLS_SEGMENT_SECONDS = 2;
export const roundStart = (t: number): number =>
  Math.max(0, Math.floor(t / HLS_SEGMENT_SECONDS) * HLS_SEGMENT_SECONDS);

// Доступные потолки разрешения транскода (по убыванию).
export const RES_OPTIONS = [2160, 1440, 1080, 720, 480, 360];

// Ступени качества транскода (0 — максимум). Должны совпадать с server/src/quality.ts.
export const QUALITY_OPTIONS = [
  'Max · QP 12',
  'Very high · QP 16',
  'High · QP 18',
  'Raised · QP 20',
  'Standard · QP 23',
  'Economy · QP 27',
  'Minimum · QP 31',
] as const;
export const DEFAULT_QUALITY = 1;
